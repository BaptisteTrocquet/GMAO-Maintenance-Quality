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

const dueFilterSchema = z.enum(["ALL", "OVERDUE", "DUE_7_DAYS", "NO_DUE_DATE"]);

const createSchema = scopeSchema.extend({
  name: z.string().trim().min(1).max(80),
  surface: z.literal("KANBAN"),
  config: z.object({ dueFilter: dueFilterSchema }),
});

const deleteSchema = scopeSchema.extend({ viewId: z.string().uuid() });

function accessDenied(error: unknown) {
  if (error instanceof AccessDeniedError) return apiError(403, "ACCESS_DENIED", error.message);
  throw error;
}

function savedViewError(error: SavedMaintenanceViewError) {
  switch (error.code) {
    case "VIEW_NOT_FOUND":
      return apiError(404, error.code, error.message);
    case "VIEW_LIMIT_REACHED":
    case "DUPLICATE_VIEW_NAME":
      return apiError(409, error.code, error.message);
    case "INVALID_VIEW":
      return apiError(400, error.code, error.message);
  }
}

async function requireSite(organizationId: string, siteId: string) {
  return db.site.findFirst({
    where: { id: siteId, organizationId, active: true },
    select: { id: true },
  });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = scopeSchema.safeParse({
    organizationId: url.searchParams.get("organizationId"),
    siteId: url.searchParams.get("siteId"),
  });
  if (!parsed.success) return apiError(400, "INVALID_SCOPE", "organizationId and siteId are required");

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  try {
    assertSitePermission(auth.tenant.scope, parsed.data.siteId, "work:read");
  } catch (error) {
    return accessDenied(error);
  }
  if (!(await requireSite(parsed.data.organizationId, parsed.data.siteId))) {
    return apiError(404, "SITE_NOT_FOUND", "Site not found in organization scope");
  }

  return apiData(
    await listSavedMaintenanceViews({
      organizationId: parsed.data.organizationId,
      siteId: parsed.data.siteId,
      userId: auth.session.user.id,
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
  if (!parsed.success) return apiError(400, "INVALID_PAYLOAD", "Invalid saved view", parsed.error.flatten());

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  try {
    assertSitePermission(auth.tenant.scope, parsed.data.siteId, "work:read");
  } catch (error) {
    return accessDenied(error);
  }
  if (!(await requireSite(parsed.data.organizationId, parsed.data.siteId))) {
    return apiError(404, "SITE_NOT_FOUND", "Site not found in organization scope");
  }

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
    if (error instanceof SavedMaintenanceViewError) return savedViewError(error);
    throw error;
  }
}

export async function DELETE(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
  const parsed = deleteSchema.safeParse(body);
  if (!parsed.success) return apiError(400, "INVALID_PAYLOAD", "Invalid saved-view deletion", parsed.error.flatten());

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  try {
    assertSitePermission(auth.tenant.scope, parsed.data.siteId, "work:read");
  } catch (error) {
    return accessDenied(error);
  }
  if (!(await requireSite(parsed.data.organizationId, parsed.data.siteId))) {
    return apiError(404, "SITE_NOT_FOUND", "Site not found in organization scope");
  }

  try {
    return apiData(
      await deleteSavedMaintenanceView({
        organizationId: parsed.data.organizationId,
        siteId: parsed.data.siteId,
        userId: auth.session.user.id,
        viewId: parsed.data.viewId,
      }),
    );
  } catch (error) {
    if (error instanceof SavedMaintenanceViewError) return savedViewError(error);
    throw error;
  }
}
