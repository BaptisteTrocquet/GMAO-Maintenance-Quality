import { Prisma, type WorkOrderStatus } from "@prisma/client";
import { db } from "@/lib/db";

export const BACKLOG_DETAIL_LIMIT = 50;
export const BACKLOG_EXPORT_LIMIT = 5000;

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

export class BacklogAnalyticsError extends Error {
  constructor(
    public readonly code: "INVALID_DATE_RANGE",
    message: string,
  ) {
    super(message);
    this.name = "BacklogAnalyticsError";
  }
}

export type BacklogAnalyticsInput = {
  organizationId: string;
  siteId: string;
  assetId?: string | null;
  fromDate?: string | null;
  toDate?: string | null;
  now?: Date;
};

export type NormalizedBacklogRange = {
  from: Date | null;
  to: Date | null;
  fromDate: string | null;
  toDate: string | null;
};

function parseDateOnly(value: string, endOfDay: boolean) {
  const match = DATE_ONLY.exec(value);
  if (!match) {
    throw new BacklogAnalyticsError(
      "INVALID_DATE_RANGE",
      "Analytics dates must use YYYY-MM-DD format",
    );
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(
    Date.UTC(
      year,
      month - 1,
      day,
      endOfDay ? 23 : 0,
      endOfDay ? 59 : 0,
      endOfDay ? 59 : 0,
      endOfDay ? 999 : 0,
    ),
  );

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new BacklogAnalyticsError("INVALID_DATE_RANGE", "Analytics date is not a valid calendar day");
  }
  return date;
}

export function normalizeBacklogRange(input: {
  fromDate?: string | null;
  toDate?: string | null;
}): NormalizedBacklogRange {
  const fromDate = input.fromDate?.trim() || null;
  const toDate = input.toDate?.trim() || null;
  const from = fromDate ? parseDateOnly(fromDate, false) : null;
  const to = toDate ? parseDateOnly(toDate, true) : null;

  if (from && to && from.getTime() > to.getTime()) {
    throw new BacklogAnalyticsError(
      "INVALID_DATE_RANGE",
      "Analytics fromDate must be on or before toDate",
    );
  }

  return { from, to, fromDate, toDate };
}

function backlogWhere(input: BacklogAnalyticsInput, range: NormalizedBacklogRange) {
  const requestedAt: { gte?: Date; lte?: Date } = {};
  if (range.from) requestedAt.gte = range.from;
  if (range.to) requestedAt.lte = range.to;

  return {
    siteId: input.siteId,
    site: { organizationId: input.organizationId, active: true },
    status: { notIn: ["COMPLETED", "CANCELLED"] as WorkOrderStatus[] },
    ...(input.assetId ? { assetId: input.assetId } : {}),
    ...(range.from || range.to ? { requestedAt } : {}),
  } satisfies Prisma.WorkOrderWhereInput;
}

function ageBoundary(now: Date, days: number) {
  return new Date(now.getTime() - days * DAY_MS);
}

