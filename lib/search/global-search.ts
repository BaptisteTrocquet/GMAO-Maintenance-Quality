import type { MembershipRole } from "@prisma/client";
import { db } from "@/lib/db";
import { can } from "@/lib/permissions";

export const GLOBAL_SEARCH_MIN_LENGTH = 2;
export const GLOBAL_SEARCH_MAX_LENGTH = 80;
export const GLOBAL_SEARCH_RESULTS_PER_KIND = 6;
export const GLOBAL_SEARCH_CANDIDATE_LIMIT = 30;
export const GLOBAL_SEARCH_QUALITY_SCAN_LIMIT = 500;

export type GlobalSearchKind = "ASSET" | "WORK_ORDER" | "DOCUMENT" | "PART" | "QUALITY";

export type GlobalSearchResult = {
  kind: GlobalSearchKind;
  id: string;
  label: string;
  description: string;
  meta: string;
  href: string;
  score: number;
};

type QualitySnapshot = {
  id: string;
  eventNumber: string;
  organizationId: string;
  siteId: string;
  type: string;
  severity: string;
  status: string;
  title: string;
  description: string | null;
  updatedAt: string;
};

export function normalizeGlobalSearchQuery(value: string | null | undefined) {
  const query = value?.trim().replace(/\s+/g, " ") ?? "";
  if (query.length < GLOBAL_SEARCH_MIN_LENGTH) return null;
  return query.slice(0, GLOBAL_SEARCH_MAX_LENGTH);
}

function textScore(query: string, values: Array<string | null | undefined>) {
  const needle = query.toLocaleLowerCase();
  let score = 100;
  for (const raw of values) {
    const value = raw?.trim().toLocaleLowerCase();
    if (!value) continue;
    if (value === needle) score = Math.min(score, 0);
    else if (value.startsWith(needle)) score = Math.min(score, 10);
    else if (value.includes(needle)) score = Math.min(score, 20);
  }
  return score;
}

function rank(query: string, results: GlobalSearchResult[]) {
  return results
    .map((result) => ({ ...result, score: Math.min(result.score, textScore(query, [result.label, result.description, result.meta])) }))
    .sort((left, right) => left.score - right.score || left.label.localeCompare(right.label))
    .slice(0, GLOBAL_SEARCH_RESULTS_PER_KIND);
}

function parseQualitySnapshot(value: string | null): QualitySnapshot | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<QualitySnapshot>;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.eventNumber !== "string" ||
      typeof parsed.organizationId !== "string" ||
      typeof parsed.siteId !== "string" ||
      typeof parsed.type !== "string" ||
      typeof parsed.severity !== "string" ||
      typeof parsed.status !== "string" ||
      typeof parsed.title !== "string" ||
      !(parsed.description === null || typeof parsed.description === "string") ||
      typeof parsed.updatedAt !== "string"
    ) {
      return null;
    }
    return parsed as QualitySnapshot;
  } catch {
    return null;
  }
}

async function searchQuality(input: { organizationId: string; siteId: string; query: string }) {
  const organizationMarker = `"organizationId":"${input.organizationId}"`;
  const siteMarker = `"siteId":"${input.siteId}"`;
  const logs = await db.auditLog.findMany({
    where: {
      entityType: "QualityEvent",
      AND: [
        { afterJson: { contains: organizationMarker } },
        { afterJson: { contains: siteMarker } },
      ],
    },
    orderBy: { createdAt: "desc" },
    select: { entityId: true, afterJson: true },
    take: GLOBAL_SEARCH_QUALITY_SCAN_LIMIT,
  });

  const latest = new Map<string, QualitySnapshot>();
  for (const log of logs) {
    if (latest.has(log.entityId)) continue;
    const snapshot = parseQualitySnapshot(log.afterJson);
    if (snapshot) latest.set(log.entityId, snapshot);
  }

  const needle = input.query.toLocaleLowerCase();
  const matches: GlobalSearchResult[] = [];
  for (const event of latest.values()) {
    const haystack = [event.eventNumber, event.title, event.description, event.type, event.severity, event.status]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase();
    if (!haystack.includes(needle)) continue;
    matches.push({
      kind: "QUALITY",
      id: event.id,
      label: `${event.eventNumber} · ${event.title}`,
      description: event.description ?? "Quality event",
      meta: `${event.type} · ${event.severity} · ${event.status}`,
      href: `/quality/${event.id}`,
      score: textScore(input.query, [event.eventNumber, event.title, event.description]),
    });
  }
  return rank(input.query, matches);
}

