import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveSession: vi.fn(),
  revokeSession: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  resolveSession: mocks.resolveSession,
  revokeSession: mocks.revokeSession,
}));

import { GET as getSession } from "@/app/api/auth/session/route";
import { POST as logout } from "@/app/api/auth/logout/route";

describe("auth session API", () => {
  it("rejects session introspection without bearer token", async () => {
    const response = await getSession(new Request("http://localhost/api/auth/session"));
    expect(response.status).toBe(401);
  });

  it("returns the active session", async () => {
    mocks.resolveSession.mockResolvedValueOnce({
      id: "session-1",
      expiresAt: new Date("2026-08-14T00:00:00.000Z"),
      lastSeenAt: new Date("2026-08-07T10:00:00.000Z"),
      user: {
        id: "user-1",
        email: "demo.user@example.local",
        displayName: "Demo User",
        active: true,
      },
    });

    const response = await getSession(
      new Request("http://localhost/api/auth/session", {
        headers: { authorization: "Bearer valid-token" },
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.resolveSession).toHaveBeenCalledWith("valid-token");
  });

  it("revokes the current session on logout", async () => {
    const response = await logout(
      new Request("http://localhost/api/auth/logout", {
        method: "POST",
        headers: { authorization: "Bearer valid-token" },
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.revokeSession).toHaveBeenCalledWith("valid-token");
  });
});
