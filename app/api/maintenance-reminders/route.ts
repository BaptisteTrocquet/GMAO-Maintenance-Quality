import { z } from "zod";
import { apiData, apiError } from "@/lib/api-response";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { authenticateRequest } from "@/lib/auth/request-auth";
import {
  generatePreventiveMaintenanceReminders,
  listActiveMaintenanceReminders,
} from "@/lib/maintenance/reminders";

const querySchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
});

const runSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  leadDays: z.number().int().min(1).max(30).default(7),
});

function denied(error: unknown) {
  if (error instanceof AccessDeniedError) return apiError(403, "ACCESS_DENIED", error.message);
  throw error;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    organizationId: url.searchParams.get("organizationId"),
    siteId: url.searchParams.get("siteId"),
  });
  if (!parsed.success) {
    return apiError(400, "INVALID_SCOPE", "organizationId and siteId are required", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  try {
    assertSitePermission(auth.tenant.scope, parsed.data.siteId, "maintenance:read");
  } catch (error) {
    return denied(error);
  }

  const reminders = await listActiveMaintenanceReminders(parsed.data);
  if (!reminders) return apiError(404, "SITE_NOT_FOUND", "Site not found");
  return apiData(reminders);
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }

  const parsed = runSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid reminder runner payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  try {
    assertSitePermission(auth.tenant.scope, parsed.data.siteId, "maintenance:manage");
  } catch (error) {
    return denied(error);
  }

  const result = await generatePreventiveMaintenanceReminders({
    ...parsed.data,
    actorId: auth.session.user.id,
  });
  if (!result.siteFound) return apiError(404, "SITE_NOT_FOUND", "Site not found");
  return apiData(result);
}
