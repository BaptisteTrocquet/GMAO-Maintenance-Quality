import { z } from "zod";
import { db } from "@/lib/db";
import { apiData, apiError } from "@/lib/api-response";
import { assertPermission, AccessDeniedError } from "@/lib/access-control";
import { authenticateRequest } from "@/lib/auth/request-auth";

const createSchema = z.object({
  organizationId: z.string().min(1),
  code: z.string().min(1).max(80),
  title: z.string().min(1).max(240),
  type: z.string().min(1).max(80),
  owner: z.string().optional(),
  description: z.string().optional(),
});

function authorize(scope: Parameters<typeof assertPermission>[0], permission: "document:read" | "document:manage") {
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

  return apiData(
    await db.document.findMany({
      where: { organizationId },
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
  const parsed = createSchema.safeParse(await request.json());
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

  const row = await db.document.create({
    data: {
      organizationId: parsed.data.organizationId,
      code: parsed.data.code,
      title: parsed.data.title,
      type: parsed.data.type,
      owner: parsed.data.owner,
      description: parsed.data.description,
    },
  });

  return apiData(row, { status: 201 });
}
