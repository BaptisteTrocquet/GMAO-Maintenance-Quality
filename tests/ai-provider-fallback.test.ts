import { describe, expect, it, vi } from "vitest";
import type { MembershipScope } from "@/lib/access-control";
import {
  AiAuditError,
  type AiAuditEvent,
  type AiAuditSink,
} from "@/lib/ai/audit";
import type { AssetAssistantAssetRecord } from "@/lib/ai/asset-context-assistant";
import {
  createResilientAssetContextAssistant,
  createResilientTroubleshootingAdvisor,
  createResilientWorkOrderSummarizer,
} from "@/lib/ai/fallback";
import {
  LlmProviderRegistry,
  type LlmProvider,
  type LlmProviderGenerateInput,
} from "@/lib/ai/llm-provider";
import type { TroubleshootingAssetRecord } from "@/lib/ai/troubleshooting";
import type { WorkOrderSummaryRecord } from "@/lib/ai/work-order-summarization";

function scope(): MembershipScope {
  return {
    role: "TECHNICIAN",
    active: true,
    allSites: false,
    siteIds: ["site-a"],
  };
}

function authorization() {
  return {
    organizationId: "org-a",
    siteId: "site-a",
    actorId: "user-a",
    scope: scope(),
  };
}

function auditRecorder(input?: { fail?: boolean }) {
  const events: AiAuditEvent[] = [];
  const write = vi.fn(async (event: AiAuditEvent) => {
    events.push(event);
    if (input?.fail) throw new Error("audit storage unavailable");
  });
  const sink: AiAuditSink = { write };
  return { sink, write, events };
}

function provider(input?: { enabled?: boolean; fail?: boolean }) {
  const generate = vi.fn(async (request: LlmProviderGenerateInput) => {
    if (input?.fail) throw new Error("provider internal detail");
    return {
      text: "Generated maintenance answer.",
      model: request.model,
      finishReason: "stop" as const,
      usage: { inputTokens: 50, outputTokens: 10 },
    };
  });
  const adapter: LlmProvider = {
    id: "test-llm",
    displayName: "Test LLM",
    enabled: input?.enabled ?? true,
    defaultModel: input?.enabled === false ? null : "test-model",
    capabilities: { streaming: false, structuredOutput: false, toolCalling: false },
    generate,
  };
  return { adapter, generate };
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
    installedAt: null,
    commissionedAt: null,
    decommissionedAt: null,
    archivedAt: null,
    site: {
      id: "site-a",
      organizationId: "org-a",
      code: "PA",
      name: "Plant A",
      active: true,
    },
    location: null,
    workOrders: [],
  };
}

function workOrderRecord(): WorkOrderSummaryRecord {
  return {
    id: "wo-1",
    number: "WO-1001",
    siteId: "site-a",
    assetId: null,
    title: "Inspect vibration",
    type: "INSPECTION",
    status: "PLANNED",
    priority: "HIGH",
    requestedAt: new Date("2026-08-01T08:00:00.000Z"),
    plannedStart: null,
    dueAt: null,
    startedAt: null,
    completedAt: null,
    downtimeMinutes: null,
    laborMinutes: null,
    site: {
      id: "site-a",
      organizationId: "org-a",
      code: "PA",
      name: "Plant A",
      active: true,
    },
    asset: null,
    checkItems: [],
    partConsumptions: [],
    documents: [],
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
    workOrders: [],
  };
}

