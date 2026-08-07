import { db } from "@/lib/db";
import { apiData, apiError } from "@/lib/api-response";
import { assertSitePermission, AccessDeniedError } from "@/lib/access-control";
import { authenticateRequest } from "@/lib/auth/request-auth";
import {
  assertAssetHierarchyIntegrity,
  HierarchyIntegrityError,
} from "@/lib/assets/hierarchy";
import { z } from "zod";

const createSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  locationId: z.string().optional().nullable(),
  parentAssetId: z.string().optional().nullable(),
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  category: z.string().max(100).optional(),
  manufacturer: z.string().max(150).optional(),
  model: z.string().max(150).optional(),
  serialNumber: z.string().max(150).optional(),
  criticality: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
  status: z.enum(["ACTIVE", "INACTIVE", "OUT_OF_SERVICE", "DECOMMISSIONED"]).optional(),
  installedAt: z.coerce.date().optional(),
  commissionedAt: z.coerce.date().optional(),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const organizationId = url.searchParams.get("organizationId");
  const siteId = url.searchParams.get("siteId");
  const includeArchived = url.searchParams.get("includeArchived") === "true";
  if (!organizationId || !siteId) {
    return apiError(400, "INVALID_SCOPE", "organizationId and siteId are required");
  }

  const auth = await authenticateRequest(request, organizationId);
  if ("error" in auth) return auth.error;

  try {
    assertSitePermission(auth.tenant.scope, siteId, "asset:read");
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      return apiError(403, "ACCESS_DENIED", error.message);
    }
    throw error;
  }

  const site = await db.site.findFirst({
    where: { id: siteId, organizationId, active: true },
    select: { id: true },
  });
  if (!site) return apiError(404, "SITE_NOT_FOUND", "Site not found");

  return apiData(
    await db.asset.findMany({
      where: { siteId, ...(includeArchived ? {} : { archivedAt: null }) },
      include: { site: true, location: true, parentAsset: true },
    }),
  );
}

export async function POST(request: Request) {
  const parsed = createSchema.safeParse(await request.json());
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid asset payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;

  try {
    assertSitePermission(auth.tenant.scope, parsed.data.siteId, "asset:write");
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      return apiError(403, "ACCESS_DENIED", error.message);
    }
    throw error;
  }

  const site = await db.site.findFirst({
    where: {
      id: parsed.data.siteId,
      organizationId: parsed.data.organizationId,
      active: true,
    },
    select: { id: true },
  });
  if (!site) return apiError(404, "SITE_NOT_FOUND", "Site not found");

  try {
    await assertAssetHierarchyIntegrity({
      siteId: parsed.data.siteId,
      locationId: parsed.data.locationId,
      parentAssetId: parsed.data.parentAssetId,
    });
  } catch (error) {
    if (error instanceof HierarchyIntegrityError) {
      return apiError(400, error.code, error.message);
    }
    throw error;
  }

  const data = {
    siteId: parsed.data.siteId,
    locationId: parsed.data.locationId,
    parentAssetId: parsed.data.parentAssetId,
    code: parsed.data.code,
    name: parsed.data.name,
    description: parsed.data.description,
    category: parsed.data.category,
    manufacturer: parsed.data.manufacturer,
    model: parsed.data.model,
    serialNumber: parsed.data.serialNumber,
    status: parsed.data.status,
    criticality: parsed.data.criticality,
    installedAt: parsed.data.installedAt,
    commissionedAt: parsed.data.commissionedAt,
  };

  const created = await db.asset.create({ data });
  await db.auditLog.create({
    data: {
      actorId: auth.session.user.id,
      entityType: "Asset",
      entityId: created.id,
      action: "CREATED",
      afterJson: JSON.stringify(created),
    },
  });

  return apiData(created, { status: 201 });
}
