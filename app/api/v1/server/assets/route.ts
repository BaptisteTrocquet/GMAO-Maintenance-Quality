import { apiData, apiError } from "@/lib/api-response";
import { authenticateApiKeyRequest } from "@/lib/integrations/api-keys";
import { getPublicAssetCard, PublicAssetCardError } from "@/lib/public-assets/card";

export async function GET(request: Request) {
  const auth = await authenticateApiKeyRequest(request, "asset:read");
  if ("error" in auth) return auth.error;

  const assetCode = new URL(request.url).searchParams.get("assetCode")?.trim();
  if (!assetCode) return apiError(400, "ASSET_CODE_REQUIRED", "assetCode query parameter is required");

  try {
    return apiData(
      await getPublicAssetCard({
        token: auth.token,
        assetCode,
        origin: null,
      }),
    );
  } catch (error) {
    if (error instanceof PublicAssetCardError) {
      return apiError(error.code === "RATE_LIMITED" ? 429 : 404, error.code, error.message);
    }
    throw error;
  }
}
