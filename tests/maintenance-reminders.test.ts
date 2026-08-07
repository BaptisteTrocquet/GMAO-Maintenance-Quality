import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  siteFindFirst: vi.fn(),
  workOrderFindMany: vi.fn(),
  reminderUpdateMany: vi.fn(),
  reminderFindUnique: vi.fn(),
  reminderCreate: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    site: { findFirst: mocks.siteFindFirst },
    workOrder: { findMany: mocks.workOrderFindMany },
    maintenanceReminder: {
      updateMany: mocks.reminderUpdateMany,
      findUnique: mocks.reminderFindUnique,
      create: mocks.reminderCreate,
    },
    auditLog: { create: mocks.auditCreate },
  },
}));

import {
  generatePreventiveMaintenanceReminders,
  maintenanceReminderOccurrenceKey,
} from "@/lib/maintenance/reminders";

const now = new Date("2026-08-07T12:00:00.000Z");
const dueAt = new Date("2026-08-12T12:00:00.000Z");
const workOrder = {
  id: "wo-1",
  number: "PM-001",
  title: "Inspect drive",
  dueAt,
  asset: { code: "A-100" },
};

function reminder(id = "reminder-1") {
  return {
    id,
    siteId: "site-a",
    workOrderId: "wo-1",
    occurrenceKey: maintenanceReminderOccurrenceKey({ workOrderId: "wo-1", dueAt, leadDays: 7 }),
    title: "PM-001 · Inspect drive",
    assetCode: "A-100",
    dueAt,
    remindAt: new Date("2026-08-05T12:00:00.000Z"),
    leadDays: 7,
    status: "ACTIVE",
    createdAt: now,
    dismissedAt: null,
  };
}

describe("preventive maintenance reminders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.siteFindFirst.mockResolvedValue({ id: "site-a" });
    mocks.workOrderFindMany.mockResolvedValue([workOrder]);
    mocks.reminderUpdateMany.mockResolvedValue({ count: 0 });
    mocks.reminderFindUnique.mockResolvedValue(null);
    mocks.reminderCreate.mockResolvedValue(reminder());
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("uses a stable occurrence key for one WO due date and lead window", () => {
    const key = maintenanceReminderOccurrenceKey({ workOrderId: "wo-1", dueAt, leadDays: 7 });
    expect(key).toBe(maintenanceReminderOccurrenceKey({ workOrderId: "wo-1", dueAt, leadDays: 7 }));
    expect(key).not.toBe(maintenanceReminderOccurrenceKey({ workOrderId: "wo-1", dueAt, leadDays: 3 }));
  });

  it("creates one active reminder for a preventive WO entering the lead window", async () => {
    const result = await generatePreventiveMaintenanceReminders({
      organizationId: "org-a",
      siteId: "site-a",
      leadDays: 7,
      now,
      actorId: "manager-1",
    });

    expect(result.created).toEqual([{ id: "reminder-1", workOrderId: "wo-1", dueAt }]);
    expect(mocks.workOrderFindMany).toHaveBeenCalledWith({
      where: {
        siteId: "site-a",
        type: "PREVENTIVE",
        status: { notIn: ["COMPLETED", "CANCELLED"] },
        dueAt: {
          gte: now,
          lte: new Date("2026-08-14T12:00:00.000Z"),
        },
      },
      select: {
        id: true,
        number: true,
        title: true,
        dueAt: true,
        asset: { select: { code: true } },
      },
      orderBy: { dueAt: "asc" },
    });
    expect(mocks.reminderCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        siteId: "site-a",
        workOrderId: "wo-1",
        title: "PM-001 · Inspect drive",
        assetCode: "A-100",
        dueAt,
        remindAt: new Date("2026-08-05T12:00:00.000Z"),
        leadDays: 7,
        status: "ACTIVE",
      }),
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: "manager-1",
        entityType: "MaintenanceReminder",
        action: "CREATED",
      }),
    });
  });

  it("does not create a second reminder on repeated scheduler runs", async () => {
    mocks.reminderFindUnique.mockResolvedValue(reminder("reminder-existing"));

    const result = await generatePreventiveMaintenanceReminders({
      organizationId: "org-a",
      siteId: "site-a",
      leadDays: 7,
      now,
    });

    expect(result.created).toEqual([]);
    expect(result.existing).toEqual([{ id: "reminder-existing", workOrderId: "wo-1", dueAt }]);
    expect(mocks.reminderCreate).not.toHaveBeenCalled();
  });

  it("expires the previous active occurrence when a WO is rescheduled", async () => {
    const rescheduledDueAt = new Date("2026-08-13T12:00:00.000Z");
    mocks.workOrderFindMany.mockResolvedValue([{ ...workOrder, dueAt: rescheduledDueAt }]);
    mocks.reminderCreate.mockResolvedValue({ ...reminder(), dueAt: rescheduledDueAt });

    await generatePreventiveMaintenanceReminders({
      organizationId: "org-a",
      siteId: "site-a",
      leadDays: 7,
      now,
    });

    const occurrenceKey = maintenanceReminderOccurrenceKey({
      workOrderId: "wo-1",
      dueAt: rescheduledDueAt,
      leadDays: 7,
    });
    expect(mocks.reminderUpdateMany).toHaveBeenCalledWith({
      where: {
        siteId: "site-a",
        workOrderId: "wo-1",
        status: "ACTIVE",
        occurrenceKey: { not: occurrenceKey },
      },
      data: { status: "EXPIRED" },
    });
  });

  it("recovers a concurrent unique-key race as an existing reminder", async () => {
    const raced = reminder("reminder-raced");
    mocks.reminderFindUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(raced);
    mocks.reminderCreate.mockRejectedValueOnce(new Error("unique constraint"));

    const result = await generatePreventiveMaintenanceReminders({
      organizationId: "org-a",
      siteId: "site-a",
      leadDays: 7,
      now,
    });

    expect(result.created).toEqual([]);
    expect(result.existing).toEqual([{ id: "reminder-raced", workOrderId: "wo-1", dueAt }]);
  });

  it("expires past or closed-work reminders before generating new ones", async () => {
    mocks.reminderUpdateMany.mockResolvedValueOnce({ count: 2 }).mockResolvedValue({ count: 0 });

    const result = await generatePreventiveMaintenanceReminders({
      organizationId: "org-a",
      siteId: "site-a",
      now,
    });

    expect(result.expired).toBe(2);
    expect(mocks.reminderUpdateMany).toHaveBeenNthCalledWith(1, {
      where: {
        siteId: "site-a",
        status: "ACTIVE",
        OR: [
          { dueAt: { lt: now } },
          { workOrder: { status: { in: ["COMPLETED", "CANCELLED"] } } },
        ],
      },
      data: { status: "EXPIRED" },
    });
  });
});
