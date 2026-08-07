import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", () => ({ resolveSession: vi.fn() }));
vi.mock("@/lib/tenant-context", () => ({ loadTenantContext: vi.fn() }));

import { authenticateRequest } from "@/lib/auth/request-auth";

describe("authenticateRequest", () => {
  it("rejects requests without bearer authentication", async () => {
    const request = new Request("http://localhost/api/assets");
    const result = await authenticateRequest(request, "org-1");
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error.status).toBe(401);
  });
});
