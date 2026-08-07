import { describe, expect, it } from "vitest";
import {
  createEmbedProof,
  parentOriginFromReferrer,
  verifyEmbedProof,
} from "@/lib/embed/proof";

const tokenHash = "ab".repeat(32);

describe("embed parent-origin proofs", () => {
  it("binds a proof to token id, exact parent origin and expiry", () => {
    const now = new Date("2026-08-07T12:00:00.000Z");
    const proof = createEmbedProof({
      tokenId: "token-1",
      tokenHash,
      parentOrigin: "https://portal.example.test",
      now,
      ttlMs: 60_000,
    });

    expect(
      verifyEmbedProof({ proof, tokenId: "token-1", tokenHash, now }),
    ).toMatchObject({
      tokenId: "token-1",
      parentOrigin: "https://portal.example.test",
    });
    expect(
      verifyEmbedProof({ proof, tokenId: "token-2", tokenHash, now }),
    ).toBeNull();
    expect(
      verifyEmbedProof({
        proof,
        tokenId: "token-1",
        tokenHash,
        now: new Date("2026-08-07T12:01:01.000Z"),
      }),
    ).toBeNull();
  });

  it("rejects tampered signatures", () => {
    const proof = createEmbedProof({
      tokenId: "token-1",
      tokenHash,
      parentOrigin: "https://portal.example.test",
    });
    const [payload] = proof.split(".");

    expect(
      verifyEmbedProof({
        proof: `${payload}.${"x".repeat(43)}`,
        tokenId: "token-1",
        tokenHash,
      }),
    ).toBeNull();
  });

  it("derives only the origin from a browser referrer URL", () => {
    expect(parentOriginFromReferrer("https://portal.example.test/path/page?x=1")).toBe(
      "https://portal.example.test",
    );
    expect(parentOriginFromReferrer(null)).toBeNull();
    expect(parentOriginFromReferrer("not-a-url")).toBeNull();
  });
});
