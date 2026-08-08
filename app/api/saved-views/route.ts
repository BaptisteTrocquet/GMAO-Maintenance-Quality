import { z } from "zod";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { db } from "@/lib/db";
import {
  createSavedMaintenanceView,
  listSavedMaintenanceViews,
  SavedMaintenanceViewError,
} from "@/lib/maintenance/saved-views";

const surfaceSchema = z.enum(["KANBAN", "CALENDAR"]);
const dueFilterSchema = z.enum(["ALL", "OVERDUE", "DUE_7_DAYS", "NO_DUE_DATE"]);
const monthSchema = z
  .string()
  .regex(/^\d{4}-\d{2}$/)
  .refine((value) => {
    const [yearText, monthText] = value.split("-");
    const year = Number(yearText);
    const month = Number(monthText);
    return year >= 1970 && year <= 9999 && month >= 1 && month <= 12;
  }, "Calendar month is invalid");

const scopeSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
});

const createSchema = z.discriminatedUnion("surface", [
  scopeSchema.extend({
    surface: z.literal("KANBAN"),
    name: z.string().trim().min(1).max(80),
    config: z.object({ dueFilter: dueFilterSchema }).strict(),
  }),
  scopeSchema.extend({
    surface: z.literal("CALENDAR"),
    name: z.string().trim().min(1).max(80),
    config: z.object({ month: monthSchema.nullable() }).strict(),
  }),
]);

function savedViewError(error: unknown) {
  if (error instanceof SavedMaintenanceViewError) {
    const status =
      error.code === "DUPLICATE_VIEW_NAME"
        ? 409
        : error.code === "VIEW_NOT_FOUND"
          ? 404
          : error.code === "VIEW_LIMIT_REACHED"
            ? 409
            : 400;
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
  if (!site) {
    return apiError(404, "SITE_NOT_FOUND", "Active site not found in organization scope");
  }
  return auth;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = scopeSchema
    .extend({ surface: surfaceSchema })
    .safeParse({
      organizationId: url.searchParams.get("organizationId"),
      siteId: url.searchParams.get("siteId"),
      surface: url.searchParams.get("surface"),
    });
  if (!parsed.success) {
    return apiError(
      400,
      "INVALID_QUERY",
      "organizationId, siteId and a supported surface are required",
    );
  }

  const auth = await authorize(request, parsed.data.organizationId, parsed.data.siteId);
  if (auth instanceof Response) return auth;

  return apiData(
    await listSavedMaintenanceViews({
      organizationId: parsed.data.organizationId,
      siteId: parsed.data.siteId,
      userId: auth.session.user.id,
      surface: parsed.data.surface,
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
    return apiError(400, "INVALID_PAYLOAD", "Invalid saved planning view", parsed.error.flatten());
  }

  const auth = await authorize(request, parsed.data.organizationId, parsed.data.siteId);
  if (auth instanceof Response) return auth;

  try {
    return apiData(
      await createSavedMaintenanceView({
        organizationId: parsed.data.organizationId,
        siteId: parsed.data.siteId,
        userId: auth.session.user.id,
        surface: parsed.data.surface,
        name: parsed.data.name,
        config: parsed.data.config,
      }),
      { status: 201 },
    );
  } catch (error) {
    return savedViewError(error);
  }
}
