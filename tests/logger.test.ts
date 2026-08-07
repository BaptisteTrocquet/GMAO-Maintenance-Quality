import { afterEach, describe, expect, it, vi } from "vitest";

import { logger } from "@/lib/logger";

describe("logger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes structured info logs", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    logger.info("work order created", { entityId: "demo-id" });

    expect(spy).toHaveBeenCalledOnce();
    const payload = JSON.parse(String(spy.mock.calls[0][0]));
    expect(payload).toMatchObject({
      level: "info",
      message: "work order created",
      entityId: "demo-id",
    });
    expect(payload.timestamp).toEqual(expect.any(String));
  });

  it("uses the error channel for errors", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    logger.error("database unavailable", { operation: "healthcheck" });

    expect(spy).toHaveBeenCalledOnce();
  });
});
