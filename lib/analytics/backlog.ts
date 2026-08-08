import { Prisma, type WorkOrderStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { resolveAnalyticsDateRange } from "@/lib/analytics/date-range";

export const BACKLOG_DETAIL_LIMIT = 50;
export const BACKLOG_EXPORT_LIMIT = 5000;

const DAY_MS = 24 * 60 * 60 * 1000;
const OPEN_STATUSES: WorkOrderStatus[] = [
  "REQUESTED",
  "APPROVED",
  "PLANNED",
  "IN_PROGRESS",
  "BLOCKED",
];

export type BacklogAnalyticsInput = {
  organizationId: string;
  siteId: string;
  timeZone: string;
  assetId?: string | null;
  fromDate?: string | null;
  toDate?: string | null;
  now?: Date;
};

function buildBacklogWhere(input: BacklogAnalyticsInput, now: Date) {
  const range = resolveAnalyticsDateRange({
    from: input.fromDate,
    to: input.toDate,
    timeZone: input.timeZone,
  });
  const requestedAt: Prisma.DateTimeFilter = { lte: now };
  if (range.from) requestedAt.gte = range.from;
  if (range.toExclusive) requestedAt.lt = range.toExclusive;

  return {
    range,
    where: {
      siteId: input.siteId,
      site: { organizationId: input.organizationId, active: true },
      status: { in: OPEN_STATUSES },
      requestedAt,
      ...(input.assetId ? { assetId: input.assetId } : {}),
    } satisfies Prisma.WorkOrderWhereInput,
  };
}

function boundary(now: Date, days: number) {
  return new Date(now.getTime() - days * DAY_MS);
}

function statusRecord(rows: Array<{ status: WorkOrderStatus; _count: { _all: number } }>) {
  const result: Record<WorkOrderStatus, number> = {
    REQUESTED: 0,
    APPROVED: 0,
    PLANNED: 0,
    IN_PROGRESS: 0,
    BLOCKED: 0,
    COMPLETED: 0,
    CANCELLED: 0,
  };
  for (const row of rows) result[row.status] = row._count._all;
  return result;
}

export async function getBacklogAnalytics(input: BacklogAnalyticsInput) {
  const now = input.now ?? new Date();
  const { range, where: base } = buildBacklogWhere(input, now);
  const sevenDaysAgo = boundary(now, 7);
  const thirtyDaysAgo = boundary(now, 30);
  const ninetyDaysAgo = boundary(now, 90);

  const [
    total,
    overdue,
    urgent,
    unassigned,
    byStatusRows,
    age0To6,
    age7To29,
    age30To89,
    age90Plus,
    oldest,
  ] = await Promise.all([
    db.workOrder.count({ where: base }),
    db.workOrder.count({ where: { AND: [base, { dueAt: { lt: now } }] } }),
    db.workOrder.count({ where: { AND: [base, { priority: "URGENT" }] } }),
    db.workOrder.count({ where: { AND: [base, { assigneeId: null, teamId: null }] } }),
    db.workOrder.groupBy({ by: ["status"], where: base, _count: { _all: true } }),
    db.workOrder.count({
      where: { AND: [base, { requestedAt: { gt: sevenDaysAgo, lte: now } }] },
    }),
    db.workOrder.count({
      where: {
        AND: [base, { requestedAt: { gt: thirtyDaysAgo, lte: sevenDaysAgo } }],
      },
    }),
    db.workOrder.count({
      where: {
        AND: [base, { requestedAt: { gt: ninetyDaysAgo, lte: thirtyDaysAgo } }],
      },
    }),
    db.workOrder.count({
      where: { AND: [base, { requestedAt: { lte: ninetyDaysAgo } }] },
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
        plannedStart: true,
        dueAt: true,
        asset: { select: { id: true, code: true, name: true } },
        assignee: { select: { displayName: true } },
        team: { select: { name: true } },
      },
      orderBy: [{ requestedAt: "asc" }, { number: "asc" }],
      take: BACKLOG_DETAIL_LIMIT,
    }),
  ]);

  const byStatus = statusRecord(byStatusRows);
  return {
    scope: {
      organizationId: input.organizationId,
      siteId: input.siteId,
      assetId: input.assetId ?? null,
    },
    range: {
      fromDate: range.input.from,
      toDate: range.input.to,
      semantics: "requestedAt" as const,
      timeZone: input.timeZone,
      fromUtc: range.from?.toISOString() ?? null,
      toExclusiveUtc: range.toExclusive?.toISOString() ?? null,
    },
    generatedAt: now.toISOString(),
    empty: total === 0,
    metrics: {
      total,
      overdue,
      blocked: byStatus.BLOCKED,
      urgent,
      unassigned,
    },
    byStatus,
    ageBuckets: {
      days0To6: age0To6,
      days7To29: age7To29,
      days30To89: age30To89,
      days90Plus: age90Plus,
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
  const now = input.now ?? new Date();
  const { where: base } = buildBacklogWhere(input, now);
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
  const lines = [[
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
  ].join(",")];

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
