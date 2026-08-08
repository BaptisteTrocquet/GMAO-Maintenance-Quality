import { NextResponse } from "next/server";
import { checkReadiness } from "@/lib/ops/health";

const NO_STORE_HEADERS = {
  "cache-control": "no-store, max-age=0",
};

export async function GET() {
  const result = await checkReadiness();
  return NextResponse.json(
    {
      status: result.ready ? "ready" : "not_ready",
      checks: { database: result.database },
    },
    {
      status: result.ready ? 200 : 503,
      headers: NO_STORE_HEADERS,
    },
  );
}
