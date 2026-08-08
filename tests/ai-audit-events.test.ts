import { describe, expect, it, vi } from "vitest";
import type { MembershipRole } from "@prisma/client";
import {
  AiAuditError,
  createAuditedAssetContextAssistant,
  createAuditedTroubleshootingAdvisor,
  createAuditedWorkOrderSummarizer,
  type AiAuditSink,
} from "@/lib/ai/audit";
import { assertAiAuditPayloadSafe, assertAiPromptContextSafe } from "@/lib/ai/context-policy";
import {
  LlmProviderRegistry,
  type LlmProvider,
  type LlmProviderGenerateInput,
} from "@/lib/ai/llm-provider";
import type { AssetAssistantAssetRecord } from "@/lib/ai/asset-context-assistant";
import type { WorkOrderSummaryRecord } from "@/lib/ai/work-order-summarization";
import type { TroubleshootingAssetRecord } from "@/lib/ai/troubleshooting";

function membership(input?: {
  role?: MembershipRole;
  active?: boolean;
  allSites?: boolean;
  siteIds?: string[];
}) {
  return {
    role: input?.role ?? "TECHNICIAN",
    active: input?.active ?? true,
    allSites: input?.allSites ?? false,
    siteIds: input?.siteIds ?? ["site-a"],
  } as const;
}

function authorization(scope = membership()) {
  return {
    organizationId: "org-a",
    siteId: "site-a",
    actorId: "user-a",
    scope,
  };
}

function provider(input?: { fail?: boolean }) {
  const adapter: LlmProvider = {
    id: "test-llm",
    displayName: "Test LLM",
    enabled: true,
    defaultModel: "test-model-v1",
    capabilities: { streaming: false, structuredOutput: false, toolCalling: false },
    generate: vi.fn(async (request: LlmProviderGenerateInput) => {
      if (input?.fail) throw new Error("provider secret detail that must not be audited");
      return {
        text: "Generated maintenance answer.",
        model: request.model,
        finishReason: "stop" as const,
        usage: { inputTokens: 80, outputTokens: 12 },
      };
    }),
  };
  return adapter;
}

function auditSink(input?: { fail?: boolean }) {
  const write = vi.fn(async () => {
    if (input?.fail) throw new Error("audit database unavailable");
  });
  return { write } satisfies AiAuditSink;
}

function assetRecord(): AssetAssistantAssetRecord {
  return {
    id: "asset-1",
    siteId: "site-a",
    code: "P-101",
    name: "Feed pump",
    category: "Pump",
    manufacturer: "Example Pumps",
    model: "XP-20",
    serialNumber: "SN-001",
    status: "ACTIVE",
    criticality: "HIGH",
    installedAt: new Date("2024-01-02T00:00:00.000Z"),
    commissionedAt: new Date("2024-01-15T00:00:00.000Z"),
    decommissionedAt: null,
    archivedAt: null,
    site: {
      id: "site-a",
      organizationId: "org-a",
      code: "PA",
      name: "Plant A",
      active: true,
    },
    location: { id: "loc-1", code: "UTIL", name: "Utilities" },
    workOrders: [
      {
        id: "wo-1",
        number: "WO-1001",
        siteId: "site-a",
        assetId: "asset-1",
        title: "Inspect vibration",
        type: "INSPECTION",
        status: "COMPLETED",
        priority: "HIGH",
        requestedAt: new Date("2026-08-01T08:00:00.000Z"),
        plannedStart: null,
        dueAt: null,
        startedAt: new Date("2026-08-01T09:00:00.000Z"),
        completedAt: new Date("2026-08-01T10:00:00.000Z"),
        downtimeMinutes: 20,
        laborMinutes: 45,
      },
    ],
  };
}

function workOrderRecord(): WorkOrderSummaryRecord {
  return {
    id: "wo-1",
    number: "WO-1001",
    siteId: "site-a",
    assetId: "asset-1",
    title: "Inspect vibration",
    type: "INSPECTION",
    status: "COMPLETED",
    priority: "HIGH",
    requestedAt: new Date("2026-08-01T08:00:00.000Z"),
    plannedStart: null,
    dueAt: null,
    startedAt: new Date("2026-08-01T09:00:00.000Z"),
    completedAt: new Date("2026-08-01T10:00:00.000Z"),
    downtimeMinutes: 20,
    laborMinutes: 45,
    site: {
      id: "site-a",
      organizationId: "org-a",
      code: "PA",
      name: "Plant A",
      active: true,
    },
    asset: {
      id: "asset-1",
      siteId: "site-a",
      code: "P-101",
      name: "Feed pump",
      status: "ACTIVE",
      criticality: "HIGH",
    },
    checkItems: [{ id: "check-1", label: "Measure vibration", completed: true }],
    partConsumptions: [],
    documents: [
      {
        documentId: "doc-1",
        document: {
          id: "doc-1",
          organizationId: "org-a",
          code: "SOP-001",
          title: "Pump inspection",
        },
      },
    ],
  };
}

