import {
  createAssetContextAssistant,
  type AssetAssistantAnswer,
  type AssetAssistantSource,
} from "@/lib/ai/asset-context-assistant";
import {
  createTroubleshootingAdvisor,
  type TroubleshootingResult,
  type TroubleshootingSource,
} from "@/lib/ai/troubleshooting";
import {
  createWorkOrderSummarizer,
  type WorkOrderSummaryResult,
  type WorkOrderSummarySource,
} from "@/lib/ai/work-order-summarization";

const MAX_LABEL_CHARS = 500;
const MAX_HREF_CHARS = 1_000;
const SERVER_MARKER_PATTERN = /\[S\d{1,3}\]/g;

export type AiCitation = {
  marker: string;
  type: "asset" | "work-order" | "controlled-document";
  recordId: string;
  revisionId: string | null;
  label: string;
  href: string;
};

export class AiCitationError extends Error {
  constructor(
    public readonly code: "INVALID_ANSWER" | "INVALID_SOURCE" | "NO_SOURCES",
    message: string,
  ) {
    super(message);
    this.name = "AiCitationError";
  }
}

type CitationCandidate = Omit<AiCitation, "marker">;

function normalizeText(value: string, label: string, maxLength: number) {
  if (typeof value !== "string") {
    throw new AiCitationError("INVALID_SOURCE", `${label} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000\r\n]/.test(normalized)) {
    throw new AiCitationError("INVALID_SOURCE", `${label} is invalid`);
  }
  return normalized;
}

function expectedHref(source: CitationCandidate) {
  const id = encodeURIComponent(source.recordId);
  if (source.type === "asset") return `/assets/${id}`;
  if (source.type === "work-order") return `/maintenance/${id}`;
  return `/documents/${id}`;
}

function normalizeSource(source: CitationCandidate): CitationCandidate {
  const recordId = normalizeText(source.recordId, "Citation record id", 200);
  const revisionId = source.revisionId
    ? normalizeText(source.revisionId, "Citation revision id", 200)
    : null;
  const label = normalizeText(source.label, "Citation label", MAX_LABEL_CHARS);
  const href = normalizeText(source.href, "Citation href", MAX_HREF_CHARS);
  const normalized = { ...source, recordId, revisionId, label, href };

  if (href !== expectedHref(normalized)) {
    throw new AiCitationError("INVALID_SOURCE", "Citation href does not match its source record");
  }
  return normalized;
}

function sourceKey(source: CitationCandidate) {
  return `${source.type}:${source.recordId}:${source.revisionId ?? ""}`;
}

export function attachServerOwnedCitations(input: {
  text: string;
  sources: readonly CitationCandidate[];
}) {
  if (typeof input.text !== "string" || !input.text.trim()) {
    throw new AiCitationError("INVALID_ANSWER", "AI answer cannot be empty");
  }

  const deduplicated: CitationCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of input.sources) {
    const source = normalizeSource(candidate);
    const key = sourceKey(source);
    if (seen.has(key)) continue;
    seen.add(key);
    deduplicated.push(source);
  }
  if (deduplicated.length === 0) {
    throw new AiCitationError("NO_SOURCES", "AI answers must cite at least one authorized source");
  }

  const citations: AiCitation[] = deduplicated.map((source, index) => ({
    marker: `[S${index + 1}]`,
    ...source,
  }));

  // Source markers are server-owned. Remove model-authored lookalikes so a provider cannot spoof provenance.
  const answerText = input.text.replace(SERVER_MARKER_PATTERN, "[unverified source marker removed]").trim();
  const sourceLines = citations.map(
    (citation) => `${citation.marker} ${citation.label} — ${citation.href}`,
  );

  return {
    text: `${answerText}\n\nSources:\n${sourceLines.join("\n")}`,
    citations,
  };
}

function assetAssistantCandidates(sources: readonly AssetAssistantSource[]): CitationCandidate[] {
  return sources.map((source) =>
    source.type === "asset"
      ? {
          type: "asset" as const,
          recordId: source.id,
          revisionId: null,
          label: `Asset ${source.code}`,
          href: source.href,
        }
      : {
          type: "work-order" as const,
          recordId: source.id,
          revisionId: null,
          label: `Work order ${source.number}`,
          href: source.href,
        },
  );
}

function workOrderSummaryCandidates(sources: readonly WorkOrderSummarySource[]): CitationCandidate[] {
  return sources.map((source) => {
    if (source.type === "work-order") {
      return {
        type: "work-order" as const,
        recordId: source.id,
        revisionId: null,
        label: `Work order ${source.number}`,
        href: source.href,
      };
    }
    if (source.type === "asset") {
      return {
        type: "asset" as const,
        recordId: source.id,
        revisionId: null,
        label: `Asset ${source.code}`,
        href: source.href,
      };
    }
    return {
      type: "controlled-document" as const,
      recordId: source.id,
      revisionId: null,
      label: `Controlled document ${source.code} · ${source.title}`,
      href: source.href,
    };
  });
}

function troubleshootingCandidates(sources: readonly TroubleshootingSource[]): CitationCandidate[] {
  return sources.map((source) => {
    if (source.type === "asset") {
      return {
        type: "asset" as const,
        recordId: source.id,
        revisionId: null,
        label: `Asset ${source.code}`,
        href: source.href,
      };
    }
    if (source.type === "work-order") {
      return {
        type: "work-order" as const,
        recordId: source.id,
        revisionId: null,
        label: `Work order ${source.number}`,
        href: source.href,
      };
    }
    return {
      type: "controlled-document" as const,
      recordId: source.documentId,
      revisionId: source.revisionId,
      label: `Controlled document ${source.documentCode} · ${source.documentTitle} · revision ${source.revision}`,
      href: source.href,
    };
  });
}

export type CitedAssetAssistantAnswer = Omit<AssetAssistantAnswer, "answer"> & {
  answer: string;
  citations: AiCitation[];
};

export type CitedWorkOrderSummaryResult = Omit<WorkOrderSummaryResult, "summary"> & {
  summary: string;
  citations: AiCitation[];
};

export type CitedTroubleshootingResult = Omit<TroubleshootingResult, "suggestion"> & {
  suggestion: string;
  citations: AiCitation[];
};

export function citeAssetAssistantAnswer(
  result: AssetAssistantAnswer,
): CitedAssetAssistantAnswer {
  const cited = attachServerOwnedCitations({
    text: result.answer,
    sources: assetAssistantCandidates(result.sources),
  });
  return { ...result, answer: cited.text, citations: cited.citations };
}

export function citeWorkOrderSummary(
  result: WorkOrderSummaryResult,
): CitedWorkOrderSummaryResult {
  const cited = attachServerOwnedCitations({
    text: result.summary,
    sources: workOrderSummaryCandidates(result.sources),
  });
  return { ...result, summary: cited.text, citations: cited.citations };
}

export function citeTroubleshootingResult(
  result: TroubleshootingResult,
): CitedTroubleshootingResult {
  const cited = attachServerOwnedCitations({
    text: result.suggestion,
    sources: troubleshootingCandidates(result.sources),
  });
  return { ...result, suggestion: cited.text, citations: cited.citations };
}

export function createCitedAssetContextAssistant(
  input: Parameters<typeof createAssetContextAssistant>[0],
) {
  const assistant = createAssetContextAssistant(input);
  return {
    async ask(args: Parameters<typeof assistant.ask>[0]): Promise<CitedAssetAssistantAnswer> {
      return citeAssetAssistantAnswer(await assistant.ask(args));
    },
  };
}

export function createCitedWorkOrderSummarizer(
  input: Parameters<typeof createWorkOrderSummarizer>[0],
) {
  const summarizer = createWorkOrderSummarizer(input);
  return {
    async summarize(
      args: Parameters<typeof summarizer.summarize>[0],
    ): Promise<CitedWorkOrderSummaryResult> {
      return citeWorkOrderSummary(await summarizer.summarize(args));
    },
  };
}

export function createCitedTroubleshootingAdvisor(
  input: Parameters<typeof createTroubleshootingAdvisor>[0],
) {
  const advisor = createTroubleshootingAdvisor(input);
  return {
    async suggest(
      args: Parameters<typeof advisor.suggest>[0],
    ): Promise<CitedTroubleshootingResult> {
      return citeTroubleshootingResult(await advisor.suggest(args));
    },
  };
}
