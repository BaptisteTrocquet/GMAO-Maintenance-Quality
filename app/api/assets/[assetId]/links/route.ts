import { z } from "zod";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { db } from "@/lib/db";

const querySchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
});

const createSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("part"),
    organizationId: z.string().min(1),
    siteId: z.string().min(1),
    partId: z.string().min(1),
    quantityRecommended: z.number().positive().optional(),
  }),
  z.object({
    type: z.literal("document"),
    organizationId: z.string().min(1),
    siteId: z.string().min(1),
    documentId: z.string().min(1),
    relation: z.string().trim().min(1).max(50).optional(),
  }),
  z.object({
    type: z.literal("attachment"),
    organizationId: z.string().min(1),
    siteId: z.string().min(1),
    fileName: z.string().min(1).max(255),
    storageKey: z.string().min(1).max(500),
    mimeType: z.string().max(150).optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    kind: z.enum(["ATTACHMENT", "PHOTO"]).optional(),
  }),
]);

const deleteSchema = z.object({
  type: z.literal("document"),
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  documentId: z.string().min(1),
});

function authorize(
  scope: Parameters<typeof assertSitePermission>[0],
  siteId: string,
  permission: "asset:read" | "asset:write",
) {
  try {
    assertSitePermission(scope, siteId, permission);
    return null;
  } catch (error) {
    if (error instanceof AccessDeniedError) return apiError(403, "ACCESS_DENIED", error.message);
    throw error;
  }
}

async function getScopedAsset(organizationId: string, siteId: string, assetId: string) {
  return db.asset.findFirst({
    where: { id: assetId, siteId, archivedAt: null, site: { organizationId, active: true } },
    select: { id: true },
  });
}

async function parseJson(request: Request) {
  try {
    return { body: await request.json() } as const;
  } catch {
    return { error: apiError(400, "INVALID_JSON", "Request body must be valid JSON") } as const;
  }
}

export async function GET(request: Request, context: { params: Promise<{ assetId: string }> }) {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    organizationId: url.searchParams.get("organizationId"),
    siteId: url.searchParams.get("siteId"),
  });
  if (!parsed.success) return apiError(400, "INVALID_SCOPE", "organizationId and siteId are required");

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, parsed.data.siteId, "asset:read");
  if (denied) return denied;

  const { assetId } = await context.params;
  if (!(await getScopedAsset(parsed.data.organizationId, parsed.data.siteId, assetId))) {
    return apiError(404, "ASSET_NOT_FOUND", "Asset not found");
  }

  const [parts, documents, attachments] = await Promise.all([
    db.assetPart.findMany({ where: { assetId }, include: { part: true } }),
    db.assetDocument.findMany({ where: { assetId }, include: { document: true } }),
    db.assetAttachment.findMany({ where: { assetId }, orderBy: { createdAt: "desc" } }),
  ]);

  return apiData({ parts, documents, attachments });
}

export async function POST(request: Request, context: { params: Promise<{ assetId: string }> }) {
  const json = await parseJson(request);
  if ("error" in json) return json.error;
  const parsed = createSchema.safeParse(json.body);
  if (!parsed.success) return apiError(400, "INVALID_PAYLOAD", "Invalid asset link payload", parsed.error.flatten());

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, parsed.data.siteId, "asset:write");
  if (denied) return denied;

  const { assetId } = await context.params;
  if (!(await getScopedAsset(parsed.data.organizationId, parsed.data.siteId, assetId))) {
    return apiError(404, "ASSET_NOT_FOUND", "Asset not found");
  }

  if (parsed.data.type === "part") {
    const part = await db.part.findFirst({
      where: { id: parsed.data.partId, organizationId: parsed.data.organizationId },
      select: { id: true },
    });
    if (!part) return apiError(404, "PART_NOT_FOUND", "Part not found in organization");

    const link = await db.assetPart.upsert({
      where: { assetId_partId: { assetId, partId: parsed.data.partId } },
      update: { quantityRecommended: parsed.data.quantityRecommended },
      create: { assetId, partId: parsed.data.partId, quantityRecommended: parsed.data.quantityRecommended },
    });
    return apiData(link, { status: 201 });
  }

  if (parsed.data.type === "document") {
    const document = await db.document.findFirst({
      where: { id: parsed.data.documentId, organizationId: parsed.data.organizationId },
      select: { id: true },
    });
    if (!document) return apiError(404, "DOCUMENT_NOT_FOUND", "Document not found in organization");

    const link = await db.assetDocument.upsert({
      where: { assetId_documentId: { assetId, documentId: parsed.data.documentId } },
      update: { relation: parsed.data.relation ?? "APPLICABLE" },
      create: { assetId, documentId: parsed.data.documentId, relation: parsed.data.relation ?? "APPLICABLE" },
    });
    await db.auditLog.create({
      data: {
        actorId: auth.session.user.id,
        entityType: "AssetDocument",
        entityId: `${assetId}:${parsed.data.documentId}`,
        action: "LINKED",
        afterJson: JSON.stringify(link),
      },
    });
    return apiData(link, { status: 201 });
  }

  const attachment = await db.assetAttachment.create({
    data: {
      assetId,
      fileName: parsed.data.fileName,
      storageKey: parsed.data.storageKey,
      mimeType: parsed.data.mimeType,
      sizeBytes: parsed.data.sizeBytes,
      kind: parsed.data.kind ?? "ATTACHMENT",
      createdBy: auth.session.user.id,
    },
  });
  await db.auditLog.create({
    data: {
      actorId: auth.session.user.id,
      entityType: "AssetAttachment",
      entityId: attachment.id,
      action: "CREATED",
      afterJson: JSON.stringify(attachment),
    },
  });
  return apiData(attachment, { status: 201 });
}

export async function DELETE(request: Request, context: { params: Promise<{ assetId: string }> }) {
  const json = await parseJson(request);
  if ("error" in json) return json.error;
  const parsed = deleteSchema.safeParse(json.body);
  if (!parsed.success) return apiError(400, "INVALID_PAYLOAD", "Invalid asset unlink payload", parsed.error.flatten());

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, parsed.data.siteId, "asset:write");
  if (denied) return denied;

  const { assetId } = await context.params;
  if (!(await getScopedAsset(parsed.data.organizationId, parsed.data.siteId, assetId))) {
    return apiError(404, "ASSET_NOT_FOUND", "Asset not found");
  }
  const document = await db.document.findFirst({
    where: { id: parsed.data.documentId, organizationId: parsed.data.organizationId },
    select: { id: true },
  });
  if (!document) return apiError(404, "DOCUMENT_NOT_FOUND", "Document not found in organization");

  const existing = await db.assetDocument.findUnique({
    where: { assetId_documentId: { assetId, documentId: parsed.data.documentId } },
  });
  if (!existing) return apiError(404, "LINK_NOT_FOUND", "Document is not linked to this asset");

  await db.assetDocument.delete({
    where: { assetId_documentId: { assetId, documentId: parsed.data.documentId } },
  });
  await db.auditLog.create({
    data: {
      actorId: auth.session.user.id,
      entityType: "AssetDocument",
      entityId: `${assetId}:${parsed.data.documentId}`,
      action: "UNLINKED",
      beforeJson: JSON.stringify(existing),
    },
  });
  return apiData({ unlinked: true, assetId, documentId: parsed.data.documentId });
}
