import { db } from "@/lib/db";
import { apiData, apiError } from "@/lib/api-response";
import { assertSitePermission, AccessDeniedError } from "@/lib/access-control";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { z } from "zod";

const createSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  assetId: z.string().optional().nullable(),
  title: z.string().min(1),
  description: z.string().optional(),
  type: z.enum(["CORRECTIVE", "PREVENTIVE", "INSPECTION", "IMPROVEMENT", "SAFETY", "OTHER"]),
  priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).default("NORMAL"),
});

async function nextNumber() {
  const count = await db.workOrder.count();
  return `WO-${String(count + 1).padStart(6, "0")}`;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const organizationId = url.searchParams.get("organizationId");
  const siteId = url.searchParams.get("siteId");
  if (!organizationId || !siteId) return apiError(400, "INVALID_SCOPE", "organizationId and siteId are required");

  const auth = await authenticateRequest(request, organizationId);
  if ("error" in auth) return auth.error;

  try {
    assertSitePermission(auth.tenant.scope, siteId, "work:read");
  } catch (error) {
    if (error instanceof AccessDeniedError) return apiError(403, "ACCESS_DENIED", error.message);
    throw error;
  }

  const site = await db.site.findFirst({ where: { id: siteId, organizationId, active: true }, select: { id: true } });
  if (!site) return apiError(404, "SITE_NOT_FOUND", "Site not found");

  return apiData(await db.workOrder.findMany({
    where: { asset: { siteId } },
    include: { asset: true, assignee: true },
    orderBy: { requestedAt: "desc" },
  }));
}

export async function POST(request: Request) {
  const parsed = createSchema.safeParse(await request.json());
  if (!parsed.success) return apiError(400, "INVALID_PAYLOAD", "Invalid work order payload", parsed.error.flatten());

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;

  try {
    assertSitePermission(auth.tenant.scope, parsed.data.siteId, "work:create");
  } catch (error) {
    if (error instanceof AccessDeniedError) return apiError(403, "ACCESS_DENIED", error.message);
    throw error;
  }

  if (parsed.data.assetId) {
    const asset = await db.asset.findFirst({
      where: { id: parsed.data.assetId, siteId: parsed.data.siteId, site: { organizationId: parsed.data.organizationId } },
      select: { id: true },
    });
    if (!asset) return apiError(404, "ASSET_NOT_FOUND", "Asset not found in tenant scope");
  }

  const { organizationId: _organizationId, siteId: _siteId, ...data } = parsed.data;
  return apiData(await db.workOrder.create({ data: { ...data, requesterId: auth.session.user.id, number: await nextNumber() } }), { status: 201 });
}
