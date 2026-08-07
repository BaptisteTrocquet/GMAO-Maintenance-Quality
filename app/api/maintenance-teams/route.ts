import { z } from "zod";
import { apiData, apiError } from "@/lib/api-response";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { db } from "@/lib/db";

const createSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  code: z.string().trim().min(1).max(50),
  name: z.string().trim().min(1).max(150),
  description: z.string().max(1000).nullable().optional(),
  memberIds: z.array(z.string().min(1)).max(100).default([]),
});

function denied(error: unknown) {
  if (error instanceof AccessDeniedError) {
    return apiError(403, "ACCESS_DENIED", error.message);
  }
  throw error;
}

async function findActiveSite(organizationId: string, siteId: string) {
  return db.site.findFirst({
    where: { id: siteId, organizationId, active: true },
    select: { id: true },
  });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const organizationId = url.searchParams.get("organizationId");
  const siteId = url.searchParams.get("siteId");
  if (!organizationId || !siteId) {
    return apiError(400, "INVALID_SCOPE", "organizationId and siteId are required");
  }

  const auth = await authenticateRequest(request, organizationId);
  if ("error" in auth) return auth.error;

  try {
    assertSitePermission(auth.tenant.scope, siteId, "maintenance:read");
  } catch (error) {
    return denied(error);
  }

  if (!(await findActiveSite(organizationId, siteId))) {
    return apiError(404, "SITE_NOT_FOUND", "Site not found");
  }

  return apiData(
    await db.maintenanceTeam.findMany({
      where: { siteId, active: true },
      include: {
        members: { include: { user: { select: { id: true, displayName: true, active: true } } } },
        _count: { select: { workOrders: true } },
      },
      orderBy: { name: "asc" },
    }),
  );
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid maintenance team payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;

  try {
    assertSitePermission(auth.tenant.scope, parsed.data.siteId, "maintenance:manage");
  } catch (error) {
    return denied(error);
  }

  if (!(await findActiveSite(parsed.data.organizationId, parsed.data.siteId))) {
    return apiError(404, "SITE_NOT_FOUND", "Site not found");
  }

  const memberIds = [...new Set(parsed.data.memberIds)];
  if (memberIds.length) {
    const memberships = await db.organizationMembership.findMany({
      where: {
        organizationId: parsed.data.organizationId,
        userId: { in: memberIds },
        active: true,
        role: { in: ["OWNER", "ADMIN", "MAINTENANCE_MANAGER", "TECHNICIAN"] },
        user: { active: true },
        OR: [
          { allSites: true },
          { siteMemberships: { some: { siteId: parsed.data.siteId } } },
        ],
      },
      select: { userId: true },
    });
    if (new Set(memberships.map((membership) => membership.userId)).size !== memberIds.length) {
      return apiError(
        400,
        "INVALID_TEAM_MEMBERS",
        "Every team member must be an active maintenance member with access to this site",
      );
    }
  }

  const existingCode = await db.maintenanceTeam.findFirst({
    where: { siteId: parsed.data.siteId, code: parsed.data.code },
    select: { id: true },
  });
  if (existingCode) {
    return apiError(409, "TEAM_CODE_EXISTS", "A maintenance team with this code already exists");
  }

  const team = await db.maintenanceTeam.create({
    data: {
      siteId: parsed.data.siteId,
      code: parsed.data.code,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      members: { create: memberIds.map((userId) => ({ userId })) },
    },
    include: { members: { include: { user: { select: { id: true, displayName: true } } } } },
  });

  await db.auditLog.create({
    data: {
      actorId: auth.session.user.id,
      entityType: "MaintenanceTeam",
      entityId: team.id,
      action: "CREATED",
      afterJson: JSON.stringify(team),
    },
  });

  return apiData(team, { status: 201 });
}
