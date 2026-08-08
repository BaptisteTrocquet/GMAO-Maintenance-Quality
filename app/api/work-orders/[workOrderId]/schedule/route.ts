import { z } from "zod";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { db } from "@/lib/db";
import { rescheduleWorkOrder, WorkOrderRescheduleError } from "@/lib/maintenance/reschedule";
import { siteLocalDateTimeToUtc, ZonedDateTimeError } from "@/lib/maintenance/zoned-date-time";

const bodySchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  localTime: z.string().regex(/^\d{2}:\d{2}$/).default("08:00"),
  reason: z.string().trim().max(500).nullable().optional(),
});

function authorize(scope: Parameters<typeof assertSitePermission>[0], siteId: string): Response | null {
  try {
    assertSitePermission(scope, siteId, "work:update");
    return null;
  } catch (error) {
    if (error instanceof AccessDeniedError) return apiError(403, "ACCESS_DENIED", error.message);
    throw error;
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ workOrderId: string }> },
): Promise<Response> {
  const { workOrderId } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid work-order schedule payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) {
    return auth.error ?? apiError(401, "UNAUTHENTICATED", "Authentication required");
  }
  const denied = authorize(auth.tenant.scope, parsed.data.siteId);
  if (denied) return denied;

  const site = await db.site.findFirst({
    where: {
      id: parsed.data.siteId,
      organizationId: parsed.data.organizationId,
      active: true,
      organization: { active: true },
    },
    select: { organization: { select: { timezone: true } } },
  });
  if (!site) return apiError(404, "SITE_NOT_FOUND", "Active site not found in organization scope");

  try {
    const plannedStart = siteLocalDateTimeToUtc({
      localDate: parsed.data.localDate,
      localTime: parsed.data.localTime,
      timeZone: site.organization.timezone,
    });
    return apiData(
      await rescheduleWorkOrder({
        organizationId: parsed.data.organizationId,
        siteId: parsed.data.siteId,
        workOrderId,
        plannedStart,
        actorId: auth.session.user.id,
        reason: parsed.data.reason,
      }),
    );
  } catch (error) {
    if (error instanceof ZonedDateTimeError) {
      return apiError(400, error.code, error.message);
    }
    if (error instanceof WorkOrderRescheduleError) {
      const status = error.code === "WORK_ORDER_NOT_FOUND" ? 404 : 409;
      return apiError(status, error.code, error.message);
    }
    throw error;
  }
}