function troubleshootingRecord(): TroubleshootingAssetRecord {
  return {
    id: "asset-1",
    siteId: "site-a",
    code: "P-101",
    name: "Feed pump",
    category: "Pump",
    manufacturer: "Example Pumps",
    model: "XP-20",
    status: "ACTIVE",
    criticality: "HIGH",
    archivedAt: null,
    site: {
      id: "site-a",
      organizationId: "org-a",
      code: "PA",
      name: "Plant A",
      active: true,
    },
    workOrders: [
      {
        id: "wo-1",
        number: "WO-1001",
        siteId: "site-a",
        assetId: "asset-1",
        title: "Inspect vibration",
        type: "INSPECTION",
        status: "COMPLETED",
        priority: "HIGH",
        requestedAt: new Date("2026-08-01T08:00:00.000Z"),
        startedAt: new Date("2026-08-01T09:00:00.000Z"),
        completedAt: new Date("2026-08-01T10:00:00.000Z"),
        downtimeMinutes: 20,
        laborMinutes: 45,
        partConsumptions: [],
      },
    ],
  };
}

describe("AI audit events", () => {
  it("writes a minimal successful asset audit after cited generation", async () => {
    const adapter = provider();
    const sink = auditSink();
    const assistant = createAuditedAssetContextAssistant({
      llmRegistry: new LlmProviderRegistry([adapter]),
      providerId: adapter.id,
      repository: { findAssetContext: vi.fn(async () => assetRecord()) },
      auditSink: sink,
    });

    const result = await assistant.ask({
      authorization: authorization(),
      assetId: "asset-1",
      question: "What is the current maintenance picture?",
    });

    expect(result.answer).toContain("Sources:");
    expect(sink.write).toHaveBeenCalledTimes(1);
    const event = sink.write.mock.calls[0]![0];
    expect(event).toMatchObject({
      actorId: "user-a",
      entityType: "Asset",
      entityId: "asset-1",
      action: "AI_CONTEXT_ANSWERED",
      payload: {
        schemaVersion: 1,
        ai: true,
        surface: "asset-context",
        status: "SUCCEEDED",
        organizationId: "org-a",
        siteId: "site-a",
        providerId: "test-llm",
        model: "test-model-v1",
        finishReason: "stop",
        usage: { inputTokens: 80, outputTokens: 12 },
        sourceCount: 2,
        citationCount: 2,
        sources: [
          { type: "asset", recordId: "asset-1", revisionId: null },
          { type: "work-order", recordId: "wo-1", revisionId: null },
        ],
      },
    });
    const serialized = JSON.stringify(event.payload);
    expect(serialized).not.toContain("Generated maintenance answer");
    expect(serialized).not.toContain("What is the current maintenance picture");
    expect(serialized).not.toContain("Feed pump");
    expect(serialized).not.toContain("/assets/");
  });

  it("records provider failures by safe code only and rethrows the provider error", async () => {
    const adapter = provider({ fail: true });
    const sink = auditSink();
    const assistant = createAuditedAssetContextAssistant({
      llmRegistry: new LlmProviderRegistry([adapter]),
      providerId: adapter.id,
      repository: { findAssetContext: vi.fn(async () => assetRecord()) },
      auditSink: sink,
    });

    await expect(
      assistant.ask({
        authorization: authorization(),
        assetId: "asset-1",
        question: "Status?",
      }),
    ).rejects.toMatchObject({ name: "LlmProviderError", code: "PROVIDER_ERROR" });

    expect(sink.write).toHaveBeenCalledTimes(1);
    const event = sink.write.mock.calls[0]![0];
    expect(event.action).toBe("AI_CONTEXT_FAILED");
    expect(event.payload).toMatchObject({
      status: "FAILED",
      failure: { stage: "provider", code: "PROVIDER_ERROR" },
    });
    expect(JSON.stringify(event.payload)).not.toContain("provider secret detail");
  });

  it("does not create audit noise for authorization failures", async () => {
    const adapter = provider();
    const sink = auditSink();
    const repository = { findAssetContext: vi.fn(async () => assetRecord()) };
    const assistant = createAuditedAssetContextAssistant({
      llmRegistry: new LlmProviderRegistry([adapter]),
      providerId: adapter.id,
      repository,
      auditSink: sink,
    });

    await expect(
      assistant.ask({
        authorization: authorization(membership({ active: false })),
        assetId: "asset-foreign-or-untrusted",
        question: "Status?",
      }),
    ).rejects.toMatchObject({ name: "AccessDeniedError" });

    expect(repository.findAssetContext).not.toHaveBeenCalled();
    expect(adapter.generate).not.toHaveBeenCalled();
    expect(sink.write).not.toHaveBeenCalled();
  });

  it("fails closed when a successful AI answer cannot be audited", async () => {
    const adapter = provider();
    const assistant = createAuditedAssetContextAssistant({
      llmRegistry: new LlmProviderRegistry([adapter]),
      providerId: adapter.id,
      repository: { findAssetContext: vi.fn(async () => assetRecord()) },
      auditSink: auditSink({ fail: true }),
    });

    await expect(
      assistant.ask({
        authorization: authorization(),
        assetId: "asset-1",
        question: "Status?",
      }),
    ).rejects.toMatchObject({ name: "AiAuditError", code: "AUDIT_WRITE_FAILED" });

    expect(adapter.generate).toHaveBeenCalledTimes(1);
  });

  it("writes a work-order audit tied to the WorkOrder entity", async () => {
    const adapter = provider();
    const sink = auditSink();
    const summarizer = createAuditedWorkOrderSummarizer({
      llmRegistry: new LlmProviderRegistry([adapter]),
      providerId: adapter.id,
      repository: { findWorkOrderSummaryContext: vi.fn(async () => workOrderRecord()) },
      auditSink: sink,
    });

    await summarizer.summarize({ authorization: authorization(), workOrderId: "wo-1" });

    expect(sink.write.mock.calls[0]![0]).toMatchObject({
      entityType: "WorkOrder",
      entityId: "wo-1",
      action: "AI_SUMMARY_GENERATED",
      payload: {
        surface: "work-order-summary",
        status: "SUCCEEDED",
        sources: [
          { type: "work-order", recordId: "wo-1", revisionId: null },
          { type: "asset", recordId: "asset-1", revisionId: null },
          { type: "controlled-document", recordId: "doc-1", revisionId: null },
        ],
      },
    });
  });

  it("preserves exact effective document revision provenance in troubleshooting audits", async () => {
    const adapter = provider();
    const sink = auditSink();
    const advisor = createAuditedTroubleshootingAdvisor({
      llmRegistry: new LlmProviderRegistry([adapter]),
      providerId: adapter.id,
      repository: { findAssetHistory: vi.fn(async () => troubleshootingRecord()) },
      documentSearch: {
        search: vi.fn(async () => [
          {
            score: 0.94,
            source: {
              type: "controlled-document" as const,
              documentId: "doc-1",
              documentCode: "SOP-001",
              documentTitle: "Pump inspection",
              revisionId: "rev-2",
              revision: "B",
              checksum: "checksum-1",
              effectiveAt: "2026-08-01T00:00:00.000Z",
              href: "/documents/doc-1",
            },
          },
        ]),
      },
      documentReader: vi.fn(async () => ({
        data: new TextEncoder().encode("Approved troubleshooting procedure."),
        fileName: "sop.txt",
        mimeType: "text/plain",
        checksum: "checksum-1",
      })),
      auditSink: sink,
    });

    await advisor.suggest({
      authorization: authorization(),
      assetId: "asset-1",
      symptom: "High vibration",
    });

    const event = sink.write.mock.calls[0]![0];
    expect(event).toMatchObject({
      entityType: "Asset",
      entityId: "asset-1",
      action: "AI_TROUBLESHOOTING_SUGGESTED",
      payload: {
        surface: "troubleshooting",
        status: "SUCCEEDED",
      },
    });
    expect(event.payload.sources).toContainEqual({
      type: "controlled-document",
      recordId: "doc-1",
      revisionId: "rev-2",
    });
    expect(JSON.stringify(event.payload)).not.toContain("Approved troubleshooting procedure");
  });

  it("blocks sensitive keys in AI prompt and audit policy objects", () => {
    expect(() =>
      assertAiPromptContextSafe({ asset: { id: "asset-1", requesterId: "user-secret" } }),
    ).toThrowError(expect.objectContaining({ code: "FORBIDDEN_FIELD" }));
    expect(() =>
      assertAiAuditPayloadSafe({ surface: "asset-context", answer: "generated secret text" }),
    ).toThrowError(expect.objectContaining({ code: "FORBIDDEN_FIELD" }));
    expect(() =>
      assertAiAuditPayloadSafe({
        surface: "asset-context",
        providerId: "test-llm",
        sources: [{ type: "asset", recordId: "asset-1", revisionId: null }],
      }),
    ).not.toThrow();
  });

  it("exposes a stable audit error type for callers", () => {
    const error = new AiAuditError("AUDIT_WRITE_FAILED", "failed");
    expect(error.name).toBe("AiAuditError");
    expect(error.code).toBe("AUDIT_WRITE_FAILED");
  });
});
