import { z } from "zod";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { db } from "@/lib/db";
import {
  deleteSavedView,
  SAVED_VIEW_SURFACES,
  SavedViewError,
  updateSavedView,
} from "@/lib/saved-views";

const surfaceSchema = z.enum(SAVED_VIEW_SURFACES);
const filtersSchema = z
  .record(z.string().min(1).max(50), z.string().max(200))
  .refine((filters) => Object.keys(filters).length <= 20, "At most 20 filters can be saved");

const updateSchema = z
  .object({
    organizationId: z.string().min(1),
    siteId: z.string().min(1),
    surface: surfaceSchema,
    name: z.string().min(1).max(80).optional(),
    filters: filtersSchema.optional(),
  })
  .refine((value) => value.name !== undefined || value.filters !== undefined, {
    message: "At least one saved view field must change",
  });

function savedViewError(error: unknown) {
  if (error instanceof SavedViewError) {
    const status = error.code === "VIEW_NAME_CONFLICT" ? 409 : error.code === "VIEW_NOT_FOUND" ? 404 : 400;
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
    return savedViewError(error);
  }
  const site = await db.site.findFirst({
    where: { id: siteId, organizationId, active: true },
    select: { id: true },
  });
  if (!site) return apiError(404, "SITE_NOT_FOUND", "Active site not found in organization scope");
  return auth;
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ viewId: string }> },
) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "Invalid saved view update", parsed.error.flatten());
  }

  const auth = await authorize(request, parsed.data.organizationId, parsed.data.siteId);
  if (auth instanceof Response) return auth;
  const { viewId } = await context.params;

  try {
    const view = await updateSavedView({
      viewId,
      userId: auth.session.user.id,
      ...parsed.data,
    });
    return apiData(view);
  } catch (error) {
    return savedViewError(error);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ viewId: string }> },
) {
  const url = new URL(request.url);
  const parsed = z
    .object({
      organizationId: z.string().min(1),
      siteId: z.string().min(1),
      surface: surfaceSchema,
    })
    .safeParse({
      organizationId: url.searchParams.get("organizationId"),
      siteId: url.searchParams.get("siteId"),
      surface: url.searchParams.get("surface"),
    });
  if (!parsed.success) {
    return apiError(400, "INVALID_QUERY", "organizationId, siteId and a supported surface are required");
  }

  const auth = await authorize(request, parsed.data.organizationId, parsed.data.siteId);
  if (auth instanceof Response) return auth;
  const { viewId } = await context.params;

  try {
    const view = await deleteSavedView({
      viewId,
      userId: auth.session.user.id,
      ...parsed.data,
    });
    return apiData(view);
  } catch (error) {
    return savedViewError(error);
  }
}
