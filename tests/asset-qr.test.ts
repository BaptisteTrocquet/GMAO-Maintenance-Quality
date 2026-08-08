import { describe, expect, it } from "vitest";
import {
  buildAssetLabelText,
  buildAssetQrPayload,
  buildAssetQrSvg,
  parseAssetQrPayload,
} from "@/lib/assets/qr";

describe("asset QR labels", () => {
  it("builds a stable relative asset route", () => {
    expect(buildAssetQrPayload({ assetId: "asset 1" })).toBe("/assets/asset%201");
  });

  it("builds an absolute route when an origin is provided", () => {
    expect(buildAssetQrPayload({ assetId: "asset-1", origin: "https://example.local" })).toBe(
      "https://example.local/assets/asset-1",
    );
  });

  it("parses relative and same-origin asset routes without allowing an open redirect", () => {
    expect(parseAssetQrPayload("/assets/asset%201", "https://example.local")).toEqual({
      assetId: "asset 1",
      href: "/assets/asset%201",
    });
    expect(
      parseAssetQrPayload("https://example.local/assets/asset-1", "https://example.local"),
    ).toEqual({ assetId: "asset-1", href: "/assets/asset-1" });
    expect(
      parseAssetQrPayload("https://other.example/assets/asset-1", "https://example.local"),
    ).toBeNull();
    expect(parseAssetQrPayload("/assets/asset-1?next=/admin", "https://example.local")).toBeNull();
    expect(parseAssetQrPayload("/documents/doc-1", "https://example.local")).toBeNull();
  });

  it("includes code, name and immutable id in printable text", () => {
    expect(buildAssetLabelText({ code: "P-100", name: "Demo Pump", assetId: "asset-1" })).toContain(
      "P-100 — Demo Pump\nasset-1",
    );
  });

  it("renders a deterministic standards-based version 3 QR matrix", () => {
    const payload = "/assets/123e4567-e89b-12d3-a456-426614174000";
    const first = buildAssetQrSvg(payload);
    const second = buildAssetQrSvg(payload);
    expect(first).toBe(second);
    expect(first).toContain("<svg");
    expect(first).toContain('viewBox="0 0 37 37"');
    expect(first).toContain("aria-label=\"Asset QR code\"");
    expect(first.match(/<rect /g)?.length ?? 0).toBeGreaterThan(400);
  });

  it("rejects payloads that exceed the fixed QR label capacity", () => {
    expect(() => buildAssetQrSvg(`/assets/${"x".repeat(60)}`)).toThrow(/maximum is 53 UTF-8 bytes/);
  });
});
