import { z } from "zod";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import {
  deleteSavedPlanningView,
  SavedPlanningViewError,
} from "@/lib/maintenance/saved-planning-views";

const schema = z.object({ organizationId: z.string().min(1) });

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ viewId: string }> },
) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "INVALID_PAYLOAD", "organizationId is required", parsed.error.flatten());
  }

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const { viewId } = await params;

  try {
    const view = await deleteSavedPlanningView({
      organizationId: parsed.data.organizationId,
      userId: auth.session.user.id,
      viewId,
    });
    return apiData(view);
  } catch (error) {
    if (error instanceof SavedPlanningViewError) {
      return apiError(404, error.code, error.message);
    }
    throw error;
  }
}
