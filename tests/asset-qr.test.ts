import { describe, expect, it } from "vitest";
import { buildAssetLabelText, buildAssetQrPayload } from "@/lib/assets/qr";

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
});
