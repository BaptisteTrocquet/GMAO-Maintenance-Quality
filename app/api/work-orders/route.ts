import { db } from "@/lib/db";
import { NextResponse } from "next/server";
import { z } from "zod";

const schema=z.object({ assetId:z.string().optional().nullable(), title:z.string().min(1), description:z.string().optional(), type:z.enum(["CORRECTIVE","PREVENTIVE","INSPECTION","IMPROVEMENT","SAFETY","OTHER"]), priority:z.enum(["LOW","NORMAL","HIGH","URGENT"]).default("NORMAL") });
async function nextNumber(){const count=await db.workOrder.count();return `WO-${String(count+1).padStart(6,"0")}`;}
export async function GET(){return NextResponse.json({data:await db.workOrder.findMany({include:{asset:true,assignee:true},orderBy:{requestedAt:"desc"}})});}
export async function POST(request:Request){const parsed=schema.safeParse(await request.json());if(!parsed.success)return NextResponse.json({error:parsed.error.flatten()},{status:400});const row=await db.workOrder.create({data:{...parsed.data,number:await nextNumber()}});return NextResponse.json({data:row},{status:201});}
