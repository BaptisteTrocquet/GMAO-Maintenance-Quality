import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auditFindFirst: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    auditLog: {
      findFirst: mocks.auditFindFirst,
      create: mocks.auditCreate,
    },
  },
}));

import {
  DASHBOARD_KPI_KEYS,
  DashboardKpiConfigError,
  getDashboardKpiConfig,
  saveDashboardKpiConfig,
} from "@/lib/dashboard/kpi-cards";

const scope = { organizationId: "org-a", siteId: "site-a", userId: "user-a" };

describe("dashboard KPI card configuration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auditFindFirst.mockResolvedValue(null);
    mocks.auditCreate.mockResolvedValue({ id: "audit-a" });
  });

  it("defaults to all supported cards when no personal configuration exists", async () => {
    const result = await getDashboardKpiConfig(scope);

    expect(result.cards).toEqual([...DASHBOARD_KPI_KEYS]);
    expect(result).toMatchObject(scope);
    expect(mocks.auditFindFirst).toHaveBeenCalledWith({
      where: { entityType: "DashboardKpiCardConfig", entityId: expect.any(String) },
      orderBy: { createdAt: "desc" },
      select: { afterJson: true },
    });
  });

  it("restores the exact saved subset and display order for the scoped user", async () => {
    mocks.auditFindFirst.mockResolvedValue({
      afterJson: JSON.stringify({
        ...scope,
        cards: ["URGENT_WORK", "OPEN_WORK", "PENDING_APPROVALS"],
        updatedAt: "2026-08-08T01:00:00.000Z",
      }),
    });

    const result = await getDashboardKpiConfig(scope);

    expect(result.cards).toEqual(["URGENT_WORK", "OPEN_WORK", "PENDING_APPROVALS"]);
  });

  it("ignores a malformed or mismatched snapshot instead of leaking another scope", async () => {
    mocks.auditFindFirst.mockResolvedValue({
      afterJson: JSON.stringify({
        organizationId: "org-b",
        siteId: "site-a",
        userId: "user-a",
        cards: ["OPEN_WORK"],
        updatedAt: "2026-08-08T01:00:00.000Z",
      }),
    });

    const result = await getDashboardKpiConfig(scope);

    expect(result.cards).toEqual([...DASHBOARD_KPI_KEYS]);
    expect(result.organizationId).toBe("org-a");
  });

  it("persists an auditable ordered subset, including an intentionally empty selection", async () => {
    const result = await saveDashboardKpiConfig({ ...scope, cards: ["OVERDUE_WORK", "OPEN_WORK"] });

    expect(result.cards).toEqual(["OVERDUE_WORK", "OPEN_WORK"]);
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: "user-a",
        entityType: "DashboardKpiCardConfig",
        entityId: expect.any(String),
        action: "UPDATED",
        beforeJson: expect.any(String),
        afterJson: expect.stringContaining('"cards":["OVERDUE_WORK","OPEN_WORK"]'),
      }),
    });

    mocks.auditCreate.mockClear();
    await saveDashboardKpiConfig({ ...scope, cards: [] });
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate or unsupported card keys at the service boundary", async () => {
    await expect(
      saveDashboardKpiConfig({
        ...scope,
        cards: ["OPEN_WORK", "OPEN_WORK"] as (typeof DASHBOARD_KPI_KEYS)[number][],
      }),
    ).rejects.toBeInstanceOf(DashboardKpiConfigError);

    await expect(
      saveDashboardKpiConfig({
        ...scope,
        cards: ["NOT_A_CARD"] as unknown as (typeof DASHBOARD_KPI_KEYS)[number][],
      }),
    ).rejects.toBeInstanceOf(DashboardKpiConfigError);
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});
