"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  IshikawaCategory,
  IshikawaCause,
  RootCauseMethod,
  RootCauseSnapshot,
} from "@/lib/quality/root-cause";

const categories: IshikawaCategory[] = [
  "PEOPLE",
  "METHOD",
  "MACHINE",
  "MATERIAL",
  "MEASUREMENT",
  "ENVIRONMENT",
];

type Props = {
  organizationId: string;
  siteId: string;
  eventId: string;
  eventStatus: "OPEN" | "CONTAINED" | "INVESTIGATING" | "CLOSED";
  initialRootCause: RootCauseSnapshot | null;
};

type EditableCause = IshikawaCause & { key: string };

function blankFiveWhys(rootCause: RootCauseSnapshot | null) {
  return Array.from({ length: 5 }, (_, index) => {
    const existing = rootCause?.fiveWhys.find((step) => step.sequence === index + 1);
    return {
      prompt: existing?.prompt ?? "Why?",
      answer: existing?.answer ?? "",
    };
  });
}

function initialCauses(rootCause: RootCauseSnapshot | null): EditableCause[] {
  return (rootCause?.ishikawa ?? []).map((cause, index) => ({
    ...cause,
    key: `${index}-${cause.category}-${cause.cause}`,
  }));
}

export default function RootCauseWorkspace({
  organizationId,
  siteId,
  eventId,
  eventStatus,
  initialRootCause,
}: Props) {
  const router = useRouter();
  const [rootCause, setRootCause] = useState(initialRootCause);
  const [method, setMethod] = useState<RootCauseMethod>(initialRootCause?.method ?? "FIVE_WHYS");
  const [problemStatement, setProblemStatement] = useState(initialRootCause?.problemStatement ?? "");
  const [fiveWhys, setFiveWhys] = useState(() => blankFiveWhys(initialRootCause));
  const [ishikawa, setIshikawa] = useState<EditableCause[]>(() => initialCauses(initialRootCause));
  const [rootCauseSummary, setRootCauseSummary] = useState(initialRootCause?.rootCauseSummary ?? "");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "error" | "success"; message: string } | null>(null);

  const canInvestigate = eventStatus === "INVESTIGATING";
  const confirmed = rootCause?.status === "CONFIRMED";
  const showFiveWhys = method === "FIVE_WHYS" || method === "COMBINED";
  const showIshikawa = method === "ISHIKAWA" || method === "COMBINED";

  const populatedFiveWhys = useMemo(
    () =>
      fiveWhys
        .filter((step) => step.answer.trim())
        .map((step, index) => ({
          sequence: index + 1,
          prompt: step.prompt.trim() || "Why?",
          answer: step.answer.trim(),
        })),
    [fiveWhys],
  );

  async function patch(payload: Record<string, unknown>) {
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch(`/api/quality/events/${eventId}/root-cause`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId, siteId, ...payload }),
      });
      const body = (await response.json()) as {
        data?: RootCauseSnapshot;
        error?: { code?: string; message?: string };
      };
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? "Root-cause update failed");
      }
      setRootCause(body.data);
      setFeedback({ kind: "success", message: "Root-cause workspace updated." });
      router.refresh();
    } catch (error) {
      setFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : "Root-cause update failed",
      });
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    await patch({
      action: "SAVE",
      method,
      problemStatement,
      fiveWhys: showFiveWhys ? populatedFiveWhys : [],
      ishikawa: showIshikawa
        ? ishikawa
            .filter((cause) => cause.cause.trim())
            .map(({ category, cause, evidence }) => ({
              category,
              cause: cause.trim(),
              evidence: evidence?.trim() || null,
            }))
        : [],
      rootCauseSummary: rootCauseSummary.trim() || null,
    });
  }

  function updateFiveWhy(index: number, field: "prompt" | "answer", value: string) {
    setFiveWhys((current) =>
      current.map((step, stepIndex) =>
        stepIndex === index ? { ...step, [field]: value } : step,
      ),
    );
  }

  function addIshikawaCause() {
    setIshikawa((current) => [
      ...current,
      {
        key: `${Date.now()}-${current.length}`,
        category: "PEOPLE",
        cause: "",
        evidence: null,
      },
    ]);
  }

  function updateCause(
    key: string,
    field: "category" | "cause" | "evidence",
    value: string,
  ) {
    setIshikawa((current) =>
      current.map((item) =>
        item.key === key
          ? {
              ...item,
              [field]: field === "category" ? (value as IshikawaCategory) : value,
            }
          : item,
      ),
    );
  }

  const inputStyle = {
    width: "100%",
    padding: "10px 12px",
    border: "1px solid #d1d5db",
    borderRadius: 8,
    background: confirmed ? "#f9fafb" : "white",
  } as const;
  const buttonStyle = {
    border: "1px solid #d1d5db",
    borderRadius: 8,
    padding: "9px 14px",
    background: "white",
    cursor: "pointer",
  } as const;

  return (
    <div className="grid" style={{ gap: 18 }}>
      {!canInvestigate ? (
        <div className="card">
          <strong>Investigation required</strong>
          <p className="muted" style={{ marginBottom: 0 }}>
            Start the quality-event investigation before editing root-cause analysis. Closed events
            must be reopened first.
          </p>
        </div>
      ) : null}

      <section className="card">
        <div className="header" style={{ marginBottom: 16 }}>
          <div>
            <h2 style={{ margin: 0 }}>Analysis setup</h2>
            <div className="muted">Status: {rootCause?.status ?? "Not started"}</div>
          </div>
          <select
            aria-label="Root cause method"
            value={method}
            onChange={(event) => setMethod(event.target.value as RootCauseMethod)}
            disabled={!canInvestigate || confirmed || busy}
            style={{ ...inputStyle, width: "auto" }}
          >
            <option value="FIVE_WHYS">5 Why</option>
            <option value="ISHIKAWA">Ishikawa</option>
            <option value="COMBINED">Combined</option>
          </select>
        </div>
        <label>
          <strong>Problem statement</strong>
          <textarea
            value={problemStatement}
            onChange={(event) => setProblemStatement(event.target.value)}
            disabled={!canInvestigate || confirmed || busy}
            rows={4}
            style={{ ...inputStyle, marginTop: 8, resize: "vertical" }}
            placeholder="Describe the problem precisely: what happened, where, when and what was affected."
          />
        </label>
      </section>

      {showFiveWhys ? (
        <section className="card">
          <h2>5 Why</h2>
          <div className="grid" style={{ gap: 12 }}>
            {fiveWhys.map((step, index) => (
              <div key={index} className="grid grid-2" style={{ alignItems: "start" }}>
                <label>
                  <strong>Why {index + 1}</strong>
                  <input
                    value={step.prompt}
                    onChange={(event) => updateFiveWhy(index, "prompt", event.target.value)}
                    disabled={!canInvestigate || confirmed || busy}
                    style={{ ...inputStyle, marginTop: 6 }}
                  />
                </label>
                <label>
                  <strong>Answer</strong>
                  <textarea
                    value={step.answer}
                    onChange={(event) => updateFiveWhy(index, "answer", event.target.value)}
                    disabled={!canInvestigate || confirmed || busy}
                    rows={2}
                    style={{ ...inputStyle, marginTop: 6, resize: "vertical" }}
                    placeholder={index === 0 ? "Explain the immediate reason." : "Go one causal level deeper."}
                  />
                </label>
              </div>
            ))}
          </div>
          <p className="muted" style={{ marginBottom: 0 }}>
            You do not have to force five levels. Save only the contiguous answers that add causal value.
          </p>
        </section>
      ) : null}

      {showIshikawa ? (
        <section className="card">
          <div className="header" style={{ marginBottom: 12 }}>
            <div>
              <h2 style={{ margin: 0 }}>Ishikawa causes</h2>
              <div className="muted">People · Method · Machine · Material · Measurement · Environment</div>
            </div>
            <button
              type="button"
              onClick={addIshikawaCause}
              disabled={!canInvestigate || confirmed || busy}
              style={buttonStyle}
            >
              Add cause
            </button>
          </div>
          {ishikawa.length ? (
            <div className="grid" style={{ gap: 10 }}>
              {ishikawa.map((item) => (
                <div
                  key={item.key}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "170px minmax(220px, 1fr) minmax(220px, 1fr) auto",
                    gap: 10,
                    alignItems: "center",
                  }}
                >
                  <select
                    value={item.category}
                    onChange={(event) => updateCause(item.key, "category", event.target.value)}
                    disabled={!canInvestigate || confirmed || busy}
                    style={inputStyle}
                  >
                    {categories.map((category) => (
                      <option key={category} value={category}>{category}</option>
                    ))}
                  </select>
                  <input
                    value={item.cause}
                    onChange={(event) => updateCause(item.key, "cause", event.target.value)}
                    disabled={!canInvestigate || confirmed || busy}
                    style={inputStyle}
                    placeholder="Potential cause"
                  />
                  <input
                    value={item.evidence ?? ""}
                    onChange={(event) => updateCause(item.key, "evidence", event.target.value)}
                    disabled={!canInvestigate || confirmed || busy}
                    style={inputStyle}
                    placeholder="Evidence / observation (optional)"
                  />
                  <button
                    type="button"
                    onClick={() => setIshikawa((current) => current.filter((cause) => cause.key !== item.key))}
                    disabled={!canInvestigate || confirmed || busy}
                    style={buttonStyle}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">No Ishikawa causes recorded yet.</p>
          )}
        </section>
      ) : null}

      <section className="card">
        <label>
          <strong>Root-cause conclusion</strong>
          <textarea
            value={rootCauseSummary}
            onChange={(event) => setRootCauseSummary(event.target.value)}
            disabled={!canInvestigate || confirmed || busy}
            rows={4}
            style={{ ...inputStyle, marginTop: 8, resize: "vertical" }}
            placeholder="State the confirmed or most likely root cause and why the evidence supports it."
          />
        </label>

        {feedback ? (
          <p
            role="status"
            style={{
              marginBottom: 0,
              fontWeight: 600,
              color: feedback.kind === "error" ? "#991b1b" : "#166534",
            }}
          >
            {feedback.message}
          </p>
        ) : null}

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 16 }}>
          {!confirmed ? (
            <>
              <button
                type="button"
                onClick={save}
                disabled={!canInvestigate || busy}
                style={buttonStyle}
              >
                {busy ? "Saving…" : "Save draft"}
              </button>
              <button
                type="button"
                onClick={async () => {
                  await save();
                  if (!busy) await patch({ action: "CONFIRM" });
                }}
                disabled={!canInvestigate || busy || !rootCauseSummary.trim()}
                style={{ ...buttonStyle, background: "#111827", color: "white", borderColor: "#111827" }}
              >
                Confirm root cause
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => patch({ action: "REOPEN" })}
              disabled={!canInvestigate || busy}
              style={buttonStyle}
            >
              Reopen analysis
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
