import { z } from "zod";
import { db } from "@/lib/db";
import { apiData, apiError } from "@/lib/api-response";
import { assertSitePermission, AccessDeniedError } from "@/lib/access-control";
import { authenticateRequest } from "@/lib/auth/request-auth";
import {
  assertLocationHierarchyIntegrity,
  HierarchyIntegrityError,
} from "@/lib/assets/hierarchy";

const createSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  parentId: z.string().optional().nullable(),
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  description: z.string().optional(),
});

async function authorizeSite(request: Request, organizationId: string, siteId: string, permission: "asset:read" | "asset:write") {
  const auth = await authenticateRequest(request, organizationId);
  if ("error" in auth) return { error: auth.error } as const;

  try {
    assertSitePermission(auth.tenant.scope, siteId, permission);
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      return { error: apiError(403, "ACCESS_DENIED", error.message) } as const;
    }
    throw error;
  }

  const site = await db.site.findFirst({
    where: { id: siteId, organizationId, active: true },
    select: { id: true },
  });
  if (!site) return { error: apiError(404, "SITE_NOT_FOUND", "Site not found") } as const;

  return { auth, site } as const;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const organizationId = url.searchParams.get("organizationId");
  const siteId = url.searchParams.get("siteId");
  if (!organizationId || !siteId) {
    return apiError(400, "INVALID_SCOPE", "organizationId and siteId are required");
  }

  const authorization = await authorizeSite(request, organizationId, siteId, "asset:read");
  if ("error" in authorization) return authorization.error;

  return apiData(
    await db.location.findMany({
      where: { siteId },
      include: {
        parent: { select: { id: true, code: true, name: true } },
        children: { select: { id: true, code: true, name: true } },
      },
      orderBy: [{ parentId: "asc" }, { name: "asc" }],
    }),
  );
}

export async function POST(request: Request) {
  const parsed = createSchema.safeParse(await request.json());
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid location payload", parsed.error.flatten());
  }

  const authorization = await authorizeSite(
    request,
    parsed.data.organizationId,
    parsed.data.siteId,
    "asset:write",
  );
  if ("error" in authorization) return authorization.error;

  try {
    await assertLocationHierarchyIntegrity({
      siteId: parsed.data.siteId,
      parentId: parsed.data.parentId,
    });
  } catch (error) {
    if (error instanceof HierarchyIntegrityError) {
      return apiError(400, error.code, error.message);
    }
    throw error;
  }

  return apiData(
    await db.location.create({
      data: {
        siteId: parsed.data.siteId,
        parentId: parsed.data.parentId,
        code: parsed.data.code,
        name: parsed.data.name,
        description: parsed.data.description,
      },
    }),
    { status: 201 },
  );
}