export async function searchGlobal(input: {
  organizationId: string;
  siteId: string;
  role: MembershipRole;
  query: string;
}) {
  const query = normalizeGlobalSearchQuery(input.query);
  if (!query) return [] as GlobalSearchResult[];
  const insensitive = { contains: query, mode: "insensitive" as const };

  const [assets, workOrders, documents, parts, quality] = await Promise.all([
    can(input.role, "asset:read")
      ? db.asset.findMany({
          where: {
            siteId: input.siteId,
            site: { organizationId: input.organizationId, active: true },
            archivedAt: null,
            OR: [{ code: insensitive }, { name: insensitive }, { description: insensitive }],
          },
          select: { id: true, code: true, name: true, description: true, status: true, criticality: true },
          orderBy: { code: "asc" },
          take: GLOBAL_SEARCH_CANDIDATE_LIMIT,
        })
      : Promise.resolve([]),
    can(input.role, "work:read")
      ? db.workOrder.findMany({
          where: {
            siteId: input.siteId,
            site: { organizationId: input.organizationId, active: true },
            OR: [{ number: insensitive }, { title: insensitive }, { description: insensitive }],
          },
          select: { id: true, number: true, title: true, description: true, status: true, priority: true },
          orderBy: { requestedAt: "desc" },
          take: GLOBAL_SEARCH_CANDIDATE_LIMIT,
        })
      : Promise.resolve([]),
    can(input.role, "document:read")
      ? db.document.findMany({
          where: {
            organizationId: input.organizationId,
            OR: [{ code: insensitive }, { title: insensitive }, { description: insensitive }, { owner: insensitive }],
          },
          select: { id: true, code: true, title: true, description: true, type: true, owner: true },
          orderBy: { code: "asc" },
          take: GLOBAL_SEARCH_CANDIDATE_LIMIT,
        })
      : Promise.resolve([]),
    can(input.role, "inventory:read")
      ? db.part.findMany({
          where: {
            organizationId: input.organizationId,
            active: true,
            OR: [{ sku: insensitive }, { name: insensitive }, { description: insensitive }],
          },
          select: { id: true, sku: true, name: true, description: true, unit: true, quantityOnHand: true },
          orderBy: { sku: "asc" },
          take: GLOBAL_SEARCH_CANDIDATE_LIMIT,
        })
      : Promise.resolve([]),
    can(input.role, "quality:read")
      ? searchQuality({ organizationId: input.organizationId, siteId: input.siteId, query })
      : Promise.resolve([]),
  ]);

  const resultGroups: GlobalSearchResult[][] = [
    rank(
      query,
      assets.map((asset) => ({
        kind: "ASSET" as const,
        id: asset.id,
        label: `${asset.code} · ${asset.name}`,
        description: asset.description ?? "Asset",
        meta: `${asset.status} · ${asset.criticality}`,
        href: `/assets/${asset.id}`,
        score: textScore(query, [asset.code, asset.name, asset.description]),
      })),
    ),
    rank(
      query,
      workOrders.map((workOrder) => ({
        kind: "WORK_ORDER" as const,
        id: workOrder.id,
        label: `${workOrder.number} · ${workOrder.title}`,
        description: workOrder.description ?? "Work order",
        meta: `${workOrder.status} · ${workOrder.priority}`,
        href: `/maintenance/${workOrder.id}`,
        score: textScore(query, [workOrder.number, workOrder.title, workOrder.description]),
      })),
    ),
    rank(
      query,
      documents.map((document) => ({
        kind: "DOCUMENT" as const,
        id: document.id,
        label: `${document.code} · ${document.title}`,
        description: document.description ?? "Controlled document",
        meta: `${document.type} · ${document.owner}`,
        href: `/documents/${document.id}`,
        score: textScore(query, [document.code, document.title, document.description, document.owner]),
      })),
    ),
    rank(
      query,
      parts.map((part) => ({
        kind: "PART" as const,
        id: part.id,
        label: `${part.sku} · ${part.name}`,
        description: part.description ?? "Spare part",
        meta: `${part.quantityOnHand} ${part.unit} on hand`,
        href: "/inventory",
        score: textScore(query, [part.sku, part.name, part.description]),
      })),
    ),
    quality,
  ];

  return resultGroups.flat().sort((left, right) => left.score - right.score || left.kind.localeCompare(right.kind) || left.label.localeCompare(right.label));
}
