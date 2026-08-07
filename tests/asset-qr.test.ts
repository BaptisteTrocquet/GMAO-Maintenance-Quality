import { describe, expect, it } from "vitest";
import { buildAssetLabelText, buildAssetQrPayload, buildAssetQrSvg } from "@/lib/assets/qr";

describe("asset QR labels", () => {
  it("builds a stable relative asset route", () => {
    expect(buildAssetQrPayload({ assetId: "asset 1" })).toBe("/assets/asset%201");
  });

  it("builds an absolute route when an origin is provided", () => {
    expect(buildAssetQrPayload({ assetId: "asset-1", origin: "https://example.local" })).toBe(
      "https://example.local/assets/asset-1",
    );
  });

  it("includes code, name and immutable id in printable text", () => {
    expect(buildAssetLabelText({ code: "P-100", name: "Demo Pump", assetId: "asset-1" })).toContain(
      "P-100 — Demo Pump\nasset-1",
    );
  });

  it("renders deterministic SVG label matrix", () => {
    const first = buildAssetQrSvg("/assets/asset-1");
    const second = buildAssetQrSvg("/assets/asset-1");
    expect(first).toBe(second);
    expect(first).toContain("<svg");
    expect(first).toContain("aria-label=\"Asset QR code\"");
    expect(first.match(/<rect /g)?.length ?? 0).toBeGreaterThan(100);
  });
});
