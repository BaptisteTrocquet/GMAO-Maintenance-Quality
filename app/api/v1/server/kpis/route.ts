import { apiData, apiError } from "@/lib/api-response";
import { authenticateApiKeyRequest } from "@/lib/integrations/api-keys";
import { getPublicKpiCard, PublicKpiCardError } from "@/lib/public-kpis/card";

export async function GET(request: Request) {
  const auth = await authenticateApiKeyRequest(request, "kpi:read");
  if ("error" in auth) return auth.error;

  try {
    return apiData(await getPublicKpiCard({ token: auth.token, origin: null }));
  } catch (error) {
    if (error instanceof PublicKpiCardError) return apiError(429, error.code, error.message);
    throw error;
  }
}
