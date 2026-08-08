import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    $queryRaw: mocks.queryRaw,
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    warn: mocks.warn,
  },
}));

import { GET as getHealth } from "@/app/api/health/route";
import { GET as getReady } from "@/app/api/ready/route";

describe("health and readiness probes", () => {
  beforeEach(() => {
    mocks.queryRaw.mockReset();
    mocks.warn.mockReset();
  });

  it("reports liveness without touching external dependencies", async () => {
    mocks.queryRaw.mockRejectedValue(new Error("database unavailable"));

    const response = await getHealth();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({
      data: {
        status: "ok",
        service: "opengmao",
        checks: { process: "alive" },
      },
    });
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it("reports readiness only when PostgreSQL is reachable", async () => {
    mocks.queryRaw.mockResolvedValue([{ "?column?": 1 }]);

    const response = await getReady();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({
      data: {
        status: "ready",
        service: "opengmao",
        checks: { database: "reachable" },
      },
    });
    expect(mocks.queryRaw).toHaveBeenCalledTimes(1);
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("fails readiness closed with a generic response and safe log metadata", async () => {
    const secretBearingError =
      "postgresql://operator:super-secret-password@private-db.internal:5432/opengmao";
    mocks.queryRaw.mockRejectedValue(new Error(secretBearingError));

    const response = await getReady();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "Service is not ready",
      },
    });
    expect(JSON.stringify(body)).not.toContain("super-secret-password");
    expect(mocks.warn).toHaveBeenCalledWith("readiness_check_failed", {
      dependency: "database",
    });
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain("super-secret-password");
  });
});
