export const DEFAULT_CSV_LIMITS = {
  maxBytes: 1_000_000,
  maxRows: 1_000,
  maxColumns: 64,
  maxFieldLength: 20_000,
} as const;

export type CsvLimits = {
  maxBytes?: number;
  maxRows?: number;
  maxColumns?: number;
  maxFieldLength?: number;
};

export class CsvFormatError extends Error {
  constructor(
    public readonly code:
      | "CSV_TOO_LARGE"
      | "CSV_TOO_MANY_ROWS"
      | "CSV_TOO_MANY_COLUMNS"
      | "CSV_FIELD_TOO_LARGE"
      | "CSV_UNTERMINATED_QUOTE"
      | "CSV_INVALID_QUOTE"
      | "CSV_EMPTY",
    message: string,
    public readonly row?: number,
    public readonly column?: number,
  ) {
    super(message);
    this.name = "CsvFormatError";
  }
}

function limits(input?: CsvLimits) {
  return {
    maxBytes: input?.maxBytes ?? DEFAULT_CSV_LIMITS.maxBytes,
    maxRows: input?.maxRows ?? DEFAULT_CSV_LIMITS.maxRows,
    maxColumns: input?.maxColumns ?? DEFAULT_CSV_LIMITS.maxColumns,
    maxFieldLength: input?.maxFieldLength ?? DEFAULT_CSV_LIMITS.maxFieldLength,
  };
}

export function parseCsv(text: string, inputLimits?: CsvLimits) {
  const bounded = limits(inputLimits);
  if (Buffer.byteLength(text, "utf8") > bounded.maxBytes) {
    throw new CsvFormatError("CSV_TOO_LARGE", `CSV exceeds ${bounded.maxBytes} bytes`);
  }

  const source = text.replace(/^\uFEFF/, "");
  if (!source.trim()) throw new CsvFormatError("CSV_EMPTY", "CSV document is empty");

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let afterQuote = false;

  const pushField = () => {
    if (field.length > bounded.maxFieldLength) {
      throw new CsvFormatError(
        "CSV_FIELD_TOO_LARGE",
        `CSV field exceeds ${bounded.maxFieldLength} characters`,
        rows.length + 1,
        row.length + 1,
      );
    }
    row.push(field);
    if (row.length > bounded.maxColumns) {
      throw new CsvFormatError(
        "CSV_TOO_MANY_COLUMNS",
        `CSV row exceeds ${bounded.maxColumns} columns`,
        rows.length + 1,
      );
    }
    field = "";
    afterQuote = false;
  };

  const pushRow = () => {
    pushField();
    rows.push(row);
    if (rows.length > bounded.maxRows + 1) {
      throw new CsvFormatError(
        "CSV_TOO_MANY_ROWS",
        `CSV exceeds ${bounded.maxRows} data rows`,
      );
    }
    row = [];
  };

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;

    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (afterQuote && char !== "," && char !== "\r" && char !== "\n") {
      throw new CsvFormatError(
        "CSV_INVALID_QUOTE",
        "Unexpected character after closing CSV quote",
        rows.length + 1,
        row.length + 1,
      );
    }

    if (char === '"') {
      if (field.length !== 0) {
        throw new CsvFormatError(
          "CSV_INVALID_QUOTE",
          "CSV quote must start at the beginning of a field",
          rows.length + 1,
          row.length + 1,
        );
      }
      quoted = true;
      continue;
    }
    if (char === ",") {
      pushField();
      continue;
    }
    if (char === "\r" || char === "\n") {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      pushRow();
      continue;
    }
    field += char;
  }

  if (quoted) {
    throw new CsvFormatError(
      "CSV_UNTERMINATED_QUOTE",
      "CSV contains an unterminated quoted field",
      rows.length + 1,
      row.length + 1,
    );
  }
  if (field.length > 0 || row.length > 0 || afterQuote) pushRow();

  const nonEmptyRows = rows.filter((entry) => entry.some((value) => value.length > 0));
  if (nonEmptyRows.length === 0) throw new CsvFormatError("CSV_EMPTY", "CSV document is empty");
  return nonEmptyRows;
}

export function escapeSpreadsheetFormula(value: string) {
  if (/^[\t\r ]*[=+\-@]/.test(value)) return `'${value}`;
  return value;
}

function encodeField(value: string, protectFormulas: boolean) {
  const safe = protectFormulas ? escapeSpreadsheetFormula(value) : value;
  if (/[",\r\n]/.test(safe)) return `"${safe.replace(/"/g, '""')}"`;
  return safe;
}

export function stringifyCsv(
  rows: ReadonlyArray<ReadonlyArray<string | number | boolean | null | undefined>>,
  options?: { protectFormulas?: boolean },
) {
  const protectFormulas = options?.protectFormulas ?? true;
  return `${rows
    .map((row) =>
      row
        .map((value) => encodeField(value === null || value === undefined ? "" : String(value), protectFormulas))
        .join(","),
    )
    .join("\r\n")}\r\n`;
}
