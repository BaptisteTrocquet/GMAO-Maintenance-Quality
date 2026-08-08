import { z } from "zod";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { db } from "@/lib/db";
import {
  createSavedKanbanView,
  deleteSavedKanbanView,
  listSavedKanbanViews,
  SavedKanbanViewError,
} from "@/lib/maintenance/saved-kanban-views";

const scopeSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
});

const createSchema = scopeSchema.extend({
  name: z.string().min(1).max(80),
  dueFilter: z.enum(["ALL", "OVERDUE", "DUE_7_DAYS", "NO_DUE_DATE"]),
});

const deleteSchema = scopeSchema.extend({ viewId: z.string().min(1) });

function domainError(error: unknown): Response {
  if (error instanceof SavedKanbanViewError) {
    const status = error.code === "NAME_CONFLICT" ? 409 : error.code === "VIEW_NOT_FOUND" ? 404 : 400;
    return apiError(status, error.code, error.message);
  }
  if (error instanceof AccessDeniedError) return apiError(403, "ACCESS_DENIED", error.message);
  throw error;
}

async function authorize(request: Request, organizationId: string, siteId: string) {
  const auth = await authenticateRequest(request, organizationId);
  if ("error" in auth) return auth.error;
  try {
    assertSitePermission(auth.tenant.scope, siteId, "work:read");
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
  if (!site) return apiError(404, "SITE_NOT_FOUND", "Active site not found in organization scope");
  return auth;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = scopeSchema.safeParse({
    organizationId: url.searchParams.get("organizationId"),
    siteId: url.searchParams.get("siteId"),
  });
  if (!parsed.success) {
    return apiError(400, "INVALID_QUERY", "organizationId and siteId are required");
  }

  const auth = await authorize(request, parsed.data.organizationId, parsed.data.siteId);
  if (auth instanceof Response) return auth;

  return apiData(
    await listSavedKanbanViews({
      userId: auth.session.user.id,
      ...parsed.data,
    }),
  );
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
    return apiError(400, "INVALID_PAYLOAD", "Invalid saved Kanban view", parsed.error.flatten());
  }

  const auth = await authorize(request, parsed.data.organizationId, parsed.data.siteId);
  if (auth instanceof Response) return auth;

  try {
    return apiData(
      await createSavedKanbanView({
        userId: auth.session.user.id,
        ...parsed.data,
      }),
      { status: 201 },
    );
  } catch (error) {
    return domainError(error);
  }
}

export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const parsed = deleteSchema.safeParse({
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
    return apiData(
      await deleteSavedKanbanView({
        viewId: parsed.data.viewId,
        userId: auth.session.user.id,
        organizationId: parsed.data.organizationId,
        siteId: parsed.data.siteId,
      }),
    );
  } catch (error) {
    return domainError(error);
  }
}