describe("AI provider fallback", () => {
  it("returns a deterministic disabled state without invoking the disabled provider adapter", async () => {
    const { adapter, generate } = provider({ enabled: false });
    const audit = auditRecorder();
    const assistant = createResilientAssetContextAssistant({
      llmRegistry: new LlmProviderRegistry([adapter]),
      providerId: adapter.id,
      repository: { findAssetContext: vi.fn(async () => assetRecord()) },
      auditSink: audit.sink,
    });

    const result = await assistant.ask({
      authorization: authorization(),
      assetId: "asset-1",
      question: "What is the maintenance picture?",
    });

    expect(result).toEqual({
      status: "unavailable",
      reason: "AI_DISABLED",
      retryable: false,
      message: "AI is disabled. Core maintenance data and workflows remain available.",
    });
    expect(generate).not.toHaveBeenCalled();
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      entityType: "Asset",
      entityId: "asset-1",
      action: "AI_CONTEXT_FAILED",
      payload: { status: "FAILED", failure: { stage: "provider", code: "PROVIDER_DISABLED" } },
    });
  });

  it("returns not-configured when the selected provider is absent", async () => {
    const audit = auditRecorder();
    const assistant = createResilientAssetContextAssistant({
      llmRegistry: new LlmProviderRegistry(),
      providerId: "missing-provider",
      repository: { findAssetContext: vi.fn(async () => assetRecord()) },
      auditSink: audit.sink,
    });

    await expect(
      assistant.ask({ authorization: authorization(), assetId: "asset-1", question: "Status?" }),
    ).resolves.toMatchObject({
      status: "unavailable",
      reason: "AI_NOT_CONFIGURED",
      retryable: false,
    });
    expect(audit.events[0]?.payload.failure).toEqual({
      stage: "provider",
      code: "PROVIDER_NOT_FOUND",
    });
  });

  it("converts provider failures to a retryable safe state after auditing them", async () => {
    const { adapter } = provider({ fail: true });
    const audit = auditRecorder();
    const assistant = createResilientAssetContextAssistant({
      llmRegistry: new LlmProviderRegistry([adapter]),
      providerId: adapter.id,
      repository: { findAssetContext: vi.fn(async () => assetRecord()) },
      auditSink: audit.sink,
    });

    const result = await assistant.ask({
      authorization: authorization(),
      assetId: "asset-1",
      question: "Status?",
    });

    expect(result).toMatchObject({
      status: "unavailable",
      reason: "AI_TEMPORARILY_UNAVAILABLE",
      retryable: true,
    });
    expect(JSON.stringify(audit.events[0])).not.toContain("provider internal detail");
  });

  it("does not hide request, authorization, tenant, citation, or audit errors as provider fallback", async () => {
    const { adapter } = provider({ enabled: false });
    const audit = auditRecorder();
    const assistant = createResilientAssetContextAssistant({
      llmRegistry: new LlmProviderRegistry([adapter]),
      providerId: adapter.id,
      repository: { findAssetContext: vi.fn(async () => assetRecord()) },
      auditSink: audit.sink,
    });

    await expect(
      assistant.ask({ authorization: authorization(), assetId: "asset-1", question: "" }),
    ).rejects.toMatchObject({ name: "AssetContextAssistantError", code: "INVALID_REQUEST" });
    expect(audit.write).not.toHaveBeenCalled();

    const failingAudit = auditRecorder({ fail: true });
    const second = createResilientAssetContextAssistant({
      llmRegistry: new LlmProviderRegistry([adapter]),
      providerId: adapter.id,
      repository: { findAssetContext: vi.fn(async () => assetRecord()) },
      auditSink: failingAudit.sink,
    });
    await expect(
      second.ask({ authorization: authorization(), assetId: "asset-1", question: "Status?" }),
    ).rejects.toBeInstanceOf(AiAuditError);
  });

  it("returns generated cited output unchanged when AI succeeds", async () => {
    const { adapter } = provider();
    const audit = auditRecorder();
    const assistant = createResilientAssetContextAssistant({
      llmRegistry: new LlmProviderRegistry([adapter]),
      providerId: adapter.id,
      repository: { findAssetContext: vi.fn(async () => assetRecord()) },
      auditSink: audit.sink,
    });

    const result = await assistant.ask({
      authorization: authorization(),
      assetId: "asset-1",
      question: "Status?",
    });

    expect(result.status).toBe("generated");
    if (result.status !== "generated") throw new Error("Expected generated AI result");
    expect(result.result.answer).toContain("Sources:");
    expect(result.result.citations[0]).toMatchObject({ type: "asset", recordId: "asset-1" });
    expect(audit.events[0]?.payload.status).toBe("SUCCEEDED");
  });

  it("provides the same disabled fallback contract for work-order summaries", async () => {
    const { adapter, generate } = provider({ enabled: false });
    const audit = auditRecorder();
    const summarizer = createResilientWorkOrderSummarizer({
      llmRegistry: new LlmProviderRegistry([adapter]),
      providerId: adapter.id,
      repository: { findWorkOrderSummaryContext: vi.fn(async () => workOrderRecord()) },
      auditSink: audit.sink,
    });

    const result = await summarizer.summarize({
      authorization: authorization(),
      workOrderId: "wo-1",
    });

    expect(result).toMatchObject({ status: "unavailable", reason: "AI_DISABLED", retryable: false });
    expect(generate).not.toHaveBeenCalled();
    expect(audit.events[0]).toMatchObject({ entityType: "WorkOrder", entityId: "wo-1" });
  });

  it("provides the same disabled fallback contract for troubleshooting", async () => {
    const { adapter, generate } = provider({ enabled: false });
    const audit = auditRecorder();
    const documentSearch = { search: vi.fn(async () => []) };
    const advisor = createResilientTroubleshootingAdvisor({
      llmRegistry: new LlmProviderRegistry([adapter]),
      providerId: adapter.id,
      repository: { findAssetHistory: vi.fn(async () => troubleshootingRecord()) },
      documentSearch,
      auditSink: audit.sink,
    });

    const result = await advisor.suggest({
      authorization: authorization(),
      assetId: "asset-1",
      symptom: "High vibration",
    });

    expect(result).toMatchObject({ status: "unavailable", reason: "AI_DISABLED", retryable: false });
    expect(generate).not.toHaveBeenCalled();
    expect(documentSearch.search).toHaveBeenCalledTimes(1);
    expect(audit.events[0]).toMatchObject({ entityType: "Asset", entityId: "asset-1" });
  });

  it("blocks serialized sensitive fields before an enabled provider can receive them", async () => {
    const { adapter, generate } = provider();
    const registry = new LlmProviderRegistry([adapter]);

    await expect(
      registry.generate({
        providerId: adapter.id,
        context: {
          organizationId: "org-a",
          siteId: "site-a",
          actorId: "user-a",
          purpose: "policy-test",
        },
        request: {
          messages: [
            {
              role: "user",
              content: 'Authorized context: {"assetId":"asset-1","requesterId":"user-secret"}',
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ name: "LlmProviderError", code: "INVALID_REQUEST" });
    expect(generate).not.toHaveBeenCalled();
  });
});
