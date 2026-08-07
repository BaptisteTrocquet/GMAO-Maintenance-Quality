import { apiData, apiError } from "@/lib/api-response";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`;

    return apiData({
      status: "ok",
      service: "opengmao",
      database: "reachable",
    });
  } catch (error) {
    logger.error("health_check_failed", {
      error: error instanceof Error ? error.message : "unknown_error",
    });

    return apiError(503, "SERVICE_UNAVAILABLE", "Database is not reachable");
  }
}
