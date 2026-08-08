import { z } from "zod";
import { AccessDeniedError } from "@/lib/access-control";
import { AiAuditError } from "@/lib/ai/audit";
import { AssetContextAssistantError } from "@/lib/ai/asset-context-assistant";
import {
  AiRuntimeConfigurationError,
  createServerAssetContextAssistant,
} from "@/lib/ai/server-runtime";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";

const requestSchema = z
  .object({
    organizationId: z.string().min(1).max(200),
    siteId: z.string().min(1).max(200),
    question: z.string().min(1).max(4_000),
  })
  .strict();

function safeAiError(error: unknown) {
  if (error instanceof AccessDeniedError) {
    return apiError(403, "ACCESS_DENIED", "Access denied");
  }

  if (error instanceof AssetContextAssistantError) {
    if (error.code === "INVALID_REQUEST") {
      return apiError(400, "INVALID_REQUEST", "Invalid asset assistant request");
    }
    if (error.code === "ASSET_NOT_FOUND") {
      return apiError(404, "ASSET_NOT_FOUND", "Asset not found");
    }
    return apiError(500, "AI_CONTEXT_INVALID", "AI asset context could not be validated");
  }

  if (error instanceof AiAuditError) {
    return apiError(500, "AI_AUDIT_FAILED", "AI assistant audit could not be persisted");
  }

  if (error instanceof AiRuntimeConfigurationError) {
    return apiError(503, "AI_RUNTIME_MISCONFIGURED", "AI runtime is not configured correctly");
  }

  return apiError(500, "AI_ASSISTANT_FAILED", "AI assistant request failed");
}

export async function POST(request: Request, context: { params: Promise<{ assetId: string }> }) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return apiError(400, "INVALID_PAYLOAD", "Invalid AI assistant payload");
  }

  const parsed = requestSchema.safeParse(payload);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid AI assistant payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) {
    return auth.error ?? apiError(500, "AUTHENTICATION_FAILED", "Authentication could not be completed");
  }

  const { assetId } = await context.params;

  try {
    // Provider/model configuration remains server-owned. The feature service performs
    // asset/work authorization before repository access or model invocation.
    const assistant = createServerAssetContextAssistant();
    const result = await assistant.ask({
      authorization: {
        organizationId: parsed.data.organizationId,
        siteId: parsed.data.siteId,
        actorId: auth.session.user.id,
        scope: auth.tenant.scope,
      },
      assetId,
      question: parsed.data.question,
    });

    return apiData(result);
  } catch (error) {
    return safeAiError(error);
  }
}