export async function getBacklogAnalytics(input: BacklogAnalyticsInput) {
  const range = normalizeBacklogRange(input);
  const now = input.now ?? new Date();
  const base = backlogWhere(input, range);
  const sevenDaysAgo = ageBoundary(now, 7);
  const thirtyDaysAgo = ageBoundary(now, 30);
  const ninetyDaysAgo = ageBoundary(now, 90);

  const [
    total,
    overdue,
    urgent,
    unassigned,
    byStatusRows,
    age0To7,
    age8To30,
    age31To90,
    ageOver90,
    oldest,
  ] = await Promise.all([
    db.workOrder.count({ where: base }),
    db.workOrder.count({ where: { AND: [base, { dueAt: { lt: now } }] } }),
    db.workOrder.count({ where: { AND: [base, { priority: "URGENT" }] } }),
    db.workOrder.count({
      where: { AND: [base, { assigneeId: null, teamId: null }] },
    }),
    db.workOrder.groupBy({
      by: ["status"],
      where: base,
      _count: { _all: true },
    }),
    db.workOrder.count({
      where: { AND: [base, { requestedAt: { gte: sevenDaysAgo, lte: now } }] },
    }),
    db.workOrder.count({
      where: {
        AND: [base, { requestedAt: { gte: thirtyDaysAgo, lt: sevenDaysAgo } }],
      },
    }),
    db.workOrder.count({
      where: {
        AND: [base, { requestedAt: { gte: ninetyDaysAgo, lt: thirtyDaysAgo } }],
      },
    }),
    db.workOrder.count({
      where: { AND: [base, { requestedAt: { lt: ninetyDaysAgo } }] },
    }),
    db.workOrder.findMany({
      where: base,
      select: {
        id: true,
        number: true,
        title: true,
        status: true,
        priority: true,
        requestedAt: true,
        dueAt: true,
        asset: { select: { id: true, code: true, name: true } },
        assignee: { select: { displayName: true } },
        team: { select: { name: true } },
      },
      orderBy: [{ requestedAt: "asc" }, { number: "asc" }],
      take: BACKLOG_DETAIL_LIMIT,
    }),
  ]);

  const byStatus = Object.fromEntries(
    byStatusRows.map((row) => [row.status, row._count._all]),
  ) as Partial<Record<WorkOrderStatus, number>>;

  return {
    scope: {
      organizationId: input.organizationId,
      siteId: input.siteId,
      assetId: input.assetId ?? null,
    },
    range: {
      fromDate: range.fromDate,
      toDate: range.toDate,
      semantics: "requestedAt",
      timezone: "UTC",
    },
    asOf: now.toISOString(),
    metrics: {
      total,
      overdue,
      urgent,
      unassigned,
    },
    byStatus,
    ageBuckets: {
      days0To7: age0To7,
      days8To30: age8To30,
      days31To90: age31To90,
      over90Days: ageOver90,
    },
    oldest,
    detailLimit: BACKLOG_DETAIL_LIMIT,
    detailTruncated: total > oldest.length,
  };
}

function csvCell(value: string | number | null | undefined) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export async function exportBacklogCsv(input: BacklogAnalyticsInput) {
  const range = normalizeBacklogRange(input);
  const base = backlogWhere(input, range);
  const rows = await db.workOrder.findMany({
    where: base,
    select: {
      number: true,
      title: true,
      status: true,
      priority: true,
      requestedAt: true,
      plannedStart: true,
      dueAt: true,
      asset: { select: { code: true, name: true } },
      assignee: { select: { displayName: true } },
      team: { select: { name: true } },
    },
    orderBy: [{ requestedAt: "asc" }, { number: "asc" }],
    take: BACKLOG_EXPORT_LIMIT + 1,
  });
  const truncated = rows.length > BACKLOG_EXPORT_LIMIT;
  const exported = rows.slice(0, BACKLOG_EXPORT_LIMIT);
  const header = [
    "number",
    "title",
    "status",
    "priority",
    "requestedAtUtc",
    "plannedStartUtc",
    "dueAtUtc",
    "assetCode",
    "assetName",
    "owner",
  ];
  const lines = [header.join(",")];

  for (const row of exported) {
    lines.push(
      [
        row.number,
        row.title,
        row.status,
        row.priority,
        row.requestedAt.toISOString(),
        row.plannedStart?.toISOString() ?? "",
        row.dueAt?.toISOString() ?? "",
        row.asset?.code ?? "",
        row.asset?.name ?? "",
        row.assignee?.displayName ?? row.team?.name ?? "",
      ]
        .map(csvCell)
        .join(","),
    );
  }

  return {
    csv: `${lines.join("\r\n")}\r\n`,
    rowCount: exported.length,
    truncated,
    limit: BACKLOG_EXPORT_LIMIT,
  };
}
