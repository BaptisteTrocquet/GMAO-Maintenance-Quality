"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { CapaEffectivenessSnapshot, EffectivenessResult } from "@/lib/quality/effectiveness";

type MemberOption = { id: string; displayName: string };

type Props = {
  organizationId: string;
  siteId: string;
  eventId: string;
  capaStatus: "DRAFT" | "ACTIVE" | "READY_FOR_EFFECTIVENESS" | null;
  initialEffectiveness: CapaEffectivenessSnapshot | null;
  members: MemberOption[];
};

function dateInput(value: string | null | undefined) {
  return value ? value.slice(0, 10) : "";
}

export default function EffectivenessWorkspace({
  organizationId,
  siteId,
  eventId,
  capaStatus,
  initialEffectiveness,
  members,
}: Props) {
  const router = useRouter();
  const [effectiveness, setEffectiveness] = useState(initialEffectiveness);
  const [criteria, setCriteria] = useState(initialEffectiveness?.criteria ?? "");
  const [verifierId, setVerifierId] = useState(initialEffectiveness?.verifierId ?? "");
  const [dueDate, setDueDate] = useState(dateInput(initialEffectiveness?.dueAt));
  const [result, setResult] = useState<EffectivenessResult>("EFFECTIVE");
  const [summary, setSummary] = useState(initialEffectiveness?.summary ?? "");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; message: string } | null>(null);

  const canStart = capaStatus === "READY_FOR_EFFECTIVENESS" && effectiveness?.status !== "PENDING";
  const pending = effectiveness?.status === "PENDING";

  async function patch(payload: Record<string, unknown>) {
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch(`/api/quality/events/${eventId}/capa/effectiveness`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId, siteId, ...payload }),
      });
      const body = (await response.json()) as {
        data?: CapaEffectivenessSnapshot;
        error?: { message?: string };
      };
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? "Effectiveness update failed");
      }
      setEffectiveness(body.data);
      setFeedback({ kind: "success", message: "Effectiveness workflow updated." });
      router.refresh();
      return body.data;
    } catch (error) {
      setFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : "Effectiveness update failed",
      });
      return null;
    } finally {
      setBusy(false);
    }
  }

  const controlStyle = {
    width: "100%",
    padding: "9px 11px",
    border: "1px solid #d1d5db",
    borderRadius: 8,
    background: "white",
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
      <section className="card">
        <div className="header asset-header" style={{ marginBottom: 14 }}>
          <div>
            <h2 style={{ margin: 0 }}>Verification plan</h2>
            <div className="muted">
              CAPA status: {capaStatus ?? "NOT STARTED"} · Review: {effectiveness?.status ?? "NOT STARTED"}
            </div>
          </div>
          {effectiveness?.result ? <span className="badge">{effectiveness.result}</span> : null}
        </div>

        {effectiveness?.status === "VERIFIED" ? (
          <div className="stack-list">
            <div><strong>Criteria</strong><div>{effectiveness.criteria}</div></div>
            <div><strong>Verifier</strong><div>{effectiveness.verifierName}</div></div>
            <div><strong>Due</strong><div>{dateInput(effectiveness.dueAt)}</div></div>
            <div><strong>Result</strong><div>{effectiveness.result}</div></div>
            <div><strong>Verification summary</strong><div>{effectiveness.summary}</div></div>
            {effectiveness.result === "INEFFECTIVE" ? (
              <p className="muted" style={{ marginBottom: 0 }}>
                The CAPA plan was reopened as a new draft. New corrective/preventive actions are required before reactivation.
              </p>
            ) : (
              <p className="muted" style={{ marginBottom: 0 }}>
                Effectiveness has been positively verified and the CAPA loop is complete.
              </p>
            )}
          </div>
        ) : (
          <div className="grid grid-2">
            <label style={{ gridColumn: "1 / -1" }}>
              <strong>Effectiveness criteria</strong>
              <textarea
                value={criteria}
                onChange={(event) => setCriteria(event.target.value)}
                disabled={!canStart || busy}
                rows={3}
                style={{ ...controlStyle, marginTop: 6, resize: "vertical" }}
                placeholder="Define the measurable evidence that will demonstrate sustained effectiveness."
              />
            </label>
            <label>
              <strong>Verifier</strong>
              <select
                value={verifierId}
                onChange={(event) => setVerifierId(event.target.value)}
                disabled={!canStart || busy}
                style={{ ...controlStyle, marginTop: 6 }}
              >
                <option value="">Select verifier</option>
                {members.map((member) => (
                  <option key={member.id} value={member.id}>{member.displayName}</option>
                ))}
              </select>
            </label>
            <label>
              <strong>Verification due date</strong>
              <input
                type="date"
                value={dueDate}
                onChange={(event) => setDueDate(event.target.value)}
                disabled={!canStart || busy}
                style={{ ...controlStyle, marginTop: 6 }}
              />
            </label>
            {canStart ? (
              <div style={{ gridColumn: "1 / -1" }}>
                <button
                  type="button"
                  onClick={() => patch({
                    action: "START",
                    criteria,
                    verifierId,
                    dueAt: dueDate ? `${dueDate}T23:59:59.000Z` : "",
                  })}
                  disabled={busy || !criteria.trim() || !verifierId || !dueDate}
                  style={{ ...buttonStyle, background: "#111827", color: "white", borderColor: "#111827" }}
                >
                  Start effectiveness review
                </button>
              </div>
            ) : null}
          </div>
        )}
      </section>

      {pending ? (
        <section className="card">
          <h2>Record verification result</h2>
          <p className="muted">
            Assigned verifier: {effectiveness.verifierName} · due {dateInput(effectiveness.dueAt)}
          </p>
          <div className="grid grid-2">
            <label>
              <strong>Result</strong>
              <select
                value={result}
                onChange={(event) => setResult(event.target.value as EffectivenessResult)}
                disabled={busy}
                style={{ ...controlStyle, marginTop: 6 }}
              >
                <option value="EFFECTIVE">Effective</option>
                <option value="INEFFECTIVE">Ineffective</option>
              </select>
            </label>
            <label style={{ gridColumn: "1 / -1" }}>
              <strong>Verification summary</strong>
              <textarea
                value={summary}
                onChange={(event) => setSummary(event.target.value)}
                disabled={busy}
                rows={4}
                style={{ ...controlStyle, marginTop: 6, resize: "vertical" }}
                placeholder="Record the evidence reviewed and the conclusion."
              />
            </label>
          </div>
          <button
            type="button"
            onClick={() => patch({ action: "VERIFY", result, summary })}
            disabled={busy || !summary.trim()}
            style={{ ...buttonStyle, marginTop: 14, background: "#111827", color: "white", borderColor: "#111827" }}
          >
            Record verification
          </button>
        </section>
      ) : null}

      {capaStatus !== "READY_FOR_EFFECTIVENESS" && !effectiveness ? (
        <section className="card">
          <p className="muted" style={{ marginBottom: 0 }}>
            Complete or cancel all CAPA actions and move the plan to effectiveness readiness before starting verification.
          </p>
        </section>
      ) : null}

      {feedback ? (
        <p role="status" style={{ fontWeight: 600, color: feedback.kind === "error" ? "#991b1b" : "#166534" }}>
          {feedback.message}
        </p>
      ) : null}
    </div>
  );
}
