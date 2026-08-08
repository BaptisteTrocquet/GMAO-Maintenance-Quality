import { z } from "zod";
import { AccessDeniedError } from "@/lib/access-control";
import { AiAuditError } from "@/lib/ai/audit";
import {
  AiRuntimeConfigurationError,
  createServerWorkOrderSummarizer,
} from "@/lib/ai/server-runtime";
import { WorkOrderSummarizationError } from "@/lib/ai/work-order-summarization";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";

const requestSchema = z
  .object({
    organizationId: z.string().min(1).max(200),
    siteId: z.string().min(1).max(200),
  })
  .strict();

function safeAiError(error: unknown) {
  if (error instanceof AccessDeniedError) {
    return apiError(403, "ACCESS_DENIED", "Access denied");
  }

  if (error instanceof WorkOrderSummarizationError) {
    if (error.code === "INVALID_REQUEST") {
      return apiError(400, "INVALID_REQUEST", "Invalid Work Order summary request");
    }
    if (error.code === "WORK_ORDER_NOT_FOUND") {
      return apiError(404, "WORK_ORDER_NOT_FOUND", "Work Order not found");
    }
    return apiError(500, "AI_CONTEXT_INVALID", "AI summary context could not be validated");
  }

  if (error instanceof AiAuditError) {
    return apiError(500, "AI_AUDIT_FAILED", "AI summary audit could not be persisted");
  }

  if (error instanceof AiRuntimeConfigurationError) {
    return apiError(503, "AI_RUNTIME_MISCONFIGURED", "AI runtime is not configured correctly");
  }

  return apiError(500, "AI_SUMMARY_FAILED", "AI summary request failed");
}

export async function POST(
  request: Request,
  context: { params: Promise<{ workOrderId: string }> },
) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return apiError(400, "INVALID_PAYLOAD", "Invalid AI summary payload");
  }

  const parsed = requestSchema.safeParse(payload);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid AI summary payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;

  const { workOrderId } = await context.params;

  try {
    // Compose the provider only after request authentication succeeded. The feature service
    // remains responsible for work/asset permission checks before repository/model access.
    const summarizer = createServerWorkOrderSummarizer();
    const result = await summarizer.summarize({
      authorization: {
        organizationId: parsed.data.organizationId,
        siteId: parsed.data.siteId,
        actorId: auth.session.user.id,
        scope: auth.tenant.scope,
      },
      workOrderId,
    });

    return apiData(result);
  } catch (error) {
    return safeAiError(error);
  }
}
