import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { PATCH as patchExecution } from "@/app/api/work-orders/[workOrderId]/execution/route";
import { PATCH as patchWorkOrder } from "@/app/api/work-orders/[workOrderId]/route";
import { createSession } from "@/lib/auth/session";
import { db } from "@/lib/db";

const cleanupSessions: string[] = [];

afterEach(async () => {
  if (cleanupSessions.length) {
    await db.session.deleteMany({ where: { id: { in: cleanupSessions.splice(0) } } });
  }
});

function request(url: string, token: string, key: string, body: Record<string, unknown>) {
  return new Request(`http://localhost${url}`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify(body),
  });
}

function definedResponse(response: Response | undefined): Response {
  expect(response).toBeDefined();
  if (!response) throw new Error("Expected route to return a response");
  return response;
}

async function responseErrorCode(response: Response) {
  const body = (await response.json()) as { error?: { code?: string } };
  return body.error?.code;
}

describe("work-order retry idempotency", () => {
  it("applies retried execution and status mutations once and rejects key reuse", async () => {
    const technician = await db.user.findUnique({ where: { email: "technician@example.local" } });
    const workOrder = await db.workOrder.findUnique({
      where: { number: "WO-000001" },
      include: { site: true },
    });
    expect(technician).not.toBeNull();
    expect(workOrder).not.toBeNull();
    if (!technician || !workOrder) return;

    const original = {
      status: workOrder.status,
      assigneeId: workOrder.assigneeId,
      laborMinutes: workOrder.laborMinutes,
      downtimeMinutes: workOrder.downtimeMinutes,
      completionNote: workOrder.completionNote,
      startedAt: workOrder.startedAt,
      completedAt: workOrder.completedAt,
    };
    const testStartedAt = new Date();
    const session = await createSession(technician.id);
    cleanupSessions.push(session.id);

    try {
      await db.workOrder.update({
        where: { id: workOrder.id },
        data: {
          status: "IN_PROGRESS",
          assigneeId: technician.id,
          startedAt: workOrder.startedAt ?? new Date(),
          completedAt: null,
        },
      });

      const scope = {
        organizationId: workOrder.site.organizationId,
        siteId: workOrder.siteId,
      };
      const params = { params: Promise.resolve({ workOrderId: workOrder.id }) };
      const executionKey = `retry-execution-${randomUUID()}`;
      const executionBody = {
        ...scope,
        laborMinutes: (workOrder.laborMinutes ?? 0) + 17,
      };
      const auditsBeforeExecution = await db.auditLog.count({
        where: { actorId: technician.id, entityType: "WorkOrder", entityId: workOrder.id },
      });

      const firstExecution = definedResponse(await patchExecution(
        request(`/api/work-orders/${workOrder.id}/execution`, session.token, executionKey, executionBody),
        params,
      ));
      expect(firstExecution.status).toBe(200);
      expect(firstExecution.headers.get("x-opengmao-idempotent-replay")).toBe("false");

      const retriedExecution = definedResponse(await patchExecution(
        request(`/api/work-orders/${workOrder.id}/execution`, session.token, executionKey, executionBody),
        params,
      ));
      expect(retriedExecution.status).toBe(200);
      expect(retriedExecution.headers.get("x-opengmao-idempotent-replay")).toBe("true");

      const afterExecution = await db.workOrder.findUnique({ where: { id: workOrder.id } });
      expect(afterExecution?.laborMinutes).toBe(executionBody.laborMinutes);
      const auditsAfterExecution = await db.auditLog.count({
        where: { actorId: technician.id, entityType: "WorkOrder", entityId: workOrder.id },
      });
      expect(auditsAfterExecution - auditsBeforeExecution).toBe(1);

      const reusedExecutionKey = definedResponse(await patchExecution(
        request(`/api/work-orders/${workOrder.id}/execution`, session.token, executionKey, {
          ...executionBody,
          laborMinutes: executionBody.laborMinutes + 1,
        }),
        params,
      ));
      expect(reusedExecutionKey.status).toBe(409);
      expect(await responseErrorCode(reusedExecutionKey)).toBe("IDEMPOTENCY_KEY_REUSED");
      expect(
        await db.auditLog.count({
          where: { actorId: technician.id, entityType: "WorkOrder", entityId: workOrder.id },
        }),
      ).toBe(auditsAfterExecution);

      const transitionKey = `retry-transition-${randomUUID()}`;
      const transitionBody = { ...scope, status: "BLOCKED" };
      const firstTransition = definedResponse(await patchWorkOrder(
        request(`/api/work-orders/${workOrder.id}`, session.token, transitionKey, transitionBody),
        params,
      ));
      expect(firstTransition.status).toBe(200);
      expect(firstTransition.headers.get("x-opengmao-idempotent-replay")).toBe("false");

      const retriedTransition = definedResponse(await patchWorkOrder(
        request(`/api/work-orders/${workOrder.id}`, session.token, transitionKey, transitionBody),
        params,
      ));
      expect(retriedTransition.status).toBe(200);
      expect(retriedTransition.headers.get("x-opengmao-idempotent-replay")).toBe("true");
      expect((await db.workOrder.findUnique({ where: { id: workOrder.id } }))?.status).toBe("BLOCKED");
      expect(
        await db.auditLog.count({
          where: { actorId: technician.id, entityType: "WorkOrder", entityId: workOrder.id },
        }),
      ).toBe(auditsAfterExecution + 1);
    } finally {
      await db.workOrder.update({
        where: { id: workOrder.id },
        data: original,
      });
      await db.auditLog.deleteMany({
        where: {
          actorId: technician.id,
          entityType: "WorkOrder",
          entityId: workOrder.id,
          createdAt: { gte: testStartedAt },
        },
      });
    }
  });
});
