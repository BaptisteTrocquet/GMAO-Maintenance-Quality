import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  authenticateRequest: mocks.authenticateRequest,
}));

vi.mock("@/lib/db", () => ({
  db: {
    document: { findMany: vi.fn(), create: vi.fn() },
    organization: { findFirst: vi.fn() },
  },
}));

import { GET } from "@/app/api/documents/route";

describe("documents API tenant boundary", () => {
  it("requires an explicit organization scope", async () => {
    const response = await GET(new Request("http://localhost/api/documents"));
    expect(response.status).toBe(400);
    expect(mocks.authenticateRequest).not.toHaveBeenCalled();
  });

  it("rejects requests that fail tenant authentication", async () => {
    mocks.authenticateRequest.mockResolvedValueOnce({
      error: Response.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 }),
    });

    const response = await GET(
      new Request("http://localhost/api/documents?organizationId=org-other"),
    );

    expect(response.status).toBe(401);
    expect(mocks.authenticateRequest).toHaveBeenCalledWith(
      expect.any(Request),
      "org-other",
    );
  });
});
