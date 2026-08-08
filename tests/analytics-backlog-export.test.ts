import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findMany: vi.fn() }));

vi.mock("@/lib/db", () => ({
  db: { workOrder: { findMany: mocks.findMany } },
}));

import { BACKLOG_EXPORT_LIMIT, exportBacklogCsv } from "@/lib/analytics/backlog";

function row(index: number) {
  return {
    number: `WO-${index}`,
    title: index === 0 ? 'Pump, "north"\nline' : "Synthetic work",
    status: "REQUESTED",
    priority: "NORMAL",
    requestedAt: new Date("2026-08-08T08:00:00.000Z"),
    plannedStart: null,
    dueAt: null,
    asset: index === 0 ? { code: "EQ-001", name: "Pump, north" } : null,
    assignee: null,
    team: index === 0 ? { name: "Maintenance team" } : null,
  };
}

describe("backlog CSV export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findMany.mockResolvedValue([]);
  });

  it("uses the same tenant/site open-backlog scope and a hard row limit", async () => {
    await exportBacklogCsv({ organizationId: "org-a", siteId: "site-a" });

    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          siteId: "site-a",
          site: { organizationId: "org-a", active: true },
          status: { in: ["REQUESTED", "APPROVED", "PLANNED", "IN_PROGRESS", "BLOCKED"] },
        },
        orderBy: [{ requestedAt: "asc" }, { number: "asc" }],
        take: BACKLOG_EXPORT_LIMIT + 1,
      }),
    );
  });

  it("escapes CSV fields and reports truncation without exporting the sentinel row", async () => {
    mocks.findMany.mockResolvedValue(
      Array.from({ length: BACKLOG_EXPORT_LIMIT + 1 }, (_, index) => row(index)),
    );

    const result = await exportBacklogCsv({ organizationId: "org-a", siteId: "site-a" });

    expect(result.rowCount).toBe(BACKLOG_EXPORT_LIMIT);
    expect(result.truncated).toBe(true);
    expect(result.limit).toBe(BACKLOG_EXPORT_LIMIT);
    expect(result.csv).toContain('"Pump, ""north""\nline"');
    expect(result.csv).toContain('"Pump, north"');
    expect(result.csv).toContain("Maintenance team");
    expect(result.csv).not.toContain(`WO-${BACKLOG_EXPORT_LIMIT},`);
  });

  it("returns a header-only CSV for an empty backlog", async () => {
    const result = await exportBacklogCsv({ organizationId: "org-a", siteId: "site-a" });

    expect(result.rowCount).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.csv.split("\r\n").filter(Boolean)).toHaveLength(1);
  });
});
