import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  createSession: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { user: { findUnique: mocks.findUnique } },
}));

vi.mock("@/lib/auth/session", () => ({
  createSession: mocks.createSession,
}));

import { loginWithProvider } from "@/lib/auth/login";

describe("loginWithProvider", () => {
  it("creates a session for an active verified user", async () => {
    const provider = {
      id: "oidc",
      verify: vi.fn().mockResolvedValue({
        provider: "OIDC",
        subject: "subject-1",
        email: " Demo.User@Example.Local ",
        displayName: "Demo User",
      }),
    };

    mocks.findUnique.mockResolvedValue({
      id: "user-1",
      email: "demo.user@example.local",
      displayName: "Demo User",
      active: true,
    });
    mocks.createSession.mockResolvedValue({
      token: "session-token",
      id: "session-1",
      expiresAt: new Date("2026-08-14T00:00:00.000Z"),
    });

    const result = await loginWithProvider(provider, { assertion: "demo" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected successful login");
    expect(result.token).toBe("session-token");
    expect(mocks.findUnique).toHaveBeenCalledWith({
      where: { email: "demo.user@example.local" },
      select: { id: true, email: true, displayName: true, active: true },
    });
  });

  it("rejects an unverified identity", async () => {
    const provider = { id: "oidc", verify: vi.fn().mockResolvedValue(null) };
    await expect(loginWithProvider(provider, {})).resolves.toEqual({
      ok: false,
      code: "INVALID_IDENTITY",
    });
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("rejects inactive accounts", async () => {
    const provider = {
      id: "oidc",
      verify: vi.fn().mockResolvedValue({
        provider: "oidc",
        subject: "subject-2",
        email: "inactive@example.local",
        displayName: "Inactive Demo User",
      }),
    };
    mocks.findUnique.mockResolvedValue({
      id: "user-2",
      email: "inactive@example.local",
      displayName: "Inactive Demo User",
      active: false,
    });

    await expect(loginWithProvider(provider, {})).resolves.toEqual({
      ok: false,
      code: "ACCOUNT_DISABLED",
    });
    expect(mocks.createSession).not.toHaveBeenCalled();
  });
});
