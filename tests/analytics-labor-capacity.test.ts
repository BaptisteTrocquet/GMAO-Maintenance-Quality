import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  siteFindFirst: vi.fn(),
  membershipFindMany: vi.fn(),
  auditFindFirst: vi.fn(),
  auditFindMany: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    site: { findFirst: mocks.siteFindFirst },
    organizationMembership: { findMany: mocks.membershipFindMany },
    auditLog: {
      findFirst: mocks.auditFindFirst,
      findMany: mocks.auditFindMany,
      create: mocks.auditCreate,
    },
  },
}));

import {
  baselineCapacityMinutes,
  countWeekdaysInclusive,
  LaborCapacityError,
  listLaborCapacityProfiles,
  setLaborCapacityProfile,
} from "@/lib/analytics/labor-capacity";

describe("labor capacity baselines", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.siteFindFirst.mockResolvedValue({ id: "site-a" });
    mocks.membershipFindMany.mockResolvedValue([
      { userId: "user-a", user: { displayName: "Synthetic Technician" } },
    ]);
    mocks.auditFindFirst.mockResolvedValue(null);
    mocks.auditFindMany.mockResolvedValue([]);
    mocks.auditCreate.mockResolvedValue({ id: "audit-a" });
  });

  it("prorates weekly capacity across Monday-Friday calendar days", () => {
    expect(countWeekdaysInclusive("2026-08-03", "2026-08-07")).toBe(5);
    expect(countWeekdaysInclusive("2026-08-01", "2026-08-09")).toBe(5);
    expect(countWeekdaysInclusive("2026-08-08", "2026-08-09")).toBe(0);
    expect(baselineCapacityMinutes(2100, 5)).toBe(2100);
    expect(baselineCapacityMinutes(2100, 3)).toBe(1260);
  });

  it("saves an audited baseline only for an eligible active maintenance member", async () => {
    const result = await setLaborCapacityProfile({
      organizationId: "org-a",
      siteId: "site-a",
      userId: "user-a",
      weeklyCapacityMinutes: 2100,
      actorId: "manager-a",
    });

    expect(result).toMatchObject({
      organizationId: "org-a",
      siteId: "site-a",
      userId: "user-a",
      weeklyCapacityMinutes: 2100,
      active: true,
    });
    expect(mocks.membershipFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: "org-a",
          active: true,
          role: { in: ["OWNER", "ADMIN", "MAINTENANCE_MANAGER", "TECHNICIAN"] },
          OR: [
            { allSites: true },
            { siteMemberships: { some: { siteId: "site-a" } } },
          ],
        }),
      }),
    );
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: "manager-a",
        entityType: "LaborCapacityProfile",
        action: "CREATED",
        afterJson: expect.stringContaining('"weeklyCapacityMinutes":2100'),
      }),
    });
  });

  it("rejects invalid capacity before any database access", async () => {
    await expect(
      setLaborCapacityProfile({
        organizationId: "org-a",
        siteId: "site-a",
        userId: "user-a",
        weeklyCapacityMinutes: 0,
        actorId: "manager-a",
      }),
    ).rejects.toBeInstanceOf(LaborCapacityError);

    expect(mocks.siteFindFirst).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("rejects users without active maintenance access to the selected site", async () => {
    mocks.membershipFindMany.mockResolvedValue([]);

    await expect(
      setLaborCapacityProfile({
        organizationId: "org-a",
        siteId: "site-a",
        userId: "user-other",
        weeklyCapacityMinutes: 2100,
        actorId: "manager-a",
      }),
    ).rejects.toMatchObject({ code: "USER_NOT_ELIGIBLE" });

    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("queries raw AuditLog JSON without escaped quote literals", async () => {
    await listLaborCapacityProfiles({ organizationId: "org-a", siteId: "site-a" });

    expect(mocks.auditFindMany).toHaveBeenCalledWith({
      where: {
        entityType: "LaborCapacityProfile",
        AND: [
          { afterJson: { contains: '"organizationId":"org-a"' } },
          { afterJson: { contains: '"siteId":"site-a"' } },
        ],
      },
      orderBy: { createdAt: "asc" },
      select: { entityId: true, afterJson: true },
    });
  });

  it("returns only the latest active profile for currently eligible users", async () => {
    mocks.auditFindMany.mockResolvedValue([
      {
        entityId: "profile-a",
        afterJson: JSON.stringify({
          id: "profile-a",
          organizationId: "org-a",
          siteId: "site-a",
          userId: "user-a",
          weeklyCapacityMinutes: 1800,
          active: true,
          updatedAt: "2026-08-01T00:00:00.000Z",
        }),
      },
      {
        entityId: "profile-a",
        afterJson: JSON.stringify({
          id: "profile-a",
          organizationId: "org-a",
          siteId: "site-a",
          userId: "user-a",
          weeklyCapacityMinutes: 2100,
          active: true,
          updatedAt: "2026-08-02T00:00:00.000Z",
        }),
      },
    ]);

    const result = await listLaborCapacityProfiles({ organizationId: "org-a", siteId: "site-a" });

    expect(result).toEqual([
      expect.objectContaining({
        userId: "user-a",
        displayName: "Synthetic Technician",
        weeklyCapacityMinutes: 2100,
      }),
    ]);
  });
});
