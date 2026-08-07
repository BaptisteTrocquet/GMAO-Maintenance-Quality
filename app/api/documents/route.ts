import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { apiData, apiError } from "@/lib/api-response";
import { assertPermission, AccessDeniedError } from "@/lib/access-control";
import { authenticateRequest } from "@/lib/auth/request-auth";

const createSchema = z.object({
  organizationId: z.string().min(1),
  code: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(240),
  type: z.string().trim().min(1).max(80),
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
    if (error instanceof AccessDeniedError) {
      return apiError(403, "ACCESS_DENIED", error.message);
    }
    throw error;
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const organizationId = url.searchParams.get("organizationId");
  if (!organizationId) {
    return apiError(400, "INVALID_SCOPE", "organizationId is required");
  }

  const auth = await authenticateRequest(request, organizationId);
  if ("error" in auth) return auth.error;

  const denied = authorize(auth.tenant.scope, "document:read");
  if (denied) return denied;

  const q = url.searchParams.get("q")?.trim();
  const type = url.searchParams.get("type")?.trim();
  const owner = url.searchParams.get("owner")?.trim();

  return apiData(
    await db.document.findMany({
      where: {
        organizationId,
        ...(type ? { type } : {}),
        ...(owner ? { owner } : {}),
        ...(q
          ? {
              OR: [
                { code: { contains: q, mode: "insensitive" } },
                { title: { contains: q, mode: "insensitive" } },
                { description: { contains: q, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      include: {
        revisions: { orderBy: { createdAt: "desc" } },
        assetDocuments: {
          where: { asset: { site: { organizationId } } },
          include: { asset: true },
        },
      },
      orderBy: { code: "asc" },
    }),
  );
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid document payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;

  const denied = authorize(auth.tenant.scope, "document:manage");
  if (denied) return denied;

  const organization = await db.organization.findFirst({
    where: { id: parsed.data.organizationId, active: true },
    select: { id: true },
  });
  if (!organization) {
    return apiError(404, "ORGANIZATION_NOT_FOUND", "Organization not found");
  }

  try {
    const row = await db.document.create({
      data: {
        organizationId: parsed.data.organizationId,
        code: parsed.data.code,
        title: parsed.data.title,
        type: parsed.data.type,
        owner: parsed.data.owner ?? null,
        description: parsed.data.description ?? null,
      },
    });

    await db.auditLog.create({
      data: {
        actorId: auth.session.user.id,
        entityType: "Document",
        entityId: row.id,
        action: "CREATED",
        afterJson: JSON.stringify(row),
      },
    });

    return apiData(row, { status: 201 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return apiError(409, "DOCUMENT_CODE_EXISTS", "Document code already exists in this organization");
    }
    throw error;
  }
}
