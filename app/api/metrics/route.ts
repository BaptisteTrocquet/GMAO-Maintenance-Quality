import { db } from "@/lib/db";
import { applicationMetrics, prometheusContentType } from "@/lib/metrics";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  applicationMetrics.recordMetricsScrape();

  let databaseReady = false;
  try {
    await db.$queryRaw`SELECT 1`;
    databaseReady = true;
  } catch {
    // The metrics endpoint remains scrapeable while dependencies are degraded.
    // Failure details are deliberately excluded; readiness and structured logs carry diagnostics.
  }

  return new Response(applicationMetrics.renderPrometheus({ databaseReady }), {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": prometheusContentType,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
