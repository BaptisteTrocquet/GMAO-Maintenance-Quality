import { z } from "zod";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { db } from "@/lib/db";
import {
  createSavedMaintenanceView,
  deleteSavedMaintenanceView,
  listSavedMaintenanceViews,
  SavedMaintenanceViewError,
} from "@/lib/maintenance/saved-views";

const scopeSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
});

const kanbanCreateSchema = scopeSchema.extend({
  surface: z.literal("KANBAN"),
  name: z.string().min(1).max(80),
  config: z.object({
    dueFilter: z.enum(["ALL", "OVERDUE", "DUE_7_DAYS", "NO_DUE_DATE"]),
  }),
});

const calendarCreateSchema = scopeSchema.extend({
  surface: z.literal("CALENDAR"),
  name: z.string().min(1).max(80),
  config: z.object({
    month: z.string().regex(/^\d{4}-\d{2}$/).nullable(),
  }),
});

const createSchema = z.discriminatedUnion("surface", [kanbanCreateSchema, calendarCreateSchema]);

function savedViewError(error: unknown) {
  if (error instanceof SavedMaintenanceViewError) {
    const status =
      error.code === "DUPLICATE_VIEW_NAME" || error.code === "VIEW_LIMIT_REACHED"
        ? 409
        : error.code === "VIEW_NOT_FOUND"
          ? 404
          : 400;
    return apiError(status, error.code, error.message);
  }
  if (error instanceof AccessDeniedError) return apiError(403, "ACCESS_DENIED", error.message);
  throw error;
}

async function authorize(request: Request, organizationId: string, siteId: string) {
  const auth = await authenticateRequest(request, organizationId);
  if ("error" in auth) {
    return auth.error ?? apiError(401, "UNAUTHENTICATED", "Authentication required");
  }

  try {
    assertSitePermission(auth.tenant.scope, siteId, "work:read");
  } catch (error) {
    return savedViewError(error);
  }

  const site = await db.site.findFirst({
    where: { id: siteId, organizationId, active: true },
    select: { id: true },
  });
  if (!site) return apiError(404, "SITE_NOT_FOUND", "Active site not found in organization scope");
  return auth;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = scopeSchema
    .extend({ surface: z.enum(["KANBAN", "CALENDAR"]).optional() })
    .safeParse({
      organizationId: url.searchParams.get("organizationId"),
      siteId: url.searchParams.get("siteId"),
      surface: url.searchParams.get("surface") || undefined,
    });
  if (!parsed.success) {
    return apiError(400, "INVALID_QUERY", "organizationId and siteId are required");
  }

  const auth = await authorize(request, parsed.data.organizationId, parsed.data.siteId);
  if (auth instanceof Response) return auth;

  const views = await listSavedMaintenanceViews({
    organizationId: parsed.data.organizationId,
    siteId: parsed.data.siteId,
    userId: auth.session.user.id,
    surface: parsed.data.surface,
  });
  return apiData(views);
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid saved maintenance view", parsed.error.flatten());
  }

  const auth = await authorize(request, parsed.data.organizationId, parsed.data.siteId);
  if (auth instanceof Response) return auth;

  try {
    const view = await createSavedMaintenanceView({
      organizationId: parsed.data.organizationId,
      siteId: parsed.data.siteId,
      userId: auth.session.user.id,
      name: parsed.data.name,
      surface: parsed.data.surface,
      config: parsed.data.config,
    });
    return apiData(view, { status: 201 });
  } catch (error) {
    return savedViewError(error);
  }
}

export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const parsed = scopeSchema.extend({ viewId: z.string().uuid() }).safeParse({
    organizationId: url.searchParams.get("organizationId"),
    siteId: url.searchParams.get("siteId"),
    viewId: url.searchParams.get("viewId"),
  });
  if (!parsed.success) {
    return apiError(400, "INVALID_QUERY", "organizationId, siteId and viewId are required");
  }

  const auth = await authorize(request, parsed.data.organizationId, parsed.data.siteId);
  if (auth instanceof Response) return auth;

  try {
    const view = await deleteSavedMaintenanceView({
      organizationId: parsed.data.organizationId,
      siteId: parsed.data.siteId,
      userId: auth.session.user.id,
      viewId: parsed.data.viewId,
    });
    return apiData(view);
  } catch (error) {
    return savedViewError(error);
  }
}
