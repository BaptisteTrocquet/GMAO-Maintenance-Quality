import { timingSafeEqual } from "node:crypto";
import { apiData, apiError } from "@/lib/api-response";
import { processWebhookQueue } from "@/lib/webhooks/worker";

function workerSecret() {
  const secret = process.env.WEBHOOK_WORKER_SECRET;
  return secret && secret.length >= 32 ? secret : null;
}

function authorized(request: Request, secret: string) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return false;
  const supplied = authorization.slice("Bearer ".length).trim();
  const expectedBuffer = Buffer.from(secret);
  const suppliedBuffer = Buffer.from(supplied);
  return (
    expectedBuffer.length === suppliedBuffer.length &&
    timingSafeEqual(expectedBuffer, suppliedBuffer)
  );
}

export async function POST(request: Request) {
  const secret = workerSecret();
  if (!secret) {
    return apiError(
      503,
      "WEBHOOK_WORKER_NOT_CONFIGURED",
      "WEBHOOK_WORKER_SECRET must contain at least 32 characters",
    );
  }
  if (!authorized(request, secret)) {
    return apiError(401, "WEBHOOK_WORKER_UNAUTHORIZED", "Webhook worker authorization failed");
  }

  return apiData(await processWebhookQueue());
}
