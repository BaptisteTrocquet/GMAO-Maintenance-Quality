import { z } from "zod";
import { apiData, apiError } from "@/lib/api-response";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { dismissMaintenanceReminder } from "@/lib/maintenance/reminders";

const dismissSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ reminderId: string }> },
) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }

  const parsed = dismissSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid reminder dismissal payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  try {
    assertSitePermission(auth.tenant.scope, parsed.data.siteId, "maintenance:read");
  } catch (error) {
    if (error instanceof AccessDeniedError) return apiError(403, "ACCESS_DENIED", error.message);
    throw error;
  }

  const { reminderId } = await context.params;
  const reminder = await dismissMaintenanceReminder({
    ...parsed.data,
    reminderId,
    actorId: auth.session.user.id,
  });
  if (!reminder) return apiError(404, "REMINDER_NOT_FOUND", "Active reminder not found in site scope");
  return apiData(reminder);
}
