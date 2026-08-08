import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  listQualityEvidence: vi.fn(),
  addQualityEvidence: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/quality/evidence", () => ({
  listQualityEvidence: mocks.listQualityEvidence,
  addQualityEvidence: mocks.addQualityEvidence,
  MAX_QUALITY_EVIDENCE_BYTES: 20 * 1024 * 1024,
  QualityEvidenceError: class QualityEvidenceError extends Error {},
}));

import { GET } from "@/app/api/quality/events/[eventId]/evidence/route";

it("rejects unsupported evidence phase filters before authentication", async () => {
  const response = await GET(
    new Request(
      "http://localhost/api/quality/events/event-1/evidence?organizationId=org-a&siteId=site-a&phase=UNSUPPORTED",
    ),
    { params: Promise.resolve({ eventId: "event-1" }) },
  );

  expect(response?.status).toBe(400);
  expect(await response!.json()).toMatchObject({ error: { code: "INVALID_PHASE" } });
  expect(mocks.authenticateRequest).not.toHaveBeenCalled();
  expect(mocks.listQualityEvidence).not.toHaveBeenCalled();
});
