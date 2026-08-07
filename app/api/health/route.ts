import { db } from "@/lib/db";
import { NextResponse } from "next/server";

export async function GET() {
  await db.$queryRaw`SELECT 1`;
  return NextResponse.json({ status: "ok", service: "opengmao" });
}
