import { describe, expect, it } from "vitest";
import type { AssetAssistantAnswer } from "@/lib/ai/asset-context-assistant";
import {
  AiCitationError,
  attachServerOwnedCitations,
  citeAssetAssistantAnswer,
  citeTroubleshootingResult,
  citeWorkOrderSummary,
} from "@/lib/ai/citations";
import type { TroubleshootingResult } from "@/lib/ai/troubleshooting";
import type { WorkOrderSummaryResult } from "@/lib/ai/work-order-summarization";

function assetAnswer(): AssetAssistantAnswer {
  return {
    answer: "The pump is active and had a recent inspection.",
    providerId: "test-llm",
    model: "test-model-v1",
    finishReason: "stop",
    usage: null,
    asset: { id: "asset-1", code: "P-101", name: "Feed pump", siteId: "site-a" },
    sources: [
      { type: "asset", id: "asset-1", code: "P-101", href: "/assets/asset-1" },
      {
        type: "work-order",
        id: "wo-1",
        number: "WO-1001",
        href: "/maintenance/wo-1",
      },
    ],
  };
}

function workOrderSummary(): WorkOrderSummaryResult {
  return {
    summary: "WO-1001 is completed with all checklist items recorded.",
    providerId: "test-llm",
    model: "test-model-v1",
    finishReason: "stop",
    usage: null,
    workOrder: { id: "wo-1", number: "WO-1001", siteId: "site-a", status: "COMPLETED" },
    sources: [
      {
        type: "work-order",
        id: "wo-1",
        number: "WO-1001",
        href: "/maintenance/wo-1",
      },
      { type: "asset", id: "asset-1", code: "P-101", href: "/assets/asset-1" },
      {
        type: "controlled-document",
        id: "doc-1",
        code: "SOP-001",
        title: "Pump inspection",
        href: "/documents/doc-1",
      },
    ],
  };
}

function troubleshooting(): TroubleshootingResult {
  return {
    suggestion: "Check vibration against the current controlled procedure.",
    providerId: "test-llm",
    model: "test-model-v1",
    finishReason: "stop",
    usage: null,
    asset: { id: "asset-1", code: "P-101", name: "Feed pump", siteId: "site-a" },
    sources: [
      { type: "asset", id: "asset-1", code: "P-101", href: "/assets/asset-1" },
      {
        type: "work-order",
        id: "wo-1",
        number: "WO-1001",
        href: "/maintenance/wo-1",
      },
      {
        type: "controlled-document",
        documentId: "doc-1",
        documentCode: "SOP-001",
        documentTitle: "Pump inspection",
        revisionId: "rev-2",
        revision: "B",
        checksum: "sha-256",
        effectiveAt: "2026-08-01T00:00:00.000Z",
        score: 0.91,
        href: "/documents/doc-1",
      },
    ],
  };
}

describe("AI source citations", () => {
  it("owns citation markers on the server and removes model-authored lookalikes", () => {
    const result = attachServerOwnedCitations({
      text: "The provider tried to cite [S999] on its own.",
      sources: [
        {
          type: "asset",
          recordId: "asset-1",
          revisionId: null,
          label: "Asset P-101",
          href: "/assets/asset-1",
        },
      ],
    });

    expect(result.text).not.toContain("[S999]");
    expect(result.text).toContain("[unverified source marker removed]");
    expect(result.text).toContain("Sources:\n[S1] Asset P-101 — /assets/asset-1");
    expect(result.citations).toEqual([
      {
        marker: "[S1]",
        type: "asset",
        recordId: "asset-1",
        revisionId: null,
        label: "Asset P-101",
        href: "/assets/asset-1",
      },
    ]);
  });

  it("rejects source routes that do not match the authorized record identity", () => {
    expect(() =>
      attachServerOwnedCitations({
        text: "Answer",
        sources: [
          {
            type: "work-order",
            recordId: "wo-1",
            revisionId: null,
            label: "Work order WO-1001",
            href: "/maintenance/wo-other",
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_SOURCE" }));
  });

  it("fails closed instead of returning an uncited AI answer", () => {
    expect(() => attachServerOwnedCitations({ text: "Answer", sources: [] })).toThrowError(
      expect.objectContaining({ code: "NO_SOURCES" }),
    );
    expect(() => attachServerOwnedCitations({ text: "   ", sources: [] })).toThrowError(
      AiCitationError,
    );
  });

  it("adds deterministic asset and work-order citations to asset assistant answers", () => {
    const result = citeAssetAssistantAnswer(assetAnswer());

    expect(result.answer).toContain("Sources:");
    expect(result.answer).toContain("[S1] Asset P-101 — /assets/asset-1");
    expect(result.answer).toContain("[S2] Work order WO-1001 — /maintenance/wo-1");
    expect(result.citations.map((citation) => citation.type)).toEqual(["asset", "work-order"]);
  });

  it("cites the work order, linked asset, and linked controlled-document record in summaries", () => {
    const result = citeWorkOrderSummary(workOrderSummary());

    expect(result.summary).toContain("[S1] Work order WO-1001 — /maintenance/wo-1");
    expect(result.summary).toContain("[S2] Asset P-101 — /assets/asset-1");
    expect(result.summary).toContain(
      "[S3] Controlled document SOP-001 · Pump inspection — /documents/doc-1",
    );
    expect(result.citations[2]).toMatchObject({
      type: "controlled-document",
      recordId: "doc-1",
      revisionId: null,
    });
  });

  it("preserves exact effective revision identity for troubleshooting document citations", () => {
    const result = citeTroubleshootingResult(troubleshooting());

    expect(result.suggestion).toContain(
      "[S3] Controlled document SOP-001 · Pump inspection · revision B — /documents/doc-1",
    );
    expect(result.citations[2]).toEqual({
      marker: "[S3]",
      type: "controlled-document",
      recordId: "doc-1",
      revisionId: "rev-2",
      label: "Controlled document SOP-001 · Pump inspection · revision B",
      href: "/documents/doc-1",
    });
  });

  it("deduplicates repeated authorized sources without changing marker order", () => {
    const answer = assetAnswer();
    answer.sources.push(answer.sources[0]!);

    const result = citeAssetAssistantAnswer(answer);

    expect(result.citations).toHaveLength(2);
    expect(result.answer.match(/\[S1\]/g)).toHaveLength(1);
    expect(result.answer.match(/\[S2\]/g)).toHaveLength(1);
  });
});
