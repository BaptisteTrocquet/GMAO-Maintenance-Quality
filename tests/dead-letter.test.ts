import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  siteFindFirst: vi.fn(),
  organizationFindFirst: vi.fn(),
  deadLetterUpsert: vi.fn(),
  deadLetterFindMany: vi.fn(),
  deadLetterFindFirst: vi.fn(),
  deadLetterUpdate: vi.fn(),
  auditCreate: vi.fn(),
}));

const tx = {
  site: { findFirst: mocks.siteFindFirst },
  organization: { findFirst: mocks.organizationFindFirst },
  integrationDeadLetter: {
    upsert: mocks.deadLetterUpsert,
    findMany: mocks.deadLetterFindMany,
    findFirst: mocks.deadLetterFindFirst,
    update: mocks.deadLetterUpdate,
  },
  auditLog: { create: mocks.auditCreate },
};

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: mocks.transaction,
    site: { findFirst: mocks.siteFindFirst },
    organization: { findFirst: mocks.organizationFindFirst },
    integrationDeadLetter: {
      findMany: mocks.deadLetterFindMany,
      findFirst: mocks.deadLetterFindFirst,
    },
  },
}));

import {
  listOpenIntegrationDeadLetters,
  recordIntegrationDeadLetter,
  resolveIntegrationDeadLetter,
} from "@/lib/integrations/dead-letter";

const now = new Date("2026-08-08T09:20:00.000Z");
const stored = {
  id: "dlq-1",
  organizationId: "org-a",
  siteId: "site-a",
  channel: "webhook",
  sourceId: "delivery-1",
  reason: "attempt_limit",
  attempts: 5,
  statusCode: 503,
  errorCode: "HTTP_DELIVERY_ERROR",
  payloadJson: '{"event":{"id":"event-1"}}',
  replayCount: 0,
  lastReplayedAt: null,
  resolvedAt: null,
  createdAt: now,
  updatedAt: now,
};

describe("integration dead-letter persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(async (callback) => callback(tx));
    mocks.siteFindFirst.mockResolvedValue({ id: "site-a" });
    mocks.organizationFindFirst.mockResolvedValue({ id: "org-a" });
    mocks.deadLetterUpsert.mockResolvedValue(stored);
    mocks.deadLetterFindMany.mockResolvedValue([stored]);
    mocks.deadLetterFindFirst.mockResolvedValue(stored);
    mocks.deadLetterUpdate.mockResolvedValue({ ...stored, resolvedAt: now });
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("upserts one tenant-scoped dead letter and audits metadata without the replay payload", async () => {
    const result = await recordIntegrationDeadLetter({
      organizationId: "org-a",
      siteId: "site-a",
      channel: "webhook",
      sourceId: "delivery-1",
      reason: "attempt_limit",
      attempts: 5,
      statusCode: 503,
      errorCode: "HTTP_DELIVERY_ERROR",
      payload: { subscriptionId: "sub-1", event: { id: "event-1", data: { title: "Pump" } } },
      now,
    });

    expect(result.id).toBe("dlq-1");
    expect(mocks.siteFindFirst).toHaveBeenCalledWith({
      where: {
        id: "site-a",
        organizationId: "org-a",
        active: true,
        organization: { active: true },
      },
      select: { id: true },
    });
    expect(mocks.deadLetterUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId_channel_sourceId: {
            organizationId: "org-a",
            channel: "webhook",
            sourceId: "delivery-1",
          },
        },
        create: expect.objectContaining({
          organizationId: "org-a",
          siteId: "site-a",
          payloadJson: expect.stringContaining('"subscriptionId":"sub-1"'),
        }),
      }),
    );
    const audit = mocks.auditCreate.mock.calls[0]?.[0];
    expect(audit.data.action).toBe("DEAD_LETTERED");
    expect(audit.data.afterJson).not.toContain("Pump");
    expect(audit.data.afterJson).not.toContain("subscriptionId");
  });

  it("rejects credential-like replay payloads before touching persistence", async () => {
    await expect(
      recordIntegrationDeadLetter({
        organizationId: "org-a",
        siteId: "site-a",
        channel: "rest",
        sourceId: "request-1",
        reason: "permanent",
        attempts: 1,
        payload: { request: { headers: { Authorization: "Bearer secret-value" } } },
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_PAYLOAD" });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("fails closed when a site does not belong to the requested organization", async () => {
    mocks.siteFindFirst.mockResolvedValue(null);

    await expect(
      recordIntegrationDeadLetter({
        organizationId: "org-a",
        siteId: "site-b",
        channel: "webhook",
        sourceId: "delivery-1",
        reason: "permanent",
        attempts: 1,
        payload: { event: { id: "event-1" } },
      }),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_MISMATCH" });
    expect(mocks.deadLetterUpsert).not.toHaveBeenCalled();
  });

  it("lists only unresolved records inside the requested tenant/channel scope without payloads", async () => {
    const result = await listOpenIntegrationDeadLetters({
      organizationId: "org-a",
      siteId: "site-a",
      channel: "webhook",
      limit: 25,
    });

    expect(result).toEqual([
      expect.objectContaining({ id: "dlq-1", organizationId: "org-a", siteId: "site-a" }),
    ]);
    expect(result[0]).not.toHaveProperty("payloadJson");
    expect(mocks.deadLetterFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: "org-a",
          siteId: "site-a",
          channel: "webhook",
          resolvedAt: null,
        },
        take: 25,
      }),
    );
  });

  it("resolves an open dead letter idempotently and records a safe audit event", async () => {
    const result = await resolveIntegrationDeadLetter({
      organizationId: "org-a",
      channel: "webhook",
      sourceId: "delivery-1",
      now,
    });

    expect(result?.resolvedAt).toEqual(now);
    expect(mocks.deadLetterUpdate).toHaveBeenCalledWith({
      where: { id: "dlq-1" },
      data: { resolvedAt: now },
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "RESOLVED", entityId: "dlq-1" }),
    });

    mocks.deadLetterFindFirst.mockResolvedValueOnce(null);
    await expect(
      resolveIntegrationDeadLetter({
        organizationId: "org-a",
        channel: "webhook",
        sourceId: "delivery-1",
        now,
      }),
    ).resolves.toBeNull();
  });
});
