import { z } from "zod";
import { apiData, apiError } from "@/lib/api-response";
import { db } from "@/lib/db";
import { authenticateApiKeyRequest } from "@/lib/integrations/api-keys";
import {
  createPublicMaintenanceRequest,
  PublicMaintenanceRequestError,
} from "@/lib/public-requests/create-request";

const requestSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(5000).nullable().optional(),
  assetCode: z.string().trim().min(1).max(50).nullable().optional(),
  requesterName: z.string().trim().min(1).max(150).nullable().optional(),
  requesterEmail: z.string().email().max(320).nullable().optional(),
  requesterRef: z.string().trim().min(1).max(150).nullable().optional(),
});

export async function POST(request: Request) {
  const auth = await authenticateApiKeyRequest(request, "maintenance:request:create");
  if ("error" in auth) return auth.error;

  const site = await db.site.findFirst({
    where: {
      id: auth.token.siteId,
      organizationId: auth.token.organizationId,
      active: true,
      organization: { active: true },
    },
    select: { id: true },
  });
  if (!site) return apiError(404, "SITE_NOT_FOUND", "API key site is unavailable");

  const idempotencyKey = request.headers.get("Idempotency-Key")?.trim();
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 200) {
    return apiError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "A unique Idempotency-Key header between 8 and 200 characters is required",
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid maintenance request", parsed.error.flatten());
  }

  try {
    const result = await createPublicMaintenanceRequest({
      token: auth.token,
      idempotencyKey,
      title: parsed.data.title,
      description: parsed.data.description ?? null,
      assetCode: parsed.data.assetCode ?? null,
      requesterName: parsed.data.requesterName ?? null,
      requesterEmail: parsed.data.requesterEmail ?? null,
      requesterRef: parsed.data.requesterRef ?? null,
      origin: null,
    });
    return apiData(result, { status: result.idempotent ? 200 : 201 });
  } catch (error) {
    if (error instanceof PublicMaintenanceRequestError) {
      const status = error.code === "ASSET_NOT_FOUND" ? 404 : error.code === "RATE_LIMITED" ? 429 : 409;
      return apiError(status, error.code, error.message);
    }
    throw error;
  }
}
