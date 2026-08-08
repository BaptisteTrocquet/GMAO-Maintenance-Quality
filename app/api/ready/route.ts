import { apiData, apiError } from "@/lib/api-response";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

function noStore<T extends Response>(response: T) {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`;

    return noStore(
      apiData({
        status: "ready",
        service: "opengmao",
        checks: {
          database: "reachable",
        },
      }),
    );
  } catch {
    logger.warn("readiness_check_failed", {
      dependency: "database",
    });

    return noStore(
      apiError(503, "SERVICE_UNAVAILABLE", "Service is not ready"),
    );
  }
}
