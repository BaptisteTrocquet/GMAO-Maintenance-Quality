import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findFirst: vi.fn() }));

vi.mock("@/lib/db", () => ({
  db: { auditLog: { findFirst: mocks.findFirst } },
}));

import { assertEffectiveCapaForEvent } from "@/lib/quality/capa-closure";

const scope = {
  organizationId: "org-a",
  siteId: "site-a",
  eventId: "event-1",
};

describe("CAPA quality-event closure guard", () => {
  beforeEach(() => {
    mocks.findFirst.mockReset();
  });

  it("allows normal event scoping when no CAPA exists", async () => {
    mocks.findFirst.mockResolvedValue(null);
    await expect(assertEffectiveCapaForEvent(scope)).resolves.toBeUndefined();
  });

  it("does not reveal a CAPA snapshot from another tenant", async () => {
    mocks.findFirst.mockResolvedValue({
      afterJson: JSON.stringify({
        organizationId: "org-b",
        siteId: "site-b",
        status: "ACTIVE",
      }),
    });
    await expect(assertEffectiveCapaForEvent(scope)).resolves.toBeUndefined();
  });

  it("blocks closure while the scoped CAPA actions remain incomplete", async () => {
    mocks.findFirst.mockResolvedValueOnce({
      afterJson: JSON.stringify({
        organizationId: "org-a",
        siteId: "site-a",
        status: "ACTIVE",
      }),
    });
    await expect(assertEffectiveCapaForEvent(scope)).rejects.toMatchObject({
      code: "CAPA_INCOMPLETE",
    });
  });

  it("requires a positive effectiveness verification for a ready CAPA", async () => {
    mocks.findFirst
      .mockResolvedValueOnce({
        afterJson: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          status: "READY_FOR_EFFECTIVENESS",
        }),
      })
      .mockResolvedValueOnce({
        afterJson: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          status: "VERIFIED",
          result: "INEFFECTIVE",
        }),
      });
    await expect(assertEffectiveCapaForEvent(scope)).rejects.toMatchObject({
      code: "CAPA_INCOMPLETE",
    });
  });

  it("allows closure after scoped CAPA effectiveness is verified as effective", async () => {
    mocks.findFirst
      .mockResolvedValueOnce({
        afterJson: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          status: "READY_FOR_EFFECTIVENESS",
        }),
      })
      .mockResolvedValueOnce({
        afterJson: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          status: "VERIFIED",
          result: "EFFECTIVE",
        }),
      });
    await expect(assertEffectiveCapaForEvent(scope)).resolves.toBeUndefined();
  });
});
