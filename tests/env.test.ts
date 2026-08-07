import { describe, expect, it } from "vitest";
import { parseServerEnv } from "@/lib/env";

describe("parseServerEnv", () => {
  it("accepts a valid server environment", () => {
    const result = parseServerEnv({
      DATABASE_URL: "postgresql://user:pass@localhost:5432/app",
      NODE_ENV: "test",
    });

    expect(result.DATABASE_URL).toContain("postgresql://");
    expect(result.NODE_ENV).toBe("test");
  });

  it("rejects a missing DATABASE_URL", () => {
    expect(() => parseServerEnv({ NODE_ENV: "test" })).toThrow("DATABASE_URL");
  });

  it("defaults NODE_ENV to development", () => {
    const result = parseServerEnv({ DATABASE_URL: "postgresql://localhost/app" });
    expect(result.NODE_ENV).toBe("development");
  });
});
