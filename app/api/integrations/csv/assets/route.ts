import type { Prisma } from "@prisma/client";
import { AccessDeniedError, assertSitePermission } from "@/lib/access-control";
import { apiData, apiError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/request-auth";
import { db } from "@/lib/db";
import {
  AssetCsvValidationErrorSet,
  parseAssetCsv,
  stringifyAssetsCsv,
  type AssetCsvRow,
  type AssetCsvValidationError,
} from "@/lib/integrations/assets-csv";
import { CsvFormatError, DEFAULT_CSV_LIMITS } from "@/lib/integrations/csv";

const IMPORT_MODES = new Set(["validate", "upsert"]);

type ExistingAsset = {
  id: string;
  code: string;
  parentAssetId: string | null;
};

type LocationRef = { id: string; code: string };

function accessError(error: unknown) {
  if (error instanceof AccessDeniedError) return apiError(403, "ACCESS_DENIED", error.message);
  throw error;
}

function parseScope(request: Request) {
  const url = new URL(request.url);
  return {
    url,
    organizationId: url.searchParams.get("organizationId"),
    siteId: url.searchParams.get("siteId"),
  };
}

async function ensureSite(organizationId: string, siteId: string) {
  return db.site.findFirst({
    where: { id: siteId, organizationId, active: true },
    select: { id: true, code: true },
  });
}

function importReferenceErrors(input: {
  rows: AssetCsvRow[];
  existingAssets: ExistingAsset[];
  locations: LocationRef[];
}) {
  const errors: AssetCsvValidationError[] = [];
  const existingByCode = new Map(input.existingAssets.map((asset) => [asset.code, asset]));
  const codeById = new Map(input.existingAssets.map((asset) => [asset.id, asset.code]));
  const locationCodes = new Set(input.locations.map((location) => location.code));
  const batchByCode = new Map(input.rows.map((row) => [row.code, row]));
  const parentByCode = new Map<string, string | null>();

  for (const asset of input.existingAssets) {
    parentByCode.set(asset.code, asset.parentAssetId ? codeById.get(asset.parentAssetId) ?? null : null);
  }

  for (const row of input.rows) {
    if (row.locationCode && !locationCodes.has(row.locationCode)) {
      errors.push({
        row: row.rowNumber,
        column: "locationCode",
        code: "LOCATION_NOT_FOUND",
        message: `Location ${row.locationCode} does not exist in the selected site`,
      });
    }
    if (
      row.parentAssetCode &&
      !existingByCode.has(row.parentAssetCode) &&
      !batchByCode.has(row.parentAssetCode)
    ) {
      errors.push({
        row: row.rowNumber,
        column: "parentAssetCode",
        code: "PARENT_ASSET_NOT_FOUND",
        message: `Parent asset ${row.parentAssetCode} does not exist in the selected site or import batch`,
      });
    }

    if (row.parentAssetCode !== undefined) {
      parentByCode.set(row.code, row.parentAssetCode);
    } else if (!existingByCode.has(row.code)) {
      parentByCode.set(row.code, null);
    }
  }

  const state = new Map<string, "visiting" | "done">();
  const visit = (code: string, trail: string[]) => {
    if (state.get(code) === "done") return;
    if (state.get(code) === "visiting") {
      const row = batchByCode.get(code) ?? batchByCode.get(trail.at(-1) ?? "");
      if (row) {
        errors.push({
          row: row.rowNumber,
          column: "parentAssetCode",
          code: "ASSET_HIERARCHY_CYCLE",
          message: `Asset hierarchy cycle detected: ${[...trail, code].join(" -> ")}`,
        });
      }
      return;
    }
    state.set(code, "visiting");
    const parent = parentByCode.get(code);
    if (parent && parentByCode.has(parent)) visit(parent, [...trail, code]);
    state.set(code, "done");
  };

  for (const row of input.rows) visit(row.code, []);
  return errors;
}

function sortRowsParentFirst(rows: AssetCsvRow[]) {
  const byCode = new Map(rows.map((row) => [row.code, row]));
  const done = new Set<string>();
  const sorted: AssetCsvRow[] = [];
  const visit = (row: AssetCsvRow) => {
    if (done.has(row.code)) return;
    const parent = row.parentAssetCode ? byCode.get(row.parentAssetCode) : undefined;
    if (parent) visit(parent);
    done.add(row.code);
    sorted.push(row);
  };
  rows.forEach(visit);
  return sorted;
}

function mutableFields(row: AssetCsvRow) {
  return {
    name: row.name,
    ...(row.description === undefined ? {} : { description: row.description }),
    ...(row.category === undefined ? {} : { category: row.category }),
    ...(row.manufacturer === undefined ? {} : { manufacturer: row.manufacturer }),
    ...(row.model === undefined ? {} : { model: row.model }),
    ...(row.serialNumber === undefined ? {} : { serialNumber: row.serialNumber }),
    ...(row.criticality === undefined ? {} : { criticality: row.criticality }),
    ...(row.status === undefined ? {} : { status: row.status }),
    ...(row.installedAt === undefined ? {} : { installedAt: row.installedAt }),
    ...(row.commissionedAt === undefined ? {} : { commissionedAt: row.commissionedAt }),
  };
}

async function applyImport(input: {
  organizationId: string;
  siteId: string;
  actorId: string;
  rows: AssetCsvRow[];
  existingAssets: ExistingAsset[];
  locations: LocationRef[];
}) {
  const locationByCode = new Map(input.locations.map((location) => [location.code, location.id]));
  const existingByCode = new Map(input.existingAssets.map((asset) => [asset.code, asset]));
  const orderedRows = sortRowsParentFirst(input.rows);

  return db.$transaction(async (tx: Prisma.TransactionClient) => {
    const importedIds = new Map<string, string>();
    let createdCount = 0;
    let updatedCount = 0;

    for (const row of orderedRows) {
      const current = await tx.asset.findUnique({
        where: { siteId_code: { siteId: input.siteId, code: row.code } },
      });

      let parentAssetId: string | null | undefined;
      if (row.parentAssetCode === null) parentAssetId = null;
      if (row.parentAssetCode) {
        parentAssetId =
          importedIds.get(row.parentAssetCode) ??
          existingByCode.get(row.parentAssetCode)?.id ??
          null;
      }
      const locationId =
        row.locationCode === undefined
          ? undefined
          : row.locationCode === null
            ? null
            : locationByCode.get(row.locationCode) ?? null;
      const decommissionedAt =
        row.status === "DECOMMISSIONED" && !current?.decommissionedAt
          ? new Date()
          : undefined;

      const relationFields = {
        ...(locationId === undefined ? {} : { locationId }),
        ...(parentAssetId === undefined ? {} : { parentAssetId }),
        ...(decommissionedAt === undefined ? {} : { decommissionedAt }),
      };

      const asset = current
        ? await tx.asset.update({
            where: { id: current.id },
            data: { ...mutableFields(row), ...relationFields },
          })
        : await tx.asset.create({
            data: {
              siteId: input.siteId,
              code: row.code,
              ...mutableFields(row),
              ...relationFields,
            },
          });

      if (current && row.status !== undefined && row.status !== current.status) {
        await tx.assetStatusHistory.create({
          data: {
            assetId: asset.id,
            fromStatus: current.status,
            toStatus: row.status,
            note: "Asset status updated by CSV import",
            changedById: input.actorId,
          },
        });
      }

      await tx.auditLog.create({
        data: {
          actorId: input.actorId,
          entityType: "Asset",
          entityId: asset.id,
          action: current ? "CSV_IMPORTED_UPDATED" : "CSV_IMPORTED_CREATED",
          beforeJson: current ? JSON.stringify(current) : null,
          afterJson: JSON.stringify(asset),
        },
      });

      importedIds.set(row.code, asset.id);
      if (current) updatedCount += 1;
      else createdCount += 1;
    }

    await tx.auditLog.create({
      data: {
        actorId: input.actorId,
        entityType: "IntegrationImport",
        entityId: `${input.organizationId}:${input.siteId}:${Date.now()}`,
        action: "ASSET_CSV_IMPORTED",
        afterJson: JSON.stringify({
          organizationId: input.organizationId,
          siteId: input.siteId,
          rows: input.rows.length,
          created: createdCount,
          updated: updatedCount,
        }),
      },
    });

    return { rows: input.rows.length, created: createdCount, updated: updatedCount };
  });
}

export async function GET(request: Request) {
  const { organizationId, siteId } = parseScope(request);
  if (!organizationId || !siteId) {
    return apiError(400, "INVALID_SCOPE", "organizationId and siteId are required");
  }

  const auth = await authenticateRequest(request, organizationId);
  if ("error" in auth) return auth.error;
  try {
    assertSitePermission(auth.tenant.scope, siteId, "asset:read");
  } catch (error) {
    return accessError(error);
  }

  const site = await ensureSite(organizationId, siteId);
  if (!site) return apiError(404, "SITE_NOT_FOUND", "Site not found");

  const assets = await db.asset.findMany({
    where: { siteId, archivedAt: null },
    orderBy: { code: "asc" },
    include: {
      location: { select: { code: true } },
      parentAsset: { select: { code: true } },
    },
  });
  const csv = stringifyAssetsCsv(assets);
  const safeSiteCode = site.code.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
  return new Response(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="assets-${safeSiteCode}.csv"`,
      "cache-control": "no-store",
    },
  });
}

export async function POST(request: Request) {
  const { url, organizationId, siteId } = parseScope(request);
  if (!organizationId || !siteId) {
    return apiError(400, "INVALID_SCOPE", "organizationId and siteId are required");
  }
  const mode = url.searchParams.get("mode") ?? "validate";
  if (!IMPORT_MODES.has(mode)) {
    return apiError(400, "INVALID_MODE", "mode must be validate or upsert");
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > DEFAULT_CSV_LIMITS.maxBytes) {
    return apiError(413, "CSV_TOO_LARGE", `CSV exceeds ${DEFAULT_CSV_LIMITS.maxBytes} bytes`);
  }

  const auth = await authenticateRequest(request, organizationId);
  if ("error" in auth) return auth.error;
  try {
    assertSitePermission(auth.tenant.scope, siteId, "asset:write");
  } catch (error) {
    return accessError(error);
  }

  if (!(await ensureSite(organizationId, siteId))) {
    return apiError(404, "SITE_NOT_FOUND", "Site not found");
  }

  let parsed;
  try {
    parsed = parseAssetCsv(await request.text());
  } catch (error) {
    if (error instanceof CsvFormatError) {
      return apiError(400, error.code, error.message, {
        row: error.row ?? null,
        column: error.column ?? null,
      });
    }
    if (error instanceof AssetCsvValidationErrorSet) {
      return apiError(400, "CSV_VALIDATION_FAILED", error.message, { errors: error.errors });
    }
    throw error;
  }

  const [locations, existingAssets] = await Promise.all([
    db.location.findMany({
      where: { siteId },
      select: { id: true, code: true },
    }),
    db.asset.findMany({
      where: { siteId, archivedAt: null },
      select: { id: true, code: true, parentAssetId: true },
    }),
  ]);
  const referenceErrors = importReferenceErrors({
    rows: parsed.rows,
    existingAssets,
    locations,
  });
  if (referenceErrors.length > 0) {
    return apiError(400, "CSV_REFERENCE_VALIDATION_FAILED", "CSV contains invalid site references", {
      errors: referenceErrors,
    });
  }

  const existingCodes = new Set(existingAssets.map((asset) => asset.code));
  const preview = {
    valid: true,
    mode,
    rows: parsed.rows.length,
    creates: parsed.rows.filter((row) => !existingCodes.has(row.code)).length,
    updates: parsed.rows.filter((row) => existingCodes.has(row.code)).length,
  };
  if (mode === "validate") return apiData(preview);

  const result = await applyImport({
    organizationId,
    siteId,
    actorId: auth.session.user.id,
    rows: parsed.rows,
    existingAssets,
    locations,
  });
  return apiData({ ...preview, ...result, mode: "upsert" });
}
