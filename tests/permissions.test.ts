import { describe, expect, it } from "vitest";
import { can } from "@/lib/permissions";

describe("membership permission matrix", () => {
  it("gives owners full control", () => {
    expect(can("OWNER", "organization:manage")).toBe(true);
    expect(can("OWNER", "quality:manage")).toBe(true);
  });

  it("allows maintenance managers to manage maintenance but not organization membership", () => {
    expect(can("MAINTENANCE_MANAGER", "maintenance:manage")).toBe(true);
    expect(can("MAINTENANCE_MANAGER", "member:manage")).toBe(false);
  });

  it("allows operators to create work requests without maintenance administration", () => {
    expect(can("OPERATOR", "work:create")).toBe(true);
    expect(can("OPERATOR", "maintenance:manage")).toBe(false);
  });

  it("keeps viewers read-only", () => {
    expect(can("VIEWER", "asset:read")).toBe(true);
    expect(can("VIEWER", "work:update")).toBe(false);
    expect(can("VIEWER", "document:manage")).toBe(false);
  });
});
