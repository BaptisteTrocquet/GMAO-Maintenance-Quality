import { Prisma } from "@prisma/client";
import { z } from "zod";
import { apiData, apiError } from "@/lib/api-response";
import { assertPermission, AccessDeniedError } from "@/lib/access-control";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { db } from "@/lib/db";
import { createDocumentRevision, DocumentControlError } from "@/lib/documents/control";

const createSchema = z.object({
  organizationId: z.string().min(1),
  revision: z.string().trim().min(1).max(40),
  changeSummary: z.string().max(5000).nullable().optional(),
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
    select: { id: true },
  });
  if (!document) return apiError(404, "DOCUMENT_NOT_FOUND", "Document not found");

  return apiData(
    await db.documentRevision.findMany({
      where: { documentId },
      include: { approvals: true },
      orderBy: { createdAt: "desc" },
    }),
  );
}

export async function POST(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid revision payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, "document:manage");
  if (denied) return denied;

  const { documentId } = await context.params;
  try {
    const revision = await createDocumentRevision({
      ...parsed.data,
      documentId,
      actorId: auth.session.user.id,
    });
    return apiData(revision, { status: 201 });
  } catch (error) {
    if (error instanceof DocumentControlError && error.code === "DOCUMENT_NOT_FOUND") {
      return apiError(404, error.code, error.message);
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return apiError(409, "REVISION_EXISTS", "Revision already exists for this document");
    }
    throw error;
  }
}
