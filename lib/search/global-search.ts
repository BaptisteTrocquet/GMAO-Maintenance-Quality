import type { MembershipRole } from "@prisma/client";
import { db } from "@/lib/db";
import { can } from "@/lib/permissions";

const RESULT_LIMIT_PER_KIND = 8;

export type GlobalSearchKind = "WORK_ORDER" | "ASSET" | "DOCUMENT" | "PART";

export type GlobalSearchResult = {
  kind: GlobalSearchKind;
  id: string;
  code: string;
  title: string;
  detail: string | null;
  href: string;
};

export class GlobalSearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GlobalSearchError";
  }
}

function normalizedQuery(value: string) {
  const query = value.trim().replace(/\s+/g, " ");
  if (query.length < 2 || query.length > 100) {
    throw new GlobalSearchError("Search query must contain 2 to 100 characters");
  }
  return query;
}

export async function searchGlobal(input: {
  organizationId: string;
  siteId: string;
  role: MembershipRole;
  query: string;
}) {
  const query = normalizedQuery(input.query);
  const insensitive = { contains: query, mode: "insensitive" as const };

  const [workOrders, assets, documents, parts] = await Promise.all([
    can(input.role, "work:read")
      ? db.workOrder.findMany({
          where: {
            siteId: input.siteId,
            site: { organizationId: input.organizationId, active: true },
            OR: [
              { number: insensitive },
              { title: insensitive },
              { description: insensitive },
            ],
          },
          select: {
            id: true,
            number: true,
            title: true,
            status: true,
            asset: { select: { code: true } },
          },
          orderBy: { updatedAt: "desc" },
          take: RESULT_LIMIT_PER_KIND,
        })
      : Promise.resolve([]),
    can(input.role, "asset:read")
      ? db.asset.findMany({
          where: {
            siteId: input.siteId,
            site: { organizationId: input.organizationId, active: true },
            archivedAt: null,
            OR: [
              { code: insensitive },
              { name: insensitive },
              { description: insensitive },
              { manufacturer: insensitive },
              { model: insensitive },
              { serialNumber: insensitive },
            ],
          },
          select: { id: true, code: true, name: true, status: true, category: true },
          orderBy: { updatedAt: "desc" },
          take: RESULT_LIMIT_PER_KIND,
        })
      : Promise.resolve([]),
    can(input.role, "document:read")
      ? db.document.findMany({
          where: {
            organizationId: input.organizationId,
            OR: [
              { code: insensitive },
              { title: insensitive },
              { description: insensitive },
              { owner: insensitive },
              { type: insensitive },
            ],
          },
          select: { id: true, code: true, title: true, type: true, owner: true },
          orderBy: { updatedAt: "desc" },
          take: RESULT_LIMIT_PER_KIND,
        })
      : Promise.resolve([]),
    can(input.role, "inventory:read")
      ? db.part.findMany({
          where: {
            organizationId: input.organizationId,
            active: true,
            OR: [
              { sku: insensitive },
              { name: insensitive },
              { description: insensitive },
            ],
          },
          select: { id: true, sku: true, name: true, unit: true, quantityOnHand: true },
          orderBy: { updatedAt: "desc" },
          take: RESULT_LIMIT_PER_KIND,
        })
      : Promise.resolve([]),
  ]);

  const results: GlobalSearchResult[] = [
    ...workOrders.map((workOrder) => ({
      kind: "WORK_ORDER" as const,
      id: workOrder.id,
      code: workOrder.number,
      title: workOrder.title,
      detail: [workOrder.status, workOrder.asset?.code].filter(Boolean).join(" · ") || null,
      href: `/maintenance/${workOrder.id}`,
    })),
    ...assets.map((asset) => ({
      kind: "ASSET" as const,
      id: asset.id,
      code: asset.code,
      title: asset.name,
      detail: [asset.status, asset.category].filter(Boolean).join(" · ") || null,
      href: `/assets/${asset.id}`,
    })),
    ...documents.map((document) => ({
      kind: "DOCUMENT" as const,
      id: document.id,
      code: document.code,
      title: document.title,
      detail: [document.type, document.owner].filter(Boolean).join(" · ") || null,
      href: `/documents/${document.id}`,
    })),
    ...parts.map((part) => ({
      kind: "PART" as const,
      id: part.id,
      code: part.sku,
      title: part.name,
      detail: `${part.quantityOnHand} ${part.unit} on hand`,
      href: `/inventory?part=${encodeURIComponent(part.id)}`,
    })),
  ];

  return {
    query,
    results,
    counts: {
      workOrders: workOrders.length,
      assets: assets.length,
      documents: documents.length,
      parts: parts.length,
    },
  };
}
