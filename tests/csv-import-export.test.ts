import { describe, expect, it } from "vitest";
import {
  AssetCsvValidationErrorSet,
  parseAssetCsv,
  stringifyAssetsCsv,
} from "@/lib/integrations/assets-csv";
import { CsvFormatError, parseCsv, stringifyCsv } from "@/lib/integrations/csv";

describe("CSV integration codec", () => {
  it("parses RFC4180-style quoted commas, quotes and newlines", () => {
    expect(parseCsv('code,name,description\r\nA-1,"Pump, main","Line 1\nLine 2 ""quoted"""\r\n')).toEqual([
      ["code", "name", "description"],
      ["A-1", "Pump, main", 'Line 1\nLine 2 "quoted"'],
    ]);
  });

  it("rejects unterminated quotes and bounded payload violations", () => {
    expect(() => parseCsv('code,name\nA-1,"Pump')).toThrowError(CsvFormatError);
    expect(() => parseCsv("a,b\n1,2\n3,4", { maxRows: 1 })).toThrowError(
      expect.objectContaining({ code: "CSV_TOO_MANY_ROWS" }),
    );
  });

  it("neutralizes spreadsheet formulas by default on export", () => {
    const csv = stringifyCsv([
      ["code", "name"],
      ["=cmd", "+SUM(A1:A2)"],
      ["safe", "Pump"],
    ]);
    expect(csv).toContain("'=cmd");
    expect(csv).toContain("'+SUM(A1:A2)");
    expect(csv).toContain("safe,Pump");
  });
});

describe("asset CSV schema", () => {
  it("supports compact imports and normalizes enums/dates", () => {
    const parsed = parseAssetCsv(
      [
        "code,name,status,criticality,installedAt,parentAssetCode",
        "P-1,Main pump,active,high,2026-08-08,",
        "P-2,Child pump,out_of_service,medium,2026-08-08T08:00:00.000Z,P-1",
      ].join("\n"),
    );

    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toMatchObject({
      code: "P-1",
      name: "Main pump",
      status: "ACTIVE",
      criticality: "HIGH",
      parentAssetCode: null,
    });
    expect(parsed.rows[0]?.installedAt?.toISOString()).toBe("2026-08-08T00:00:00.000Z");
    expect(parsed.rows[1]).toMatchObject({
      code: "P-2",
      parentAssetCode: "P-1",
      status: "OUT_OF_SERVICE",
    });
  });

  it("rejects duplicate codes, unknown columns and self-parenting", () => {
    expect(() => parseAssetCsv("code,name,unknown\nA-1,Pump,x")).toThrowError(
      AssetCsvValidationErrorSet,
    );

    try {
      parseAssetCsv("code,name,parentAssetCode\nA-1,Pump,A-1\nA-1,Duplicate,");
      throw new Error("Expected validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AssetCsvValidationErrorSet);
      const codes = (error as AssetCsvValidationErrorSet).errors.map((entry) => entry.code);
      expect(codes).toContain("SELF_PARENT");
      expect(codes).toContain("DUPLICATE_CODE");
    }
  });

  it("exports stable headers, references and formula-safe user text", () => {
    const csv = stringifyAssetsCsv([
      {
        code: "A-1",
        name: "=HYPERLINK(\"bad\")",
        description: "Pump, main",
        category: null,
        manufacturer: null,
        model: null,
        serialNumber: null,
        criticality: "HIGH",
        status: "ACTIVE",
        installedAt: new Date("2026-08-08T00:00:00.000Z"),
        commissionedAt: null,
        location: { code: "LINE-1" },
        parentAsset: { code: "AREA-1" },
      },
    ]);

    expect(csv.split("\r\n")[0]).toBe(
      "code,name,description,category,manufacturer,model,serialNumber,criticality,status,installedAt,commissionedAt,locationCode,parentAssetCode",
    );
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain('"Pump, main"');
    expect(csv).toContain("LINE-1,AREA-1");
  });
});
