import { z } from "zod";
import { apiData, apiError } from "@/lib/api-response";
import { assertPermission, AccessDeniedError } from "@/lib/access-control";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { db } from "@/lib/db";
import { DocumentControlError, updateDocumentMaster } from "@/lib/documents/control";

const updateSchema = z.object({
  organizationId: z.string().min(1),
  title: z.string().trim().min(1).max(240).optional(),
  type: z.string().trim().min(1).max(80).optional(),
  owner: z.string().trim().max(200).nullable().optional(),
  description: z.string().max(5000).nullable().optional(),
});

function authorize(
  scope: Parameters<typeof assertPermission>[0],
  permission: "document:read" | "document:manage",
) {
  try {
    assertPermission(scope, permission);
    return null;
  } catch (error) {
    if (error instanceof AccessDeniedError) return apiError(403, "ACCESS_DENIED", error.message);
    throw error;
  }
}

export async function GET(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  const organizationId = new URL(request.url).searchParams.get("organizationId");
  if (!organizationId) return apiError(400, "INVALID_SCOPE", "organizationId is required");

  const auth = await authenticateRequest(request, organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, "document:read");
  if (denied) return denied;

  const { documentId } = await context.params;
  const document = await db.document.findFirst({
    where: { id: documentId, organizationId },
    include: {
      revisions: {
        orderBy: { createdAt: "desc" },
        include: { approvals: true },
      },
      assetDocuments: {
        where: { asset: { site: { organizationId } } },
        include: { asset: { include: { site: true } } },
      },
    },
  });
  if (!document) return apiError(404, "DOCUMENT_NOT_FOUND", "Document not found");
  return apiData(document);
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid document metadata update", parsed.error.flatten());
  }

  const changeFields = ["title", "type", "owner", "description"] as const;
  if (!changeFields.some((field) => Object.prototype.hasOwnProperty.call(parsed.data, field))) {
    return apiError(400, "NO_CHANGES", "At least one document metadata field must change");
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, "document:manage");
  if (denied) return denied;

  const { documentId } = await context.params;
  try {
    const updated = await updateDocumentMaster({
      ...parsed.data,
      documentId,
      actorId: auth.session.user.id,
    });
    return apiData(updated);
  } catch (error) {
    if (error instanceof DocumentControlError && error.code === "DOCUMENT_NOT_FOUND") {
      return apiError(404, error.code, error.message);
    }
    throw error;
  }
}
