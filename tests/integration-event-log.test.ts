import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  txRaw: vi.fn(),
  dbRaw: vi.fn(),
  siteFindFirst: vi.fn(),
  organizationFindFirst: vi.fn(),
  auditCreate: vi.fn(),
  auditFindFirst: vi.fn(),
}));

const tx = {
  $queryRaw: mocks.txRaw,
  site: { findFirst: mocks.siteFindFirst },
  organization: { findFirst: mocks.organizationFindFirst },
  auditLog: { create: mocks.auditCreate, findFirst: mocks.auditFindFirst },
};

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: mocks.transaction,
    $queryRaw: mocks.dbRaw,
    site: { findFirst: mocks.siteFindFirst },
    organization: { findFirst: mocks.organizationFindFirst },
    auditLog: { create: mocks.auditCreate, findFirst: mocks.auditFindFirst },
  },
}));

import {
  IntegrationEventLogError,
  listPendingIntegrationEvents,
  markIntegrationEventProcessed,
  recordIntegrationEvent,
  recordIntegrationEventInTransaction,
} from "@/lib/integrations/event-log";

const occurredAt = new Date("2026-08-08T09:30:00.000Z");
const baseInput = {
  organizationId: "org-a",
  siteId: "site-a",
  direction: "OUTBOUND" as const,
  channel: "webhook",
  eventType: "work_order.created",
  sourceId: "audit-work-order-1",
  correlationId: "wo-1",
  subjectType: "WorkOrder",
  subjectId: "wo-1",
  occurredAt,
  payload: {
    workOrder: {
      id: "wo-1",
      number: "WO-000001",
      status: "REQUESTED",
    },
  },
};

function recordedJson() {
  return mocks.auditCreate.mock.calls[0]?.[0]?.data?.afterJson as string;
}

describe("integration event log", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(async (callback) => callback(tx));
    mocks.siteFindFirst.mockResolvedValue({ id: "site-a" });
    mocks.organizationFindFirst.mockResolvedValue({ id: "org-a" });
    mocks.auditCreate.mockResolvedValue({ id: "audit-event-state" });
    mocks.auditFindFirst.mockResolvedValue(null);
    mocks.txRaw.mockReset();
    mocks.dbRaw.mockReset();
  });

  it("records one tenant-scoped outbound event with deterministic identity and safe payload", async () => {
    mocks.txRaw.mockResolvedValueOnce([{ lock: "" }]).mockResolvedValueOnce([]);

    const result = await recordIntegrationEvent(baseInput);

    expect(result.replayed).toBe(false);
    expect(result.event.id).toMatch(/^[a-f0-9]{64}$/);
    expect(result.event.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(mocks.siteFindFirst).toHaveBeenCalledWith({
      where: {
        id: "site-a",
        organizationId: "org-a",
        active: true,
        organization: { active: true },
      },
      select: { id: true },
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityType: "IntegrationEvent",
        entityId: result.event.id,
        action: "RECORDED",
      }),
    });
    const stored = JSON.parse(recordedJson());
    expect(stored).toMatchObject({
      organizationId: "org-a",
      siteId: "site-a",
      direction: "OUTBOUND",
      channel: "webhook",
      eventType: "work_order.created",
      sourceId: "audit-work-order-1",
      subjectId: "wo-1",
    });
  });

  it("replays the same source identity without appending a duplicate event", async () => {
    mocks.txRaw.mockResolvedValueOnce([{ lock: "" }]).mockResolvedValueOnce([]);
    const first = await recordIntegrationEvent(baseInput);
    const existing = recordedJson();

    mocks.txRaw.mockReset();
    mocks.txRaw
      .mockResolvedValueOnce([{ lock: "" }])
      .mockResolvedValueOnce([{ afterJson: existing }]);
    const second = await recordIntegrationEvent(baseInput);

    expect(first.event.id).toBe(second.event.id);
    expect(second.replayed).toBe(true);
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
  });

  it("rejects reusing an event identity for different content", async () => {
    mocks.txRaw.mockResolvedValueOnce([{ lock: "" }]).mockResolvedValueOnce([]);
    await recordIntegrationEvent(baseInput);
    const existing = recordedJson();

    mocks.txRaw.mockReset();
    mocks.txRaw
      .mockResolvedValueOnce([{ lock: "" }])
      .mockResolvedValueOnce([{ afterJson: existing }]);

    await expect(
      recordIntegrationEvent({
        ...baseInput,
        payload: { workOrder: { id: "wo-1", number: "CHANGED" } },
      }),
    ).rejects.toMatchObject({ code: "EVENT_IDENTITY_CONFLICT" });
  });

  it("supports idempotent inbound identities and rejects secret-like payload fields", async () => {
    await expect(
      recordIntegrationEventInTransaction(tx as never, {
        organizationId: "org-a",
        siteId: "site-a",
        direction: "INBOUND",
        channel: "erp",
        eventType: "asset.updated",
        sourceId: "erp-event-123",
        payload: { headers: { Authorization: "Bearer must-not-persist" } },
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_PAYLOAD" });
    expect(mocks.txRaw).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("fails closed before recording when site scope belongs to another organization", async () => {
    mocks.siteFindFirst.mockResolvedValue(null);

    await expect(recordIntegrationEvent(baseInput)).rejects.toMatchObject({
      code: "TENANT_SCOPE_MISMATCH",
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("lists only pending events returned by the latest-state query", async () => {
    mocks.txRaw.mockResolvedValueOnce([{ lock: "" }]).mockResolvedValueOnce([]);
    const recorded = await recordIntegrationEvent(baseInput);
    mocks.dbRaw.mockResolvedValue([{ afterJson: recordedJson() }]);

    const pending = await listPendingIntegrationEvents({
      direction: "OUTBOUND",
      channel: "webhook",
      eventType: "work_order.created",
      limit: 25,
    });

    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe(recorded.event.id);
    expect(pending[0]?.payload).toEqual(baseInput.payload);
  });

  it("marks processing by appending state without duplicating an already processed event", async () => {
    mocks.txRaw.mockResolvedValueOnce([{ lock: "" }]).mockResolvedValueOnce([]);
    const recorded = await recordIntegrationEvent(baseInput);
    mocks.auditCreate.mockClear();
    mocks.txRaw.mockReset();
    mocks.txRaw.mockResolvedValue([{ lock: "" }]);
    mocks.auditFindFirst.mockResolvedValue({
      id: "state-recorded",
      entityType: "IntegrationEvent",
      entityId: recorded.event.id,
      action: "RECORDED",
      afterJson: JSON.stringify(recorded.event),
      createdAt: occurredAt,
    });

    await expect(
      markIntegrationEventProcessed({ event: recorded.event, processedAt: occurredAt }),
    ).resolves.toEqual({ processed: true });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityType: "IntegrationEvent",
        entityId: recorded.event.id,
        action: "PROCESSED",
      }),
    });

    mocks.auditCreate.mockClear();
    mocks.auditFindFirst.mockResolvedValue({
      id: "state-processed",
      entityType: "IntegrationEvent",
      entityId: recorded.event.id,
      action: "PROCESSED",
      afterJson: "{}",
      createdAt: occurredAt,
    });
    await expect(markIntegrationEventProcessed({ event: recorded.event })).resolves.toEqual({
      processed: false,
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("exposes stable typed errors rather than upstream payload content", () => {
    const error = new IntegrationEventLogError("INVALID_EVENT", "Integration event is invalid");
    expect(error.name).toBe("IntegrationEventLogError");
    expect(error.message).not.toContain("Bearer");
  });
});
