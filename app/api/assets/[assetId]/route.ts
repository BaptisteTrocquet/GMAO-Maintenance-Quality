import { z } from "zod";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { archiveAsset, updateAssetLifecycle } from "@/lib/assets/lifecycle";
import { HierarchyIntegrityError } from "@/lib/assets/hierarchy";
import { db } from "@/lib/db";

const updateSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  locationId: z.string().nullable().optional(),
  parentAssetId: z.string().nullable().optional(),
  code: z.string().min(1).max(50).optional(),
  name: z.string().min(1).max(200).optional(),
  description: z.string().nullable().optional(),
  category: z.string().max(100).nullable().optional(),
  manufacturer: z.string().max(150).nullable().optional(),
  model: z.string().max(150).nullable().optional(),
  serialNumber: z.string().max(150).nullable().optional(),
  status: z.enum(["ACTIVE", "INACTIVE", "OUT_OF_SERVICE", "DECOMMISSIONED"]).optional(),
  criticality: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
  installedAt: z.coerce.date().nullable().optional(),
  commissionedAt: z.coerce.date().nullable().optional(),
  decommissionedAt: z.coerce.date().nullable().optional(),
});

const archiveSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
});

function authorize(scope: Parameters<typeof assertSitePermission>[0], siteId: string) {
  try {
    assertSitePermission(scope, siteId, "asset:write");
    return null;
  } catch (error) {
    if (error instanceof AccessDeniedError) return apiError(403, "ACCESS_DENIED", error.message);
    throw error;
  }
}

async function ensureSite(organizationId: string, siteId: string) {
  return db.site.findFirst({
    where: { id: siteId, organizationId, active: true },
    select: { id: true },
  });
}

export async function PATCH(request: Request, context: { params: Promise<{ assetId: string }> }) {
  const parsed = updateSchema.safeParse(await request.json());
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid asset update payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, parsed.data.siteId);
  if (denied) return denied;
  if (!(await ensureSite(parsed.data.organizationId, parsed.data.siteId))) {
    return apiError(404, "SITE_NOT_FOUND", "Site not found");
  }

  const { assetId } = await context.params;
  try {
    const updated = await updateAssetLifecycle({
      ...parsed.data,
      assetId,
      actorId: auth.session.user.id,
    });
    if (!updated) return apiError(404, "ASSET_NOT_FOUND", "Asset not found");
    return apiData(updated);
  } catch (error) {
    if (error instanceof HierarchyIntegrityError) {
      return apiError(400, error.code, error.message);
    }
    throw error;
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ assetId: string }> }) {
  const parsed = archiveSchema.safeParse(await request.json());
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid asset archive payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, parsed.data.siteId);
  if (denied) return denied;
  if (!(await ensureSite(parsed.data.organizationId, parsed.data.siteId))) {
    return apiError(404, "SITE_NOT_FOUND", "Site not found");
  }

  const { assetId } = await context.params;
  try {
    const archived = await archiveAsset({
      siteId: parsed.data.siteId,
      assetId,
      actorId: auth.session.user.id,
    });
    if (!archived) return apiError(404, "ASSET_NOT_FOUND", "Asset not found");
    return apiData(archived);
  } catch (error) {
    if (error instanceof HierarchyIntegrityError) {
      return apiError(409, error.code, error.message);
    }
    throw error;
  }
}
