import { describe, expect, it } from "vitest";
import { hashToken } from "@/lib/auth/session";

describe("session token hashing", () => {
  it("is deterministic and does not expose the raw token", () => {
    const token = "synthetic-session-token";
    const hash = hashToken(token);
    expect(hash).toBe(hashToken(token));
    expect(hash).not.toContain(token);
    expect(hash).toHaveLength(64);
  });
});
