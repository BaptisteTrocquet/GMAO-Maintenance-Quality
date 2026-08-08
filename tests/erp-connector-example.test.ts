import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recordEvent: vi.fn(),
  markProcessed: vi.fn(),
  receiptFindFirst: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock("@/lib/integrations/event-log", () => ({
  recordIntegrationEvent: mocks.recordEvent,
  markIntegrationEventProcessed: mocks.markProcessed,
}));
vi.mock("@/lib/db", () => ({
  db: {
    auditLog: {
      findFirst: mocks.receiptFindFirst,
      create: mocks.auditCreate,
    },
  },
}));

import {
  ExampleErpConnectorError,
  pushWorkOrderToExampleErp,
} from "@/lib/integrations/examples/erp-work-orders";

const event = {
  version: 1 as const,
  id: "e".repeat(64),
  organizationId: "org-a",
  siteId: "site-a",
  direction: "OUTBOUND" as const,
  channel: "erp-example",
  eventType: "work_order.upsert",
  sourceId: "s".repeat(64),
  correlationId: "wo-1",
  causationId: "audit-wo-1",
  subjectType: "WorkOrder",
  subjectId: "wo-1",
  occurredAt: "2026-08-08T10:00:00.000Z",
  payloadHash: "f".repeat(64),
  payload: { connectorId: "erp-primary", workOrder: { id: "wo-1" } },
};

const workOrder = {
  id: "wo-1",
  number: "WO-000001",
  title: "Repair pump seal",
  status: "APPROVED",
  type: "CORRECTIVE",
  priority: "HIGH",
  requestedAt: new Date("2026-08-08T10:00:00.000Z"),
  dueAt: new Date("2026-08-09T10:00:00.000Z"),
  assetCode: "PUMP-100",
};

function setup() {
  const connector = {
    definition: {
      id: "erp-primary",
      organizationId: "org-a",
      name: "Example ERP",
      baseUrl: "https://erp.example.test/api/",
    },
    execute: vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { "content-type": "application/json" },
      data: { externalId: "ERP-MO-1" },
    }),
  };
  const credentialVault = {
    resolve: vi.fn().mockResolvedValue({
      kind: "bearer",
      organizationId: "org-a",
      token: "vault-only-secret",
    }),
  };
  return { connector, credentialVault };
}

describe("ERP connector example", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.recordEvent.mockResolvedValue({ event, replayed: false });
    mocks.markProcessed.mockResolvedValue({ processed: true });
    mocks.receiptFindFirst.mockResolvedValue(null);
    mocks.auditCreate.mockResolvedValue({ id: "delivery-receipt" });
  });

  it("uses event identity, tenant vault credentials and an idempotent ERP PUT", async () => {
    const { connector, credentialVault } = setup();

    const result = await pushWorkOrderToExampleErp({
      organizationId: "org-a",
      siteId: "site-a",
      sourceId: "audit-wo-1",
      connector: connector as never,
      credentialVault,
      credentialId: "cred-erp",
      workOrder,
    });

    expect(result.delivered).toBe(true);
    expect(result.alreadyDelivered).toBe(false);
    expect(mocks.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-a",
        siteId: "site-a",
        direction: "OUTBOUND",
        channel: "erp-example",
        eventType: "work_order.upsert",
        sourceId: expect.stringMatching(/^[a-f0-9]{64}$/),
        causationId: "audit-wo-1",
        subjectId: "wo-1",
      }),
    );
    expect(credentialVault.resolve).toHaveBeenCalledWith({
      organizationId: "org-a",
      connectorId: "erp-primary",
      credentialId: "cred-erp",
    });
    expect(connector.execute).toHaveBeenCalledWith({
      context: {
        organizationId: "org-a",
        siteId: "site-a",
        correlationId: event.id,
      },
      credential: {
        kind: "bearer",
        organizationId: "org-a",
        token: "vault-only-secret",
      },
      request: {
        method: "PUT",
        path: "maintenance-orders/wo-1",
        headers: { "Idempotency-Key": event.id },
        body: expect.objectContaining({
          sourceSystem: "OpenGMAO",
          sourceEventId: event.id,
          maintenanceOrder: expect.objectContaining({
            id: "wo-1",
            number: "WO-000001",
            assetCode: "PUMP-100",
          }),
        }),
      },
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityType: "IntegrationConnectorDelivery",
        entityId: event.id,
        action: "DELIVERED",
        afterJson: expect.stringContaining('"connectorId":"erp-primary"'),
      }),
    });
    expect(JSON.stringify(mocks.auditCreate.mock.calls)).not.toContain("vault-only-secret");
    expect(mocks.markProcessed).toHaveBeenCalledWith({ event });
  });

  it("skips transport when a durable delivery receipt already exists", async () => {
    const { connector, credentialVault } = setup();
    mocks.recordEvent.mockResolvedValue({ event, replayed: true });
    mocks.receiptFindFirst.mockResolvedValue({ id: "receipt-existing" });

    const result = await pushWorkOrderToExampleErp({
      organizationId: "org-a",
      siteId: "site-a",
      sourceId: "audit-wo-1",
      connector: connector as never,
      credentialVault,
      credentialId: "cred-erp",
      workOrder,
    });

    expect(result).toMatchObject({
      delivered: true,
      alreadyDelivered: true,
      eventReplayed: true,
      response: null,
    });
    expect(credentialVault.resolve).not.toHaveBeenCalled();
    expect(connector.execute).not.toHaveBeenCalled();
    expect(mocks.markProcessed).toHaveBeenCalledWith({ event });
  });

  it("leaves a non-successful ERP event pending for retry/dead-letter handling", async () => {
    const { connector, credentialVault } = setup();
    connector.execute.mockResolvedValue({
      ok: false,
      status: 503,
      headers: { "retry-after": "60" },
      data: { error: "temporarily unavailable" },
    });

    const result = await pushWorkOrderToExampleErp({
      organizationId: "org-a",
      siteId: "site-a",
      sourceId: "audit-wo-1",
      connector: connector as never,
      credentialVault,
      credentialId: "cred-erp",
      workOrder,
    });

    expect(result.delivered).toBe(false);
    expect(result.response?.status).toBe(503);
    expect(mocks.auditCreate).not.toHaveBeenCalled();
    expect(mocks.markProcessed).not.toHaveBeenCalled();
  });

  it("rejects a connector from another organization before recording an event", async () => {
    const { connector, credentialVault } = setup();
    connector.definition.organizationId = "org-b";

    await expect(
      pushWorkOrderToExampleErp({
        organizationId: "org-a",
        siteId: "site-a",
        sourceId: "audit-wo-1",
        connector: connector as never,
        credentialVault,
        credentialId: "cred-erp",
        workOrder,
      }),
    ).rejects.toBeInstanceOf(ExampleErpConnectorError);
    expect(mocks.recordEvent).not.toHaveBeenCalled();
    expect(credentialVault.resolve).not.toHaveBeenCalled();
  });
});
