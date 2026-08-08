import {
  AiCitationError,
  createCitedAssetContextAssistant,
  createCitedTroubleshootingAdvisor,
  createCitedWorkOrderSummarizer,
  type AiCitation,
} from "@/lib/ai/citations";
import { assertAiAuditPayloadSafe } from "@/lib/ai/context-policy";
import { LlmProviderError, type LlmUsage } from "@/lib/ai/llm-provider";
import { db } from "@/lib/db";

export type AiAuditSurface = "asset-context" | "work-order-summary" | "troubleshooting";
export type AiAuditStatus = "SUCCEEDED" | "FAILED";

export type AiAuditCitationRef = {
  type: AiCitation["type"];
  recordId: string;
  revisionId: string | null;
};

export type AiAuditPayload = {
  schemaVersion: 1;
  ai: true;
  surface: AiAuditSurface;
  status: AiAuditStatus;
  organizationId: string;
  siteId: string;
  providerId: string;
  model?: string;
  finishReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  } | null;
  sourceCount?: number;
  citationCount?: number;
  sources?: AiAuditCitationRef[];
  failure?: {
    stage: "provider" | "citation";
    code: string;
  };
};

export type AiAuditEvent = {
  actorId: string;
  entityType: "Asset" | "WorkOrder";
  entityId: string;
  action:
    | "AI_CONTEXT_ANSWERED"
    | "AI_CONTEXT_FAILED"
    | "AI_SUMMARY_GENERATED"
    | "AI_SUMMARY_FAILED"
    | "AI_TROUBLESHOOTING_SUGGESTED"
    | "AI_TROUBLESHOOTING_FAILED";
  payload: AiAuditPayload;
};

export interface AiAuditSink {
  write(event: AiAuditEvent): Promise<void>;
}

export class AiAuditError extends Error {
  constructor(
    public readonly code: "AUDIT_WRITE_FAILED" | "INVALID_AUDIT_EVENT",
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AiAuditError";
  }
}

export function createPrismaAiAuditSink(): AiAuditSink {
  return {
    async write(event) {
      await db.auditLog.create({
        data: {
          actorId: event.actorId,
          entityType: event.entityType,
          entityId: event.entityId,
          action: event.action,
          beforeJson: null,
          afterJson: JSON.stringify(event.payload),
        },
      });
    },
  };
}

function usagePayload(usage: LlmUsage | null | undefined) {
  if (!usage) return null;
  return {
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
  };
}

function citationRefs(citations: readonly AiCitation[]): AiAuditCitationRef[] {
  return citations.map((citation) => ({
    type: citation.type,
    recordId: citation.recordId,
    revisionId: citation.revisionId,
  }));
}

function successPayload(input: {
  surface: AiAuditSurface;
  organizationId: string;
  siteId: string;
  providerId: string;
  model: string;
  finishReason: string;
  usage: LlmUsage | null;
  citations: readonly AiCitation[];
}): AiAuditPayload {
  const sources = citationRefs(input.citations);
  return {
    schemaVersion: 1,
    ai: true,
    surface: input.surface,
    status: "SUCCEEDED",
    organizationId: input.organizationId,
    siteId: input.siteId,
    providerId: input.providerId,
    model: input.model,
    finishReason: input.finishReason,
    usage: usagePayload(input.usage),
    sourceCount: sources.length,
    citationCount: input.citations.length,
    sources,
  };
}

function failurePayload(input: {
  surface: AiAuditSurface;
  organizationId: string;
  siteId: string;
  providerId: string;
  failure: { stage: "provider" | "citation"; code: string };
}): AiAuditPayload {
  return {
    schemaVersion: 1,
    ai: true,
    surface: input.surface,
    status: "FAILED",
    organizationId: input.organizationId,
    siteId: input.siteId,
    providerId: input.providerId,
    failure: input.failure,
  };
}

function classifyAuditableFailure(error: unknown) {
  if (error instanceof LlmProviderError) {
    return { stage: "provider" as const, code: error.code };
  }
  if (error instanceof AiCitationError) {
    return { stage: "citation" as const, code: error.code };
  }
  return null;
}

async function writeAudit(sink: AiAuditSink, event: AiAuditEvent) {
  try {
    assertAiAuditPayloadSafe(event.payload);
  } catch (error) {
    throw new AiAuditError(
      "INVALID_AUDIT_EVENT",
      "AI audit event violates the safe audit payload policy",
      error,
    );
  }

  try {
    await sink.write(event);
  } catch (error) {
    throw new AiAuditError("AUDIT_WRITE_FAILED", "AI audit event could not be persisted", error);
  }
}

function auditTarget(input: {
  surface: AiAuditSurface;
  success: boolean;
  entityId: string;
}) {
  if (input.surface === "work-order-summary") {
    return {
      entityType: "WorkOrder" as const,
      entityId: input.entityId,
      action: input.success ? ("AI_SUMMARY_GENERATED" as const) : ("AI_SUMMARY_FAILED" as const),
    };
  }
  if (input.surface === "troubleshooting") {
    return {
      entityType: "Asset" as const,
      entityId: input.entityId,
      action: input.success
        ? ("AI_TROUBLESHOOTING_SUGGESTED" as const)
        : ("AI_TROUBLESHOOTING_FAILED" as const),
    };
  }
  return {
    entityType: "Asset" as const,
    entityId: input.entityId,
    action: input.success ? ("AI_CONTEXT_ANSWERED" as const) : ("AI_CONTEXT_FAILED" as const),
  };
}

