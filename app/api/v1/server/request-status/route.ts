import { apiData, apiError } from "@/lib/api-response";
import { authenticateApiKeyRequest } from "@/lib/integrations/api-keys";
import {
  getPublicMaintenanceRequestStatus,
  PublicRequestStatusError,
} from "@/lib/public-requests/status";

export async function GET(request: Request) {
  const auth = await authenticateApiKeyRequest(request, "maintenance:request:status");
  if ("error" in auth) return auth.error;

  const trackingId = new URL(request.url).searchParams.get("trackingId")?.trim();
  if (!trackingId) {
    return apiError(400, "TRACKING_ID_REQUIRED", "trackingId query parameter is required");
  }

  try {
    return apiData(
      await getPublicMaintenanceRequestStatus({
        token: auth.token,
        trackingId,
        origin: null,
      }),
    );
  } catch (error) {
    if (error instanceof PublicRequestStatusError) {
      const status =
        error.code === "RATE_LIMITED"
          ? 429
          : error.code === "TRACKING_NOT_FOUND"
            ? 404
            : 409;
      return apiError(status, error.code, error.message);
    }
    throw error;
  }
}
