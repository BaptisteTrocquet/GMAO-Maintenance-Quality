import { z } from "zod";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { createMeter } from "@/lib/assets/meters";
import { db } from "@/lib/db";

const createSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  name: z.string().min(1).max(100),
  unit: z.string().min(1).max(30),
  code: z.string().max(50).nullable().optional(),
  rollover: z.number().positive().nullable().optional(),
});

function authorize(scope: Parameters<typeof assertSitePermission>[0], siteId: string, permission: "asset:read" | "asset:write") {
  try {
    assertSitePermission(scope, siteId, permission);
    return null;
  } catch (error) {
    if (error instanceof AccessDeniedError) return apiError(403, "ACCESS_DENIED", error.message);
    throw error;
  }
}

export async function GET(request: Request, context: { params: Promise<{ assetId: string }> }) {
  const url = new URL(request.url);
  const organizationId = url.searchParams.get("organizationId");
  const siteId = url.searchParams.get("siteId");
  if (!organizationId || !siteId) return apiError(400, "INVALID_SCOPE", "organizationId and siteId are required");

  const auth = await authenticateRequest(request, organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, siteId, "asset:read");
  if (denied) return denied;

  const { assetId } = await context.params;
  const asset = await db.asset.findFirst({ where: { id: assetId, siteId, archivedAt: null }, select: { id: true } });
  if (!asset) return apiError(404, "ASSET_NOT_FOUND", "Asset not found");

  return apiData(await db.meter.findMany({ where: { assetId }, include: { readings: { orderBy: { readingAt: "desc" }, take: 20 } } }));
}

export async function POST(request: Request, context: { params: Promise<{ assetId: string }> }) {
  const parsed = createSchema.safeParse(await request.json());
  if (!parsed.success) return apiError(400, "INVALID_PAYLOAD", "Invalid meter payload", parsed.error.flatten());

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, parsed.data.siteId, "asset:write");
  if (denied) return denied;

  const { assetId } = await context.params;
  const meter = await createMeter({ ...parsed.data, assetId, actorId: auth.session.user.id });
  if (!meter) return apiError(404, "ASSET_NOT_FOUND", "Asset not found");
  return apiData(meter, { status: 201 });
}
