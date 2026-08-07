import { describe, expect, it } from "vitest";
import {
  AccessDeniedError,
  assertSitePermission,
  hasSiteAccess,
  type MembershipScope,
} from "@/lib/access-control";

const restrictedTechnician: MembershipScope = {
  active: true,
  role: "TECHNICIAN",
  allSites: false,
  siteIds: ["site-a"],
};

describe("site access control", () => {
  it("allows an explicitly assigned site", () => {
    expect(hasSiteAccess(restrictedTechnician, "site-a")).toBe(true);
  });

  it("denies a different tenant site", () => {
    expect(hasSiteAccess(restrictedTechnician, "site-b")).toBe(false);
    expect(() => assertSitePermission(restrictedTechnician, "site-b", "work:update")).toThrow(
      AccessDeniedError,
    );
  });

  it("allows all-sites memberships across their organization scope", () => {
    expect(
      hasSiteAccess(
        { ...restrictedTechnician, allSites: true, siteIds: [] },
        "any-site-in-the-organization",
      ),
    ).toBe(true);
  });

  it("denies inactive memberships even when all-sites is set", () => {
    expect(
      hasSiteAccess({ ...restrictedTechnician, active: false, allSites: true }, "site-a"),
    ).toBe(false);
  });
});
