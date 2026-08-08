import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { $queryRaw: mocks.queryRaw },
}));

import { GET as live } from "@/app/api/health/live/route";
import { GET as ready } from "@/app/api/health/ready/route";
import { checkReadiness } from "@/lib/ops/health";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.queryRaw.mockResolvedValue([{ "?column?": 1 }]);
});

describe("operational health probes", () => {
  it("reports liveness without touching the database", async () => {
    const response = await live();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it("reports readiness only when the database probe succeeds", async () => {
    const response = await ready();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ready",
      checks: { database: "ok" },
    });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.queryRaw).toHaveBeenCalledTimes(1);
  });

  it("returns 503 without leaking the database error", async () => {
    mocks.queryRaw.mockRejectedValue(
      new Error("postgresql://sensitive-user:secret@example.internal/private"),
    );

    const response = await ready();
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).toContain("not_ready");
    expect(body).toContain("unavailable");
    expect(body).not.toContain("sensitive-user");
    expect(body).not.toContain("secret");
    expect(body).not.toContain("example.internal");
  });

  it("fails closed when the database probe exceeds the readiness timeout", async () => {
    mocks.queryRaw.mockImplementation(() => new Promise(() => undefined));

    await expect(checkReadiness({ timeoutMs: 5 })).resolves.toEqual({
      ready: false,
      database: "unavailable",
    });
  });
});
