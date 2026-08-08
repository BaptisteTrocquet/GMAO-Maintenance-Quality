import { describe, expect, it } from "vitest";
import {
  parseCompletionSignatureFromAudit,
  signatureNameMatchesIdentity,
} from "@/lib/work-orders/completion-signature";

describe("work-order completion signature", () => {
  it("matches typed names after unicode, whitespace and case normalization", () => {
    expect(signatureNameMatchesIdentity("  TAYLOR   Technician ", "Taylor Technician")).toBe(true);
    expect(signatureNameMatchesIdentity("Ｔａｙｌｏｒ Technician", "Taylor Technician")).toBe(true);
    expect(signatureNameMatchesIdentity("Another Person", "Taylor Technician")).toBe(false);
  });

  it("parses only the current typed-name audit signature format", () => {
    expect(parseCompletionSignatureFromAudit(JSON.stringify({
      signature: {
        method: "TYPED_NAME",
        signedById: "tech-1",
        signedByName: "Taylor Technician",
        capturedName: "Taylor Technician",
        signedAt: "2026-08-08T08:00:00.000Z",
        attestationVersion: "work-completion-v1",
      },
    }))).toEqual({
      method: "TYPED_NAME",
      signedById: "tech-1",
      signedByName: "Taylor Technician",
      capturedName: "Taylor Technician",
      signedAt: "2026-08-08T08:00:00.000Z",
      attestationVersion: "work-completion-v1",
    });

    expect(parseCompletionSignatureFromAudit(JSON.stringify({
      signature: { signedById: "legacy", signedAt: "2026-08-08T08:00:00.000Z" },
    }))).toBeNull();
    expect(parseCompletionSignatureFromAudit("not-json")).toBeNull();
  });
});
