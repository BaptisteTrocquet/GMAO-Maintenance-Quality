import { describe, expect, it } from "vitest";
import {
  isValidExternalIdentity,
  normalizeExternalIdentity,
} from "@/lib/auth/provider";

describe("authentication provider abstraction", () => {
  it("normalizes provider identities deterministically", () => {
    expect(
      normalizeExternalIdentity({
        provider: " Microsoft-Entra ",
        subject: " user-123 ",
        email: " Demo.User@Example.COM ",
        displayName: " Demo User ",
      }),
    ).toEqual({
      provider: "microsoft-entra",
      subject: "user-123",
      email: "demo.user@example.com",
      displayName: "Demo User",
    });
  });

  it("rejects incomplete external identities", () => {
    expect(
      isValidExternalIdentity({
        provider: "oidc",
        subject: "subject",
        email: "not-an-email",
        displayName: "Demo User",
      }),
    ).toBe(false);
  });
});
