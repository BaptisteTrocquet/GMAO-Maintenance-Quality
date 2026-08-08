"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { RootCauseAnalysisSnapshot } from "@/lib/quality/root-cause";

export function RootCauseWorkspace({
  organizationId,
  siteId,
  eventId,
  initialAnalysis,
}: {
  organizationId: string;
  siteId: string;
  eventId: string;
  initialAnalysis: RootCauseAnalysisSnapshot | null;
}) {
  const router = useRouter();
  const [problemStatement, setProblemStatement] = useState(initialAnalysis?.problemStatement ?? "");
  const [rootCauseConclusion, setRootCauseConclusion] = useState(
    initialAnalysis?.rootCauseConclusion ?? "",
  );
  const [fiveWhys, setFiveWhys] = useState(() =>
    Array.from({ length: 5 }, (_, index) => initialAnalysis?.fiveWhys[index]?.answer ?? ""),
  );
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const completed = initialAnalysis?.status === "COMPLETED";

  function compactWhys() {
    const answers = fiveWhys.map((answer) => answer.trim());
    while (answers.length && !answers.at(-1)) answers.pop();
    if (answers.some((answer) => !answer)) {
      throw new Error("Fill Why answers in order without gaps.");
    }
    return answers;
  }

  async function parseResponse(response: Response) {
    const body = (await response.json()) as {
      error?: { message?: string };
    };
    if (!response.ok) throw new Error(body.error?.message ?? "Quality workflow request failed");
  }

  async function saveDraft() {
    if (!problemStatement.trim()) throw new Error("Problem statement is required.");
    const response = await fetch(`/api/quality/events/${eventId}/root-cause`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        organizationId,
        siteId,
        problemStatement,
        fiveWhys: compactWhys(),
        rootCauseConclusion: rootCauseConclusion.trim() || null,
      }),
    });
    await parseResponse(response);
  }

  async function run(action: "SAVE" | "COMPLETE" | "REOPEN") {
    setPending(true);
    setMessage(null);
    try {
      if (action === "SAVE") {
        await saveDraft();
        setMessage("Draft saved.");
      } else if (action === "COMPLETE") {
        await saveDraft();
        const response = await fetch(`/api/quality/events/${eventId}/root-cause`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ organizationId, siteId, action: "COMPLETE" }),
        });
        await parseResponse(response);
        setMessage("Root-cause analysis completed.");
      } else {
        const response = await fetch(`/api/quality/events/${eventId}/root-cause`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ organizationId, siteId, action: "REOPEN" }),
        });
        await parseResponse(response);
        setMessage("Root-cause analysis reopened.");
      }
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Quality workflow request failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="card quality-workspace">
      <div className="header">
        <div>
          <h2>Root-cause analysis · 5 Why</h2>
          <div className="muted">
            {initialAnalysis ? `${initialAnalysis.status} · version ${initialAnalysis.version}` : "New analysis"}
          </div>
        </div>
        {completed ? <span className="badge">COMPLETED</span> : <span className="badge">DRAFT</span>}
      </div>

      <label className="form-field">
        <span>Problem statement</span>
        <textarea
          value={problemStatement}
          onChange={(event) => setProblemStatement(event.target.value)}
          rows={4}
          disabled={completed || pending}
          placeholder="Describe the specific problem being investigated."
        />
      </label>

      <div className="quality-why-list">
        {fiveWhys.map((answer, index) => (
          <label className="form-field" key={index}>
            <span>Why {index + 1}</span>
            <textarea
              value={answer}
              onChange={(event) => {
                const next = [...fiveWhys];
                next[index] = event.target.value;
                setFiveWhys(next);
              }}
              rows={3}
              disabled={completed || pending}
              placeholder={index === 0 ? "Why did the problem occur?" : "Why did the previous cause occur?"}
            />
          </label>
        ))}
      </div>

      <label className="form-field">
        <span>Root-cause conclusion</span>
        <textarea
          value={rootCauseConclusion}
          onChange={(event) => setRootCauseConclusion(event.target.value)}
          rows={4}
          disabled={completed || pending}
          placeholder="State the verified root-cause conclusion."
        />
      </label>

      <div className="workflow-actions">
        {completed ? (
          <button type="button" onClick={() => void run("REOPEN")} disabled={pending}>
            Reopen analysis
          </button>
        ) : (
          <>
            <button type="button" onClick={() => void run("SAVE")} disabled={pending}>
              Save draft
            </button>
            <button type="button" onClick={() => void run("COMPLETE")} disabled={pending}>
              Complete 5 Why
            </button>
          </>
        )}
        {message ? <span className="muted" role="status">{message}</span> : null}
      </div>
    </section>
  );
}
