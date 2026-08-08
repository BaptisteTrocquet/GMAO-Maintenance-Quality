import { NextResponse } from "next/server";

const NO_STORE_HEADERS = {
  "cache-control": "no-store, max-age=0",
};

export async function GET() {
  return NextResponse.json(
    { status: "ok" },
    { status: 200, headers: NO_STORE_HEADERS },
  );
}
