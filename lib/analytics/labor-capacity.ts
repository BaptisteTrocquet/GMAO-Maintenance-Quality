import { createHash } from "node:crypto";
import type { MembershipRole } from "@prisma/client";
import { db } from "@/lib/db";

const ENTITY_TYPE = "LaborCapacityProfile";
const MAINTENANCE_ROLES: MembershipRole[] = [
  "OWNER",
  "ADMIN",
  "MAINTENANCE_MANAGER",
  "TECHNICIAN",
];

export type LaborCapacitySnapshot = {
  id: string;
  organizationId: string;
  siteId: string;
  userId: string;
  weeklyCapacityMinutes: number;
  active: boolean;
  updatedAt: string;
};

export type LaborCapacityProfile = LaborCapacitySnapshot & {
  displayName: string;
};

export class LaborCapacityError extends Error {
  constructor(
    public readonly code:
      | "INVALID_CAPACITY"
      | "SITE_NOT_FOUND"
      | "USER_NOT_ELIGIBLE"
      | "PROFILE_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "LaborCapacityError";
  }
}

function profileId(organizationId: string, siteId: string, userId: string) {
  return createHash("sha256")
    .update(`${organizationId}:${siteId}:${userId}`)
    .digest("hex");
}

function parseSnapshot(value: string | null): LaborCapacitySnapshot | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<LaborCapacitySnapshot>;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.organizationId !== "string" ||
      typeof parsed.siteId !== "string" ||
      typeof parsed.userId !== "string" ||
      typeof parsed.weeklyCapacityMinutes !== "number" ||
      !Number.isFinite(parsed.weeklyCapacityMinutes) ||
      parsed.weeklyCapacityMinutes <= 0 ||
      typeof parsed.active !== "boolean" ||
      typeof parsed.updatedAt !== "string"
    ) {
      return null;
    }
    return parsed as LaborCapacitySnapshot;
  } catch {
    return null;
  }
}

async function latestProfile(input: {
  organizationId: string;
  siteId: string;
  userId: string;
}) {
  const log = await db.auditLog.findFirst({
    where: {
      entityType: ENTITY_TYPE,
      entityId: profileId(input.organizationId, input.siteId, input.userId),
    },
    orderBy: { createdAt: "desc" },
    select: { afterJson: true },
  });
  return parseSnapshot(log?.afterJson ?? null);
}

async function findEligibleUsers(input: {
  organizationId: string;
  siteId: string;
  userIds?: string[];
}) {
  return db.organizationMembership.findMany({
    where: {
      organizationId: input.organizationId,
      active: true,
      role: { in: MAINTENANCE_ROLES },
      user: {
        active: true,
        ...(input.userIds ? { id: { in: input.userIds } } : {}),
      },
      OR: [
        { allSites: true },
        { siteMemberships: { some: { siteId: input.siteId } } },
      ],
    },
    select: {
      userId: true,
      user: { select: { displayName: true } },
    },
    orderBy: { user: { displayName: "asc" } },
  });
}

async function validateScope(input: {
  organizationId: string;
  siteId: string;
  userId: string;
}) {
  const [site, members] = await Promise.all([
    db.site.findFirst({
      where: { id: input.siteId, organizationId: input.organizationId, active: true },
      select: { id: true },
    }),
    findEligibleUsers({
      organizationId: input.organizationId,
      siteId: input.siteId,
      userIds: [input.userId],
    }),
  ]);
  if (!site) {
    throw new LaborCapacityError("SITE_NOT_FOUND", "Active site not found in organization scope");
  }
  if (members.length !== 1) {
    throw new LaborCapacityError(
      "USER_NOT_ELIGIBLE",
      "Capacity can only be configured for an active maintenance member with access to this site",
    );
  }
  return members[0];
}

