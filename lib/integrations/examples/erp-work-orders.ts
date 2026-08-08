import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import type { EncryptedConnectorCredentialVault } from "@/lib/integrations/credential-vault";
import {
  markIntegrationEventProcessed,
  recordIntegrationEvent,
} from "@/lib/integrations/event-log";
import type { RestConnector } from "@/lib/integrations/rest-connector";

const MAX_TEXT = 200;

export type ExampleErpWorkOrder = {
  id: string;
  number: string;
  title: string;
  status: string;
  type: string;
  priority: string;
  requestedAt: Date;
  dueAt?: Date | null;
  assetCode?: string | null;
};

export class ExampleErpConnectorError extends Error {
  constructor(
    public readonly code: "INVALID_INPUT" | "TENANT_SCOPE_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "ExampleErpConnectorError";
  }
}

function requireText(value: string, name: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_TEXT) {
    throw new ExampleErpConnectorError(
      "INVALID_INPUT",
      `${name} must contain between 1 and ${MAX_TEXT} characters`,
    );
  }
  return normalized;
}

function connectorScopedSourceId(connectorId: string, sourceId: string) {
  return createHash("sha256")
    .update(`${connectorId}\u0000${sourceId}`)
    .digest("hex");
}

function workOrderPayload(workOrder: ExampleErpWorkOrder) {
  return {
    id: requireText(workOrder.id, "workOrder.id"),
    number: requireText(workOrder.number, "workOrder.number"),
    title: requireText(workOrder.title, "workOrder.title"),
    status: requireText(workOrder.status, "workOrder.status"),
    type: requireText(workOrder.type, "workOrder.type"),
    priority: requireText(workOrder.priority, "workOrder.priority"),
    requestedAt: workOrder.requestedAt.toISOString(),
    dueAt: workOrder.dueAt?.toISOString() ?? null,
    assetCode: workOrder.assetCode?.trim() || null,
  };
}

/**
 * Provider-neutral ERP example.
 *
 * The configured ERP endpoint is expected to treat PUT by OpenGMAO work-order ID as an
 * upsert and to honor Idempotency-Key. Credentials are resolved from the tenant-scoped
 * connector vault immediately before transport and are never copied into the event/audit log.
 */
export async function pushWorkOrderToExampleErp(input: {
  organizationId: string;
  siteId: string;
  sourceId: string;
  connector: RestConnector;
  credentialVault: Pick<EncryptedConnectorCredentialVault, "resolve">;
  credentialId: string;
  workOrder: ExampleErpWorkOrder;
  occurredAt?: Date;
}) {
  const organizationId = requireText(input.organizationId, "organizationId");
  const siteId = requireText(input.siteId, "siteId");
  const sourceId = requireText(input.sourceId, "sourceId");
  const credentialId = requireText(input.credentialId, "credentialId");
  const connectorId = requireText(input.connector.definition.id, "connector.id");

  if (input.connector.definition.organizationId !== organizationId) {
    throw new ExampleErpConnectorError(
      "TENANT_SCOPE_MISMATCH",
      "ERP connector must belong to the requested organization",
    );
  }

  const maintenanceOrder = workOrderPayload(input.workOrder);
  const recorded = await recordIntegrationEvent({
    organizationId,
    siteId,
    direction: "OUTBOUND",
    channel: "erp-example",
    eventType: "work_order.upsert",
    sourceId: connectorScopedSourceId(connectorId, sourceId),
    correlationId: maintenanceOrder.id,
    causationId: sourceId,
    subjectType: "WorkOrder",
    subjectId: maintenanceOrder.id,
    occurredAt: input.occurredAt ?? input.workOrder.requestedAt,
    payload: {
      connectorId,
      workOrder: maintenanceOrder,
    },
  });

  const existingReceipt = await db.auditLog.findFirst({
    where: {
      entityType: "IntegrationConnectorDelivery",
      entityId: recorded.event.id,
      action: "DELIVERED",
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  if (existingReceipt) {
    await markIntegrationEventProcessed({ event: recorded.event });
    return {
      eventId: recorded.event.id,
      eventReplayed: recorded.replayed,
      delivered: true,
      alreadyDelivered: true,
      response: null,
    };
  }

  const credential = await input.credentialVault.resolve({
    organizationId,
    connectorId,
    credentialId,
  });

  const response = await input.connector.execute({
    context: {
      organizationId,
      siteId,
      correlationId: recorded.event.id,
    },
    credential,
    request: {
      method: "PUT",
      path: `maintenance-orders/${encodeURIComponent(maintenanceOrder.id)}`,
      headers: {
        "Idempotency-Key": recorded.event.id,
      },
      body: {
        sourceSystem: "OpenGMAO",
        sourceEventId: recorded.event.id,
        maintenanceOrder,
      },
    },
  });

  if (!response.ok) {
    return {
      eventId: recorded.event.id,
      eventReplayed: recorded.replayed,
      delivered: false,
      alreadyDelivered: false,
      response,
    };
  }

  await db.auditLog.create({
    data: {
      actorId: null,
      entityType: "IntegrationConnectorDelivery",
      entityId: recorded.event.id,
      action: "DELIVERED",
      afterJson: JSON.stringify({
        organizationId,
        siteId,
        connectorId,
        eventId: recorded.event.id,
        eventType: recorded.event.eventType,
        statusCode: response.status,
      }),
    },
  });
  await markIntegrationEventProcessed({ event: recorded.event });

  return {
    eventId: recorded.event.id,
    eventReplayed: recorded.replayed,
    delivered: true,
    alreadyDelivered: false,
    response,
  };
}
