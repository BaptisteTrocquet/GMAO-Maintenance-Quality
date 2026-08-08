import { z } from "zod";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import {
  listSavedWorkOrderViews,
  SavedWorkOrderViewError,
  saveWorkOrderView,
} from "@/lib/maintenance/saved-views";

const scopeSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
});

const saveSchema = scopeSchema.extend({
  name: z.string().trim().min(1).max(80),
  dueFilter: z.enum(["ALL", "OVERDUE", "DUE_7_DAYS", "NO_DUE_DATE"]),
  priorityFilter: z.enum(["ALL", "URGENT", "HIGH", "NORMAL", "LOW"]),
  assignmentFilter: z.enum(["ALL", "UNASSIGNED", "MY_WORK"]),
});

function authorize(scope: Parameters<typeof assertSitePermission>[0], siteId: string) {
  try {
    assertSitePermission(scope, siteId, "work:read");
    return null;
  } catch (error) {
    if (error instanceof AccessDeniedError) return apiError(403, "ACCESS_DENIED", error.message);
    throw error;
  }
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const parsed = scopeSchema.safeParse({
    organizationId: url.searchParams.get("organizationId"),
    siteId: url.searchParams.get("siteId"),
  });
  if (!parsed.success) {
    return apiError(400, "INVALID_SCOPE", "organizationId and siteId are required");
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, parsed.data.siteId);
  if (denied) return denied;

  return apiData(
    await listSavedWorkOrderViews({
      userId: auth.session.user.id,
      organizationId: parsed.data.organizationId,
      siteId: parsed.data.siteId,
    }),
  );
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }

  const parsed = saveSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid saved-view payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, parsed.data.siteId);
  if (denied) return denied;

  try {
    return apiData(
      await saveWorkOrderView({
        userId: auth.session.user.id,
        ...parsed.data,
      }),
    );
  } catch (error) {
    if (error instanceof SavedWorkOrderViewError) {
      return apiError(400, error.code, error.message);
    }
    throw error;
  }
}
