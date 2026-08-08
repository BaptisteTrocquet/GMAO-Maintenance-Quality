import { parseCsv, stringifyCsv } from "@/lib/integrations/csv";

export const ASSET_CSV_HEADERS = [
  "code",
  "name",
  "description",
  "category",
  "manufacturer",
  "model",
  "serialNumber",
  "criticality",
  "status",
  "installedAt",
  "commissionedAt",
  "locationCode",
  "parentAssetCode",
] as const;

export type AssetCsvHeader = (typeof ASSET_CSV_HEADERS)[number];
export type AssetCsvStatus = "ACTIVE" | "INACTIVE" | "OUT_OF_SERVICE" | "DECOMMISSIONED";
export type AssetCsvCriticality = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type AssetCsvRow = {
  rowNumber: number;
  code: string;
  name: string;
  description?: string | null;
  category?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  criticality?: AssetCsvCriticality;
  status?: AssetCsvStatus;
  installedAt?: Date | null;
  commissionedAt?: Date | null;
  locationCode?: string | null;
  parentAssetCode?: string | null;
};

export type AssetCsvValidationError = {
  row: number;
  column?: string;
  code: string;
  message: string;
};

export class AssetCsvValidationErrorSet extends Error {
  constructor(public readonly errors: AssetCsvValidationError[]) {
    super("Asset CSV validation failed");
    this.name = "AssetCsvValidationErrorSet";
  }
}

const HEADER_SET = new Set<string>(ASSET_CSV_HEADERS);
const STATUS_SET = new Set<AssetCsvStatus>([
  "ACTIVE",
  "INACTIVE",
  "OUT_OF_SERVICE",
  "DECOMMISSIONED",
]);
const CRITICALITY_SET = new Set<AssetCsvCriticality>(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);

function nullableText(
  raw: string | undefined,
  max: number,
  row: number,
  column: string,
  errors: AssetCsvValidationError[],
) {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (!value) return null;
  if (value.length > max) {
    errors.push({ row, column, code: "VALUE_TOO_LONG", message: `${column} exceeds ${max} characters` });
  }
  return value;
}

function enumValue<T extends string>(
  raw: string | undefined,
  allowed: ReadonlySet<T>,
  row: number,
  column: string,
  errors: AssetCsvValidationError[],
) {
  if (raw === undefined || !raw.trim()) return undefined;
  const value = raw.trim().toUpperCase() as T;
  if (!allowed.has(value)) {
    errors.push({ row, column, code: "INVALID_ENUM", message: `${column} has an unsupported value` });
    return undefined;
  }
  return value;
}

function dateValue(
  raw: string | undefined,
  row: number,
  column: string,
  errors: AssetCsvValidationError[],
) {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) {
    errors.push({ row, column, code: "INVALID_DATE", message: `${column} must use ISO-8601 format` });
    return undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    errors.push({ row, column, code: "INVALID_DATE", message: `${column} must be a valid date` });
    return undefined;
  }
  return parsed;
}

