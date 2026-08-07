import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auditFindFirst: vi.fn(),
  tokenFindUnique: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    auditLog: { findFirst: mocks.auditFindFirst },
    publicMaintenanceRequestToken: { findUnique: mocks.tokenFindUnique },
  },
}));

import {
  DEFAULT_PUBLIC_REQUEST_SCOPES,
  getPublicRequestTokenScopes,
  hasPublicRequestScope,
} from "@/lib/public-requests/tokens";

describe("public request token capability scopes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("preserves maintenance capabilities for legacy tokens without scope metadata", async () => {
    mocks.auditFindFirst.mockResolvedValue(null);

    await expect(
      getPublicRequestTokenScopes("legacy-token", new Date("2026-08-07T19:00:00.000Z")),
    ).resolves.toEqual(DEFAULT_PUBLIC_REQUEST_SCOPES);
  });

  it("fails closed for new tokens missing immutable scope metadata", async () => {
    mocks.auditFindFirst.mockResolvedValue(null);

    await expect(
      getPublicRequestTokenScopes("new-token", new Date("2026-08-07T21:00:00.000Z")),
    ).resolves.toEqual([]);
  });

  it("loads only the explicit scopes recorded when the token was created", async () => {
    mocks.auditFindFirst.mockResolvedValue({
      afterJson: JSON.stringify({ scopes: ["asset:read", "document:read", "asset:read"] }),
    });

    const scopes = await getPublicRequestTokenScopes(
      "scoped-token",
      new Date("2026-08-07T21:00:00.000Z"),
    );

    expect(scopes).toEqual(["asset:read", "document:read"]);
    expect(hasPublicRequestScope({ scopes }, "asset:read")).toBe(true);
    expect(hasPublicRequestScope({ scopes }, "maintenance:request:create")).toBe(false);
  });

  it("fails closed when persisted scope metadata contains an unknown capability", async () => {
    mocks.auditFindFirst.mockResolvedValue({
      afterJson: JSON.stringify({ scopes: ["asset:read", "admin:everything"] }),
    });

    await expect(
      getPublicRequestTokenScopes("invalid-token", new Date("2026-08-07T21:00:00.000Z")),
    ).resolves.toEqual([]);
  });
});
