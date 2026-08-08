import { z } from "zod";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { db } from "@/lib/db";
import {
  createSavedView,
  listSavedViews,
  SAVED_VIEW_SURFACES,
  SavedViewError,
} from "@/lib/saved-views";

const surfaceSchema = z.enum(SAVED_VIEW_SURFACES);
const dueFilterSchema = z.enum(["ALL", "OVERDUE", "DUE_7_DAYS", "NO_DUE_DATE"]);
const kanbanFiltersSchema = z
  .object({ due: dueFilterSchema.optional() })
  .strict()
  .transform((filters) => ({ due: filters.due ?? "ALL" }));

const createSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  surface: z.literal("WORK_ORDER_KANBAN"),
  name: z.string().min(1).max(80),
  filters: kanbanFiltersSchema,
});

function savedViewError(error: unknown) {
  if (error instanceof SavedViewError) {
    const status =
      error.code === "VIEW_NAME_CONFLICT" || error.code === "VIEW_LIMIT_REACHED"
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
  if ("error" in auth) return { response: auth.error } as const;
  try {
    assertSitePermission(auth.tenant.scope, siteId, "work:read");
  } catch (error) {
    return { response: savedViewError(error) } as const;
  }

  const site = await db.site.findFirst({
    where: { id: siteId, organizationId, active: true },
    select: { id: true },
  });
  if (!site) {
    return {
      response: apiError(404, "SITE_NOT_FOUND", "Active site not found in organization scope"),
    } as const;
  }
  return { auth } as const;
}

export async function GET(request: Request) {
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

  const authorization = await authorize(request, parsed.data.organizationId, parsed.data.siteId);
  if ("response" in authorization) return authorization.response;

  return apiData(
    await listSavedViews({
      userId: authorization.auth.session.user.id,
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
    return apiError(400, "INVALID_PAYLOAD", "Invalid saved view", parsed.error.flatten());
  }

  const authorization = await authorize(request, parsed.data.organizationId, parsed.data.siteId);
  if ("response" in authorization) return authorization.response;

  try {
    return apiData(
      await createSavedView({
        userId: authorization.auth.session.user.id,
        ...parsed.data,
      }),
      { status: 201 },
    );
  } catch (error) {
    return savedViewError(error);
  }
}