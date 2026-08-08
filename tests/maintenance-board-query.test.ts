import { describe, expect, it } from "vitest";
import {
  buildWorkOrderBoardWhere,
  WORK_ORDER_BOARD_STATUSES,
} from "@/lib/maintenance/board";

const now = new Date("2026-08-08T12:00:00.000Z");

describe("work-order Kanban database query", () => {
  it("always scopes work orders to the selected organization and site", () => {
    expect(
      buildWorkOrderBoardWhere({
        organizationId: "org-a",
        siteId: "site-a",
        dueFilter: "ALL",
        now,
      }),
    ).toEqual({
      siteId: "site-a",
      site: { organizationId: "org-a", active: true },
      status: { in: [...WORK_ORDER_BOARD_STATUSES] },
    });
  });

  it("pushes overdue filtering into the database and excludes completed work", () => {
    expect(
      buildWorkOrderBoardWhere({
        organizationId: "org-a",
        siteId: "site-a",
        dueFilter: "OVERDUE",
        now,
      }),
    ).toEqual({
      siteId: "site-a",
      site: { organizationId: "org-a", active: true },
      status: { in: ["REQUESTED", "APPROVED", "PLANNED", "IN_PROGRESS", "BLOCKED"] },
      dueAt: { lt: now },
    });
  });

  it("uses an exact seven-day due window for active workflow items", () => {
    expect(
      buildWorkOrderBoardWhere({
        organizationId: "org-a",
        siteId: "site-a",
        dueFilter: "DUE_7_DAYS",
        now,
      }),
    ).toEqual({
      siteId: "site-a",
      site: { organizationId: "org-a", active: true },
      status: { in: ["REQUESTED", "APPROVED", "PLANNED", "IN_PROGRESS", "BLOCKED"] },
      dueAt: {
        gte: now,
        lte: new Date("2026-08-15T12:00:00.000Z"),
      },
    });
  });

  it("supports a no-due-date query without widening tenant scope", () => {
    expect(
      buildWorkOrderBoardWhere({
        organizationId: "org-a",
        siteId: "site-a",
        dueFilter: "NO_DUE_DATE",
        now,
      }),
    ).toEqual({
      siteId: "site-a",
      site: { organizationId: "org-a", active: true },
      status: { in: [...WORK_ORDER_BOARD_STATUSES] },
      dueAt: null,
    });
  });
});