export function createAuditedAssetContextAssistant(
  input: Parameters<typeof createCitedAssetContextAssistant>[0] & { auditSink?: AiAuditSink },
) {
  const { auditSink = createPrismaAiAuditSink(), ...assistantInput } = input;
  const assistant = createCitedAssetContextAssistant(assistantInput);

  return {
    async ask(args: Parameters<typeof assistant.ask>[0]) {
      try {
        const result = await assistant.ask(args);
        const target = auditTarget({ surface: "asset-context", success: true, entityId: result.asset.id });
        await writeAudit(auditSink, {
          actorId: args.authorization.actorId,
          ...target,
          payload: successPayload({
            surface: "asset-context",
            organizationId: args.authorization.organizationId,
            siteId: result.asset.siteId,
            providerId: result.providerId,
            model: result.model,
            finishReason: result.finishReason,
            usage: result.usage,
            citations: result.citations,
          }),
        });
        return result;
      } catch (error) {
        if (error instanceof AiAuditError) throw error;
        const failure = classifyAuditableFailure(error);
        if (!failure) throw error;
        const target = auditTarget({
          surface: "asset-context",
          success: false,
          entityId: args.assetId.trim(),
        });
        await writeAudit(auditSink, {
          actorId: args.authorization.actorId,
          ...target,
          payload: failurePayload({
            surface: "asset-context",
            organizationId: args.authorization.organizationId,
            siteId: args.authorization.siteId,
            providerId: assistantInput.providerId,
            failure,
          }),
        });
        throw error;
      }
    },
  };
}

export function createAuditedWorkOrderSummarizer(
  input: Parameters<typeof createCitedWorkOrderSummarizer>[0] & { auditSink?: AiAuditSink },
) {
  const { auditSink = createPrismaAiAuditSink(), ...summarizerInput } = input;
  const summarizer = createCitedWorkOrderSummarizer(summarizerInput);

  return {
    async summarize(args: Parameters<typeof summarizer.summarize>[0]) {
      try {
        const result = await summarizer.summarize(args);
        const target = auditTarget({
          surface: "work-order-summary",
          success: true,
          entityId: result.workOrder.id,
        });
        await writeAudit(auditSink, {
          actorId: args.authorization.actorId,
          ...target,
          payload: successPayload({
            surface: "work-order-summary",
            organizationId: args.authorization.organizationId,
            siteId: result.workOrder.siteId,
            providerId: result.providerId,
            model: result.model,
            finishReason: result.finishReason,
            usage: result.usage,
            citations: result.citations,
          }),
        });
        return result;
      } catch (error) {
        if (error instanceof AiAuditError) throw error;
        const failure = classifyAuditableFailure(error);
        if (!failure) throw error;
        const target = auditTarget({
          surface: "work-order-summary",
          success: false,
          entityId: args.workOrderId.trim(),
        });
        await writeAudit(auditSink, {
          actorId: args.authorization.actorId,
          ...target,
          payload: failurePayload({
            surface: "work-order-summary",
            organizationId: args.authorization.organizationId,
            siteId: args.authorization.siteId,
            providerId: summarizerInput.providerId,
            failure,
          }),
        });
        throw error;
      }
    },
  };
}

export function createAuditedTroubleshootingAdvisor(
  input: Parameters<typeof createCitedTroubleshootingAdvisor>[0] & { auditSink?: AiAuditSink },
) {
  const { auditSink = createPrismaAiAuditSink(), ...advisorInput } = input;
  const advisor = createCitedTroubleshootingAdvisor(advisorInput);

  return {
    async suggest(args: Parameters<typeof advisor.suggest>[0]) {
      try {
        const result = await advisor.suggest(args);
        const target = auditTarget({
          surface: "troubleshooting",
          success: true,
          entityId: result.asset.id,
        });
        await writeAudit(auditSink, {
          actorId: args.authorization.actorId,
          ...target,
          payload: successPayload({
            surface: "troubleshooting",
            organizationId: args.authorization.organizationId,
            siteId: result.asset.siteId,
            providerId: result.providerId,
            model: result.model,
            finishReason: result.finishReason,
            usage: result.usage,
            citations: result.citations,
          }),
        });
        return result;
      } catch (error) {
        if (error instanceof AiAuditError) throw error;
        const failure = classifyAuditableFailure(error);
        if (!failure) throw error;
        const target = auditTarget({
          surface: "troubleshooting",
          success: false,
          entityId: args.assetId.trim(),
        });
        await writeAudit(auditSink, {
          actorId: args.authorization.actorId,
          ...target,
          payload: failurePayload({
            surface: "troubleshooting",
            organizationId: args.authorization.organizationId,
            siteId: args.authorization.siteId,
            providerId: advisorInput.providerId,
            failure,
          }),
        });
        throw error;
      }
    },
  };
}