export async function listLaborCapacityProfiles(input: {
  organizationId: string;
  siteId: string;
}) {
  const logs = await db.auditLog.findMany({
    where: {
      entityType: ENTITY_TYPE,
      AND: [
        { afterJson: { contains: `\"organizationId\":\"${input.organizationId}\"` } },
        { afterJson: { contains: `\"siteId\":\"${input.siteId}\"` } },
      ],
    },
    orderBy: { createdAt: "asc" },
    select: { entityId: true, afterJson: true },
  });

  const latest = new Map<string, LaborCapacitySnapshot>();
  for (const log of logs) {
    const snapshot = parseSnapshot(log.afterJson);
    if (
      snapshot &&
      snapshot.organizationId === input.organizationId &&
      snapshot.siteId === input.siteId
    ) {
      latest.set(log.entityId, snapshot);
    }
  }

  const active = [...latest.values()].filter((profile) => profile.active);
  if (!active.length) return [];

  const members = await findEligibleUsers({
    organizationId: input.organizationId,
    siteId: input.siteId,
    userIds: active.map((profile) => profile.userId),
  });
  const names = new Map(members.map((member) => [member.userId, member.user.displayName]));

  return active
    .filter((profile) => names.has(profile.userId))
    .map((profile): LaborCapacityProfile => ({
      ...profile,
      displayName: names.get(profile.userId) ?? "Unknown",
    }))
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

export async function setLaborCapacityProfile(input: {
  organizationId: string;
  siteId: string;
  userId: string;
  weeklyCapacityMinutes: number;
  actorId: string;
}) {
  if (
    !Number.isInteger(input.weeklyCapacityMinutes) ||
    input.weeklyCapacityMinutes <= 0 ||
    input.weeklyCapacityMinutes > 7 * 24 * 60
  ) {
    throw new LaborCapacityError(
      "INVALID_CAPACITY",
      "weeklyCapacityMinutes must be a positive whole number no greater than 10080",
    );
  }

  await validateScope(input);
  const previous = await latestProfile(input);
  const snapshot: LaborCapacitySnapshot = {
    id: profileId(input.organizationId, input.siteId, input.userId),
    organizationId: input.organizationId,
    siteId: input.siteId,
    userId: input.userId,
    weeklyCapacityMinutes: input.weeklyCapacityMinutes,
    active: true,
    updatedAt: new Date().toISOString(),
  };

  await db.auditLog.create({
    data: {
      actorId: input.actorId,
      entityType: ENTITY_TYPE,
      entityId: snapshot.id,
      action: previous ? "UPDATED" : "CREATED",
      beforeJson: previous ? JSON.stringify(previous) : null,
      afterJson: JSON.stringify(snapshot),
    },
  });
  return snapshot;
}

export async function disableLaborCapacityProfile(input: {
  organizationId: string;
  siteId: string;
  userId: string;
  actorId: string;
}) {
  const previous = await latestProfile(input);
  if (
    !previous ||
    !previous.active ||
    previous.organizationId !== input.organizationId ||
    previous.siteId !== input.siteId
  ) {
    throw new LaborCapacityError("PROFILE_NOT_FOUND", "Active labor capacity profile not found");
  }

  const snapshot: LaborCapacitySnapshot = {
    ...previous,
    active: false,
    updatedAt: new Date().toISOString(),
  };
  await db.auditLog.create({
    data: {
      actorId: input.actorId,
      entityType: ENTITY_TYPE,
      entityId: snapshot.id,
      action: "DISABLED",
      beforeJson: JSON.stringify(previous),
      afterJson: JSON.stringify(snapshot),
    },
  });
  return snapshot;
}

export function countWeekdaysInclusive(from: string, to: string) {
  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end < start) return 0;

  let weekdays = 0;
  for (let cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) weekdays += 1;
  }
  return weekdays;
}

export function baselineCapacityMinutes(weeklyCapacityMinutes: number, weekdayCount: number) {
  if (weeklyCapacityMinutes <= 0 || weekdayCount <= 0) return 0;
  return (weeklyCapacityMinutes / 5) * weekdayCount;
}
