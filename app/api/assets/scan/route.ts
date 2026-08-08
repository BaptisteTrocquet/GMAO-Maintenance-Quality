import { z } from "zod";
import { apiData, apiError } from "@/lib/api-response";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { parseAssetQrPayload } from "@/lib/assets/qr";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { db } from "@/lib/db";

const scanSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  payload: z.string().trim().min(1).max(2048),
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_PAYLOAD", "Request body must be valid JSON");
  }

  const parsed = scanSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid QR scan payload", parsed.error.flatten());
  }

  const { organizationId, siteId, payload } = parsed.data;
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

  const qr = parseAssetQrPayload(payload, new URL(request.url).origin);
  if (!qr) {
    return apiError(
      400,
      "INVALID_ASSET_QR",
      "QR code must contain an asset route from this OpenGMAO origin",
    );
  }

  const asset = await db.asset.findFirst({
    where: {
      id: qr.assetId,
      siteId,
      archivedAt: null,
    },
    select: {
      id: true,
      code: true,
      name: true,
    },
  });
  if (!asset) {
    return apiError(404, "ASSET_NOT_FOUND", "Active asset not found in the selected site");
  }

  return apiData({
    asset,
    href: qr.href,
  });
}
