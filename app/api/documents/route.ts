import { db } from "@/lib/db";
import { NextResponse } from "next/server";
import { z } from "zod";

const schema=z.object({code:z.string().min(1),title:z.string().min(1),type:z.string().min(1),owner:z.string().optional(),description:z.string().optional()});
export async function GET(){return NextResponse.json({data:await db.document.findMany({include:{revisions:{orderBy:{createdAt:"desc"}},assetDocuments:{include:{asset:true}}}})});}
export async function POST(request:Request){const parsed=schema.safeParse(await request.json());if(!parsed.success)return NextResponse.json({error:parsed.error.flatten()},{status:400});const row=await db.document.create({data:parsed.data});return NextResponse.json({data:row},{status:201});}
