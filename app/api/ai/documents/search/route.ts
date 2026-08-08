import { z } from "zod";
import { AccessDeniedError } from "@/lib/access-control";
import { ControlledDocumentSearchError } from "@/lib/ai/controlled-document-search";
import {
  AiRuntimeConfigurationError,
  createServerControlledDocumentSemanticSearch,
} from "@/lib/ai/server-runtime";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";

const requestSchema = z
  .object({
    organizationId: z.string().min(1).max(200),
    query: z.string().min(1).max(4_000),
    limit: z.number().int().min(1).max(25).optional(),
  })
  .strict();

function safeSearchError(error: unknown) {
  if (error instanceof AccessDeniedError) {
    return apiError(403, "ACCESS_DENIED", "Access denied");
  }

  if (error instanceof ControlledDocumentSearchError) {
    if (error.code === "INVALID_REQUEST") {
      return apiError(400, "INVALID_REQUEST", "Invalid semantic search request");
    }
    return apiError(500, "AI_SEARCH_CONTEXT_INVALID", "Semantic search context could not be validated");
  }

  if (error instanceof AiRuntimeConfigurationError) {
    return apiError(503, "AI_RUNTIME_MISCONFIGURED", "AI runtime is not configured correctly");
  }

  return apiError(500, "AI_SEARCH_FAILED", "Semantic search request failed");
}

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return apiError(400, "INVALID_PAYLOAD", "Invalid semantic search payload");
  }

  const parsed = requestSchema.safeParse(payload);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid semantic search payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) {
    return auth.error ?? apiError(500, "AUTHENTICATION_FAILED", "Authentication could not be completed");
  }

  try {
    // Embedding provider/model/dimensions and vector-store configuration remain server-owned.
    // The domain service performs document:read authorization before embedding/vector/database access.
    const semanticSearch = createServerControlledDocumentSemanticSearch();
    const result = await semanticSearch.search({
      authorization: {
        organizationId: parsed.data.organizationId,
        actorId: auth.session.user.id,
        scope: auth.tenant.scope,
      },
      query: parsed.data.query,
      limit: parsed.data.limit,
    });

    return apiData(result);
  } catch (error) {
    return safeSearchError(error);
  }
}
