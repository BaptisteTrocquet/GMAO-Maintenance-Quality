import { z } from "zod";
import { apiData, apiError } from "@/lib/api-response";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { generateCalendarMaintenanceWorkOrders, MaintenanceSchedulerError } from "@/lib/maintenance/scheduler";

const runSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  throughDate: z.coerce.date().optional(),
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }

  const parsed = runSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid maintenance scheduler payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;

  try {
    assertSitePermission(auth.tenant.scope, parsed.data.siteId, "maintenance:manage");
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      return apiError(403, "ACCESS_DENIED", error.message);
    }
    throw error;
  }

  const now = new Date();
  const throughDate = parsed.data.throughDate ?? now;
  const maximumThroughDate = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
  if (throughDate > maximumThroughDate) {
    return apiError(
      400,
      "HORIZON_TOO_LARGE",
      "Scheduler throughDate cannot be more than 90 days in the future",
    );
  }

  try {
    const result = await generateCalendarMaintenanceWorkOrders({
      organizationId: parsed.data.organizationId,
      siteId: parsed.data.siteId,
      throughDate,
      actorId: auth.session.user.id,
    });
    if (!result.siteFound) return apiError(404, "SITE_NOT_FOUND", "Site not found");
    return apiData(result);
  } catch (error) {
    if (error instanceof MaintenanceSchedulerError) {
      return apiError(409, error.code, error.message);
    }
    throw error;
  }
}
