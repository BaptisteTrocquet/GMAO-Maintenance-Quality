import { apiData } from "@/lib/api-response";

export const dynamic = "force-dynamic";

export async function GET() {
  return apiData(
    {
      status: "ok",
      service: "opengmao",
      checks: {
        process: "alive",
      },
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