export function parseAssetCsv(text: string) {
  const csvRows = parseCsv(text);
  const rawHeaders = csvRows[0]!.map((header) => header.trim());
  const errors: AssetCsvValidationError[] = [];
  const seenHeaders = new Set<string>();

  for (const header of rawHeaders) {
    if (!HEADER_SET.has(header)) {
      errors.push({ row: 1, column: header || undefined, code: "UNKNOWN_HEADER", message: `Unknown CSV header: ${header || "(blank)"}` });
    }
    if (seenHeaders.has(header)) {
      errors.push({ row: 1, column: header || undefined, code: "DUPLICATE_HEADER", message: `Duplicate CSV header: ${header || "(blank)"}` });
    }
    seenHeaders.add(header);
  }
  for (const required of ["code", "name"] as const) {
    if (!seenHeaders.has(required)) {
      errors.push({ row: 1, column: required, code: "MISSING_HEADER", message: `Required CSV header is missing: ${required}` });
    }
  }
  if (errors.length > 0) throw new AssetCsvValidationErrorSet(errors);

  const indexByHeader = new Map<AssetCsvHeader, number>();
  rawHeaders.forEach((header, index) => {
    if (HEADER_SET.has(header)) indexByHeader.set(header as AssetCsvHeader, index);
  });
  const value = (cells: string[], header: AssetCsvHeader) => {
    const index = indexByHeader.get(header);
    return index === undefined ? undefined : cells[index] ?? "";
  };

  const rows: AssetCsvRow[] = [];
  const codes = new Set<string>();
  for (let index = 1; index < csvRows.length; index += 1) {
    const cells = csvRows[index]!;
    const rowNumber = index + 1;
    if (cells.length > rawHeaders.length && cells.slice(rawHeaders.length).some((cell) => cell.trim())) {
      errors.push({ row: rowNumber, code: "TOO_MANY_CELLS", message: "CSV row contains more cells than the header" });
      continue;
    }

    const code = (value(cells, "code") ?? "").trim();
    const name = (value(cells, "name") ?? "").trim();
    if (!code) errors.push({ row: rowNumber, column: "code", code: "REQUIRED", message: "Asset code is required" });
    if (code.length > 50) errors.push({ row: rowNumber, column: "code", code: "VALUE_TOO_LONG", message: "Asset code exceeds 50 characters" });
    if (!name) errors.push({ row: rowNumber, column: "name", code: "REQUIRED", message: "Asset name is required" });
    if (name.length > 200) errors.push({ row: rowNumber, column: "name", code: "VALUE_TOO_LONG", message: "Asset name exceeds 200 characters" });
    if (code && codes.has(code)) {
      errors.push({ row: rowNumber, column: "code", code: "DUPLICATE_CODE", message: `Asset code ${code} appears more than once in the import` });
    }
    if (code) codes.add(code);

    const parentAssetCode = nullableText(value(cells, "parentAssetCode"), 50, rowNumber, "parentAssetCode", errors);
    if (parentAssetCode && parentAssetCode === code) {
      errors.push({ row: rowNumber, column: "parentAssetCode", code: "SELF_PARENT", message: "Asset cannot be its own parent" });
    }

    rows.push({
      rowNumber,
      code,
      name,
      description: nullableText(value(cells, "description"), 2_000, rowNumber, "description", errors),
      category: nullableText(value(cells, "category"), 100, rowNumber, "category", errors),
      manufacturer: nullableText(value(cells, "manufacturer"), 150, rowNumber, "manufacturer", errors),
      model: nullableText(value(cells, "model"), 150, rowNumber, "model", errors),
      serialNumber: nullableText(value(cells, "serialNumber"), 150, rowNumber, "serialNumber", errors),
      criticality: enumValue(value(cells, "criticality"), CRITICALITY_SET, rowNumber, "criticality", errors),
      status: enumValue(value(cells, "status"), STATUS_SET, rowNumber, "status", errors),
      installedAt: dateValue(value(cells, "installedAt"), rowNumber, "installedAt", errors),
      commissionedAt: dateValue(value(cells, "commissionedAt"), rowNumber, "commissionedAt", errors),
      locationCode: nullableText(value(cells, "locationCode"), 50, rowNumber, "locationCode", errors),
      parentAssetCode,
    });
  }

  if (rows.length === 0) {
    errors.push({ row: 1, code: "NO_DATA_ROWS", message: "CSV must contain at least one asset row" });
  }
  if (errors.length > 0) throw new AssetCsvValidationErrorSet(errors);
  return { rows, headers: [...indexByHeader.keys()] };
}

function isoDate(value: Date | string | null | undefined) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

export function stringifyAssetsCsv(
  assets: ReadonlyArray<{
    code: string;
    name: string;
    description?: string | null;
    category?: string | null;
    manufacturer?: string | null;
    model?: string | null;
    serialNumber?: string | null;
    criticality: string;
    status: string;
    installedAt?: Date | string | null;
    commissionedAt?: Date | string | null;
    location?: { code: string } | null;
    parentAsset?: { code: string } | null;
  }>,
) {
  return stringifyCsv([
    ASSET_CSV_HEADERS,
    ...assets.map((asset) => [
      asset.code,
      asset.name,
      asset.description ?? "",
      asset.category ?? "",
      asset.manufacturer ?? "",
      asset.model ?? "",
      asset.serialNumber ?? "",
      asset.criticality,
      asset.status,
      isoDate(asset.installedAt),
      isoDate(asset.commissionedAt),
      asset.location?.code ?? "",
      asset.parentAsset?.code ?? "",
    ]),
  ]);
}
