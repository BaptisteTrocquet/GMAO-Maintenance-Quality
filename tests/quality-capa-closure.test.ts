import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findFirst: vi.fn() }));

vi.mock("@/lib/db", () => ({
  db: { auditLog: { findFirst: mocks.findFirst } },
}));

import { assertCapaClosedForEvent } from "@/lib/quality/capa-closure";

describe("CAPA quality-event closure guard", () => {
  beforeEach(() => vi.clearAllMocks());

  it("blocks an incomplete CAPA in the requested tenant", async () => {
    mocks.findFirst.mockResolvedValue({
      afterJson: JSON.stringify({ organizationId: "org-a", siteId: "site-a", status: "ACTIVE" }),
    });
    await expect(
      assertCapaClosedForEvent({ organizationId: "org-a", siteId: "site-a", eventId: "event-1" }),
    ).rejects.toMatchObject({ code: "CAPA_INCOMPLETE" });
  });

  it("does not reveal a CAPA snapshot from another tenant", async () => {
    mocks.findFirst.mockResolvedValue({
      afterJson: JSON.stringify({ organizationId: "org-b", siteId: "site-b", status: "ACTIVE" }),
    });
    await expect(
      assertCapaClosedForEvent({ organizationId: "org-a", siteId: "site-a", eventId: "event-1" }),
    ).resolves.toBeUndefined();
  });

  it("allows closure when the scoped CAPA is closed", async () => {
    mocks.findFirst.mockResolvedValue({
      afterJson: JSON.stringify({ organizationId: "org-a", siteId: "site-a", status: "CLOSED" }),
    });
    await expect(
      assertCapaClosedForEvent({ organizationId: "org-a", siteId: "site-a", eventId: "event-1" }),
    ).resolves.toBeUndefined();
  });
});
