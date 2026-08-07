import { apiError } from "@/lib/api-response";
import { ControlledCopyError } from "@/lib/documents/controlled-copy";
import { authenticateApiKeyRequest } from "@/lib/integrations/api-keys";
import { controlledDocumentResponse } from "@/lib/public-documents/response";
import {
  issuePublicControlledDocument,
  PublicDocumentViewerError,
} from "@/lib/public-documents/viewer";

export async function GET(request: Request) {
  const auth = await authenticateApiKeyRequest(request, "document:read");
  if ("error" in auth) return auth.error;

  const url = new URL(request.url);
  const documentCode = url.searchParams.get("documentCode")?.trim();
  if (!documentCode) {
    return apiError(400, "DOCUMENT_CODE_REQUIRED", "documentCode query parameter is required");
  }

  const rawAsOf = url.searchParams.get("asOf");
  const asOf = rawAsOf ? new Date(rawAsOf) : new Date();
  if (Number.isNaN(asOf.getTime())) return apiError(400, "INVALID_AS_OF", "asOf must be a valid date");

  try {
    return controlledDocumentResponse(
      await issuePublicControlledDocument({
        token: auth.token,
        documentCode,
        asOf,
        origin: null,
      }),
    );
  } catch (error) {
    if (error instanceof PublicDocumentViewerError) {
      return apiError(error.code === "RATE_LIMITED" ? 429 : 404, error.code, error.message);
    }
    if (error instanceof ControlledCopyError) {
      return apiError(
        error.code === "EFFECTIVE_FILE_UNAVAILABLE" ? 409 : 404,
        error.code,
        error.message,
      );
    }
    throw error;
  }
}
