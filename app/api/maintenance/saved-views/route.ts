import { z } from "zod";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import {
  createSavedPlanningView,
  listSavedPlanningViews,
  SavedPlanningViewError,
} from "@/lib/maintenance/saved-planning-views";

const createSchema = z.object({
  organizationId: z.string().min(1),
  name: z.string().min(1).max(60),
  path: z.string().min(1),
  query: z.string().max(500).nullable().optional(),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const organizationId = url.searchParams.get("organizationId") ?? "";
  if (!organizationId) {
    return apiError(400, "INVALID_PAYLOAD", "organizationId is required");
  }

  const auth = await authenticateRequest(request, organizationId);
  if ("error" in auth) return auth.error;

  const views = await listSavedPlanningViews({
    organizationId,
    userId: auth.session.user.id,
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
    return apiError(400, "INVALID_PAYLOAD", "Invalid saved-view payload", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;

  try {
    const view = await createSavedPlanningView({
      organizationId: parsed.data.organizationId,
      userId: auth.session.user.id,
      name: parsed.data.name,
      path: parsed.data.path,
      query: parsed.data.query,
    });
    return apiData(view, { status: 201 });
  } catch (error) {
    if (error instanceof SavedPlanningViewError) {
      return apiError(
        error.code === "VIEW_LIMIT_REACHED" ? 409 : 400,
        error.code,
        error.message,
      );
    }
    throw error;
  }
}
