import { z } from "zod";
import { AccessDeniedError, assertPermission, assertSitePermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { db } from "@/lib/db";

const querySchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
});

const mutationSchema = z.object({
  organizationId: z.string().min(1),
  siteId: z.string().min(1),
  assetId: z.string().min(1),
  relation: z.string().trim().min(1).max(50).optional(),
});

function authorize(
  scope: Parameters<typeof assertPermission>[0],
  siteId: string,
  permission: "document:read" | "document:manage",
) {
  try {
    assertPermission(scope, permission);
    assertSitePermission(scope, siteId, "asset:read");
    return null;
  } catch (error) {
    if (error instanceof AccessDeniedError) return apiError(403, "ACCESS_DENIED", error.message);
    throw error;
  }
}

async function getDocument(organizationId: string, documentId: string) {
  return db.document.findFirst({
    where: { id: documentId, organizationId },
    select: { id: true, code: true, title: true },
  });
}

async function getAsset(organizationId: string, siteId: string, assetId: string) {
  return db.asset.findFirst({
    where: {
      id: assetId,
      siteId,
      archivedAt: null,
      site: { organizationId, active: true },
    },
    select: { id: true, code: true, name: true },
  });
}

async function parseJson(request: Request) {
  try {
    return { body: await request.json() } as const;
  } catch {
    return { error: apiError(400, "INVALID_JSON", "Request body must be valid JSON") } as const;
  }
}

export async function GET(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    organizationId: url.searchParams.get("organizationId"),
    siteId: url.searchParams.get("siteId"),
  });
  if (!parsed.success) return apiError(400, "INVALID_SCOPE", "organizationId and siteId are required");

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, parsed.data.siteId, "document:read");
  if (denied) return denied;

  const { documentId } = await context.params;
  if (!(await getDocument(parsed.data.organizationId, documentId))) {
    return apiError(404, "DOCUMENT_NOT_FOUND", "Document not found");
  }

  const links = await db.assetDocument.findMany({
    where: {
      documentId,
      asset: {
        siteId: parsed.data.siteId,
        archivedAt: null,
        site: { organizationId: parsed.data.organizationId, active: true },
      },
    },
    include: {
      asset: {
        select: { id: true, code: true, name: true, status: true, criticality: true },
      },
    },
    orderBy: { asset: { code: "asc" } },
  });
  return apiData(links);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  const json = await parseJson(request);
  if ("error" in json) return json.error;
  const parsed = mutationSchema.safeParse(json.body);
  if (!parsed.success) return apiError(400, "INVALID_PAYLOAD", "Invalid applicability payload", parsed.error.flatten());

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, parsed.data.siteId, "document:manage");
  if (denied) return denied;

  const { documentId } = await context.params;
  const document = await getDocument(parsed.data.organizationId, documentId);
  if (!document) return apiError(404, "DOCUMENT_NOT_FOUND", "Document not found");
  const asset = await getAsset(parsed.data.organizationId, parsed.data.siteId, parsed.data.assetId);
  if (!asset) return apiError(404, "ASSET_NOT_FOUND", "Asset not found in site");

  const link = await db.assetDocument.upsert({
    where: { assetId_documentId: { assetId: asset.id, documentId: document.id } },
    update: { relation: parsed.data.relation ?? "APPLICABLE" },
    create: {
      assetId: asset.id,
      documentId: document.id,
      relation: parsed.data.relation ?? "APPLICABLE",
    },
  });
  await db.auditLog.create({
    data: {
      actorId: auth.session.user.id,
      entityType: "AssetDocument",
      entityId: `${asset.id}:${document.id}`,
      action: "LINKED",
      afterJson: JSON.stringify({ ...link, assetCode: asset.code, documentCode: document.code }),
    },
  });
  return apiData(link, { status: 201 });
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  const json = await parseJson(request);
  if ("error" in json) return json.error;
  const parsed = mutationSchema.safeParse(json.body);
  if (!parsed.success) return apiError(400, "INVALID_PAYLOAD", "Invalid applicability removal payload", parsed.error.flatten());

  const auth = await authenticateRequest(request, parsed.data.organizationId);
  if ("error" in auth) return auth.error;
  const denied = authorize(auth.tenant.scope, parsed.data.siteId, "document:manage");
  if (denied) return denied;

  const { documentId } = await context.params;
  const document = await getDocument(parsed.data.organizationId, documentId);
  if (!document) return apiError(404, "DOCUMENT_NOT_FOUND", "Document not found");
  const asset = await getAsset(parsed.data.organizationId, parsed.data.siteId, parsed.data.assetId);
  if (!asset) return apiError(404, "ASSET_NOT_FOUND", "Asset not found in site");

  const existing = await db.assetDocument.findUnique({
    where: { assetId_documentId: { assetId: asset.id, documentId: document.id } },
  });
  if (!existing) return apiError(404, "LINK_NOT_FOUND", "Document is not applicable to this asset");

  await db.assetDocument.delete({
    where: { assetId_documentId: { assetId: asset.id, documentId: document.id } },
  });
  await db.auditLog.create({
    data: {
      actorId: auth.session.user.id,
      entityType: "AssetDocument",
      entityId: `${asset.id}:${document.id}`,
      action: "UNLINKED",
      beforeJson: JSON.stringify({ ...existing, assetCode: asset.code, documentCode: document.code }),
    },
  });
  return apiData({ unlinked: true, assetId: asset.id, documentId: document.id });
}
