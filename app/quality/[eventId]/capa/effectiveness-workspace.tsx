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
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; message: string } | null>(null);

  const canStart = capaStatus === "READY_FOR_EFFECTIVENESS" && effectiveness?.status !== "PENDING";
  const pending = effectiveness?.status === "PENDING";
  const verified = effectiveness?.status === "VERIFIED";

  const controlStyle = {
    width: "100%",
    padding: "9px 11px",
    border: "1px solid #d1d5db",
    borderRadius: 8,
    background: verified ? "#f9fafb" : "white",
  } as const;
  const buttonStyle = {
    border: "1px solid #d1d5db",
    borderRadius: 8,
    padding: "9px 14px",
    background: "white",
    cursor: "pointer",
  } as const;

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
      setCriteria(body.data.criteria);
      setVerifierId(body.data.verifierId);
      setDueDate(dateInput(body.data.dueAt));
      setFeedback({ kind: "success", message: "Effectiveness verification updated." });
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

  return (
    <section className="card section">
      <div className="header asset-header" style={{ marginBottom: 14 }}>
        <div>
          <h2 style={{ margin: 0 }}>Effectiveness verification</h2>
          <div className="muted">
            Define objective criteria and assign a verifier after all CAPA actions are dispositioned.
          </div>
        </div>
        <span className="badge">{effectiveness?.status ?? "NOT STARTED"}</span>
      </div>

      {!effectiveness || (verified && effectiveness.result === "INEFFECTIVE" && capaStatus === "READY_FOR_EFFECTIVENESS") ? (
        <div className="grid grid-2">
          <label>
            <strong>Verification criteria</strong>
            <textarea
              value={criteria}
              onChange={(event) => setCriteria(event.target.value)}
              disabled={!canStart || busy}
              rows={3}
              style={{ ...controlStyle, marginTop: 6, resize: "vertical" }}
              placeholder="Example: no recurrence during a defined observation window and stable process measurements."
            />
          </label>
          <div className="grid" style={{ gap: 10 }}>
            <label>
              <strong>Assigned verifier</strong>
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
              <strong>Due date</strong>
              <input
                type="date"
                value={dueDate}
                onChange={(event) => setDueDate(event.target.value)}
                disabled={!canStart || busy}
                style={{ ...controlStyle, marginTop: 6 }}
              />
            </label>
          </div>
          <div>
            <button
              type="button"
              onClick={() => patch({
                action: "START",
                criteria,
                verifierId,
                dueAt: dueDate ? `${dueDate}T23:59:59.000Z` : "",
              })}
              disabled={!canStart || busy || !criteria.trim() || !verifierId || !dueDate}
              style={{ ...buttonStyle, background: "#111827", color: "white", borderColor: "#111827" }}
            >
              Start effectiveness review
            </button>
          </div>
        </div>
      ) : null}

      {pending && effectiveness ? (
        <div className="grid grid-2">
          <div>
            <dl className="detail-list">
              <div><dt>Criteria</dt><dd>{effectiveness.criteria}</dd></div>
              <div><dt>Verifier</dt><dd>{effectiveness.verifierName}</dd></div>
              <div><dt>Due</dt><dd>{dateInput(effectiveness.dueAt)}</dd></div>
            </dl>
            <p className="muted">
              Only the assigned verifier can record the result. The API enforces this separation.
            </p>
          </div>
          <div className="grid" style={{ gap: 10 }}>
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
            <label>
              <strong>Verification evidence / summary</strong>
              <textarea
                value={summary}
                onChange={(event) => setSummary(event.target.value)}
                disabled={busy}
                rows={4}
                style={{ ...controlStyle, marginTop: 6, resize: "vertical" }}
                placeholder="Record the observations, measurements or evidence supporting the result."
              />
            </label>
            <button
              type="button"
              onClick={() => patch({ action: "VERIFY", result, summary })}
              disabled={busy || !summary.trim()}
              style={{ ...buttonStyle, background: "#111827", color: "white", borderColor: "#111827" }}
            >
              Record verification result
            </button>
          </div>
        </div>
      ) : null}

      {verified && effectiveness ? (
        <div>
          <div className="asset-status" style={{ marginBottom: 12 }}>
            <span className="badge">{effectiveness.result}</span>
            <span className="badge">Verified {dateInput(effectiveness.verifiedAt)}</span>
          </div>
          <p><strong>Criteria:</strong> {effectiveness.criteria}</p>
          <p><strong>Result evidence:</strong> {effectiveness.summary}</p>
          {effectiveness.result === "INEFFECTIVE" ? (
            <p className="muted">
              The CAPA has been reopened as a draft. Define and approve a new action plan before another verification cycle.
            </p>
          ) : (
            <p className="muted">The CAPA has passed effectiveness verification.</p>
          )}
        </div>
      ) : null}

      {capaStatus !== "READY_FOR_EFFECTIVENESS" && !effectiveness ? (
        <p className="muted" style={{ marginBottom: 0 }}>
          Complete or cancel all CAPA actions, then move the plan to effectiveness verification.
        </p>
      ) : null}

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
    </section>
  );
}
