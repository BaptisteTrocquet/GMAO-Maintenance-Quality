import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../app/maintenance/page.tsx", import.meta.url), "utf8");

describe("maintenance overview tenant scope", () => {
  it("requires an organization before querying maintenance data", () => {
    expect(source).toContain('requestHeaders.get("x-organization-id")');
    expect(source).toContain("if (!organizationId)");
    expect(source).toContain("Select an organization to view maintenance operations.");
  });

  it("scopes work orders, plans and reminders through the active organization/site", () => {
    expect(source).toContain("const siteScope = {");
    expect(source).toContain("organizationId,");
    expect(source).toContain("active: true,");
    expect(source).toContain('...(selectedSiteId ? { id: selectedSiteId } : {})');
    expect(source).toContain("where: { site: siteScope }");
    expect(source).toContain("where: { asset: { site: siteScope } }");
    expect(source).toContain('where: { status: "ACTIVE", site: siteScope }');
  });
});
