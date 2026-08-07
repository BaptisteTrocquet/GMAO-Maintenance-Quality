import { db } from "@/lib/db";
import { NextResponse } from "next/server";
import { z } from "zod";

const schema = z.object({ siteId: z.string().min(1), locationId: z.string().optional().nullable(), parentAssetId: z.string().optional().nullable(), code: z.string().min(1).max(50), name: z.string().min(1).max(200), description: z.string().optional(), criticality: z.enum(["LOW","MEDIUM","HIGH","CRITICAL"]).optional() });

export async function GET() { return NextResponse.json({ data: await db.asset.findMany({ include: { site: true, location: true, parentAsset: true } }) }); }
export async function POST(request: Request) { const parsed=schema.safeParse(await request.json()); if(!parsed.success) return NextResponse.json({error:parsed.error.flatten()},{status:400}); const asset=await db.asset.create({data:parsed.data}); return NextResponse.json({data:asset},{status:201}); }
