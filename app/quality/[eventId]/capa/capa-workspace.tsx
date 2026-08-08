"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type {
  CapaActionStatus,
  CapaActionType,
  QualityCapaSnapshot,
} from "@/lib/quality/capa";

type MemberOption = { id: string; displayName: string };

type EditableAction = {
  id?: string;
  key: string;
  type: CapaActionType;
  title: string;
  description: string;
  ownerId: string;
  dueAt: string;
  status: CapaActionStatus;
  completionNote: string;
};

type Props = {
  organizationId: string;
  siteId: string;
  eventId: string;
  eventStatus: "OPEN" | "CONTAINED" | "INVESTIGATING" | "CLOSED";
  initialCapa: QualityCapaSnapshot | null;
  members: MemberOption[];
};

function localDateTime(iso: string | null | undefined) {
  if (!iso) return "";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function initialActions(capa: QualityCapaSnapshot | null): EditableAction[] {
  return (capa?.actions ?? []).map((action) => ({
    id: action.id,
    key: action.id,
    type: action.type,
    title: action.title,
    description: action.description ?? "",
    ownerId: action.ownerId,
    dueAt: localDateTime(action.dueAt),
    status: action.status,
    completionNote: action.completionNote ?? "",
  }));
}

export default function CapaWorkspace({
  organizationId,
  siteId,
  eventId,
  eventStatus,
  initialCapa,
  members,
}: Props) {
  const router = useRouter();
  const [capa, setCapa] = useState(initialCapa);
  const [actions, setActions] = useState<EditableAction[]>(() => initialActions(initialCapa));
  const [verificationMethod, setVerificationMethod] = useState(
    initialCapa?.verificationPlan.method ?? "",
  );
  const [acceptanceCriteria, setAcceptanceCriteria] = useState(
    initialCapa?.verificationPlan.acceptanceCriteria ?? "",
  );
  const [verificationResult, setVerificationResult] = useState(
    initialCapa?.effectiveness?.result ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "error" | "success"; message: string } | null>(null);

  const canInvestigate = eventStatus === "INVESTIGATING";
  const editable = !capa || capa.status === "DRAFT" || capa.status === "ACTIVE";
  const planEditable = canInvestigate && editable && capa?.status !== "VERIFYING";

  const inputStyle = {
    width: "100%",
    padding: "10px 12px",
    border: "1px solid #d1d5db",
    borderRadius: 8,
    background: planEditable ? "white" : "#f9fafb",
  } as const;
  const buttonStyle = {
    border: "1px solid #d1d5db",
    borderRadius: 8,
    padding: "9px 14px",
    background: "white",
    cursor: "pointer",
  } as const;

  async function request(method: "PUT" | "PATCH", payload: Record<string, unknown>) {
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch(`/api/quality/events/${eventId}/capa`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId, siteId, ...payload }),
      });
      const body = (await response.json()) as {
        data?: QualityCapaSnapshot;
        error?: { message?: string };
      };
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? "CAPA update failed");
      }
      setCapa(body.data);
      setActions(initialActions(body.data));
      setVerificationMethod(body.data.verificationPlan.method);
      setAcceptanceCriteria(body.data.verificationPlan.acceptanceCriteria);
      setVerificationResult(body.data.effectiveness?.result ?? "");
      setFeedback({ kind: "success", message: "CAPA updated." });
      router.refresh();
      return body.data;
    } catch (error) {
      setFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : "CAPA update failed",
      });
      return null;
    } finally {
      setBusy(false);
    }
  }

  function addAction(type: CapaActionType) {
    setActions((current) => [
      ...current,
      {
        key: `${Date.now()}-${current.length}`,
        type,
        title: "",
        description: "",
        ownerId: members[0]?.id ?? "",
        dueAt: "",
        status: "OPEN",
        completionNote: "",
      },
    ]);
  }

  function updateAction(key: string, patch: Partial<EditableAction>) {
    setActions((current) =>
      current.map((action) => (action.key === key ? { ...action, ...patch } : action)),
    );
  }

  function removeAction(key: string) {
    setActions((current) => current.filter((action) => action.key !== key));
  }

  async function savePlan() {
    return request("PUT", {
      actions: actions.map((action) => ({
        ...(action.id ? { id: action.id } : {}),
        type: action.type,
        title: action.title,
        description: action.description.trim() || null,
        ownerId: action.ownerId,
        dueAt: action.dueAt ? new Date(action.dueAt).toISOString() : "",
      })),
      verificationPlan: {
        method: verificationMethod,
        acceptanceCriteria,
      },
    });
  }

  async function activate() {
    const saved = await savePlan();
    if (!saved) return;
    await request("PATCH", { action: "ACTIVATE" });
  }

  async function setStatus(actionId: string, status: CapaActionStatus, completionNote?: string) {
    await request("PATCH", {
      action: "SET_ACTION_STATUS",
      actionId,
      status,
      completionNote: completionNote?.trim() || null,
    });
  }

  async function startVerification() {
    await request("PATCH", { action: "START_VERIFICATION" });
  }

  async function verify(effective: boolean) {
    await request("PATCH", {
      action: "VERIFY_EFFECTIVENESS",
      effective,
      result: verificationResult,
    });
  }

  async function reopen() {
    await request("PATCH", { action: "REOPEN" });
  }

  return (
    <div className="grid" style={{ gap: 18 }}>
      {!canInvestigate ? (
        <section className="card">
          <strong>Investigation required</strong>
          <p className="muted" style={{ marginBottom: 0 }}>
            CAPA can be managed only while the quality event is in investigation.
          </p>
        </section>
      ) : null}

      <section className="card">
        <div className="header asset-header" style={{ marginBottom: 12 }}>
          <div>
            <h2 style={{ margin: 0 }}>CAPA plan</h2>
            <div className="muted">Status: {capa?.status ?? "Not started"}</div>
          </div>
          <div className="asset-status">
            {capa?.rootCauseSummary ? <span className="badge">RCA linked</span> : null}
            <span className="badge">{actions.length} actions</span>
          </div>
        </div>
        {capa?.rootCauseSummary ? (
          <p><strong>Confirmed root cause:</strong> {capa.rootCauseSummary}</p>
        ) : (
          <p className="muted">Confirm the root-cause workspace before CAPA activation.</p>
        )}
      </section>

      <section className="card">
        <div className="header asset-header" style={{ marginBottom: 12 }}>
          <div>
            <h2 style={{ margin: 0 }}>Corrective & preventive actions</h2>
            <div className="muted">Assign accountable owners and due dates before activation.</div>
          </div>
          {planEditable ? (
            <div className="asset-status">
              <button type="button" style={buttonStyle} disabled={busy} onClick={() => addAction("CORRECTIVE")}>
                + Corrective
              </button>
              <button type="button" style={buttonStyle} disabled={busy} onClick={() => addAction("PREVENTIVE")}>
                + Preventive
              </button>
            </div>
          ) : null}
        </div>

        {actions.length ? (
          <div className="grid" style={{ gap: 14 }}>
            {actions.map((action) => (
              <div className="card" key={action.key}>
                <div className="grid grid-2" style={{ gap: 12 }}>
                  <label>
                    <strong>Type</strong>
                    <select
                      value={action.type}
                      onChange={(event) => updateAction(action.key, { type: event.target.value as CapaActionType })}
                      disabled={!planEditable || busy || action.status === "COMPLETED"}
                      style={{ ...inputStyle, marginTop: 6 }}
                    >
                      <option value="CORRECTIVE">Corrective</option>
                      <option value="PREVENTIVE">Preventive</option>
                    </select>
                  </label>
                  <label>
                    <strong>Owner</strong>
                    <select
                      value={action.ownerId}
                      onChange={(event) => updateAction(action.key, { ownerId: event.target.value })}
                      disabled={!planEditable || busy || action.status === "COMPLETED"}
                      style={{ ...inputStyle, marginTop: 6 }}
                    >
                      <option value="">Select owner</option>
                      {members.map((member) => (
                        <option key={member.id} value={member.id}>{member.displayName}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <label style={{ display: "block", marginTop: 12 }}>
                  <strong>Action</strong>
                  <input
                    value={action.title}
                    onChange={(event) => updateAction(action.key, { title: event.target.value })}
                    disabled={!planEditable || busy || action.status === "COMPLETED"}
                    style={{ ...inputStyle, marginTop: 6 }}
                    placeholder="Define the specific action and expected change."
                  />
                </label>
                <label style={{ display: "block", marginTop: 12 }}>
                  <strong>Description</strong>
                  <textarea
                    value={action.description}
                    onChange={(event) => updateAction(action.key, { description: event.target.value })}
                    disabled={!planEditable || busy || action.status === "COMPLETED"}
                    rows={2}
                    style={{ ...inputStyle, marginTop: 6, resize: "vertical" }}
                  />
                </label>
                <div className="grid grid-2" style={{ gap: 12, marginTop: 12 }}>
                  <label>
                    <strong>Due date</strong>
                    <input
                      type="datetime-local"
                      value={action.dueAt}
                      onChange={(event) => updateAction(action.key, { dueAt: event.target.value })}
                      disabled={!planEditable || busy || action.status === "COMPLETED"}
                      style={{ ...inputStyle, marginTop: 6 }}
                    />
                  </label>
                  <div>
                    <strong>Status</strong>
                    <div className="asset-status" style={{ marginTop: 8 }}>
                      <span className="badge">{action.status}</span>
                      {capa?.status === "ACTIVE" && action.id ? (
                        <>
                          {action.status !== "IN_PROGRESS" ? (
                            <button type="button" style={buttonStyle} disabled={busy} onClick={() => setStatus(action.id!, "IN_PROGRESS")}>
                              In progress
                            </button>
                          ) : null}
                          {action.status !== "COMPLETED" ? (
                            <button type="button" style={buttonStyle} disabled={busy} onClick={() => setStatus(action.id!, "COMPLETED", action.completionNote)}>
                              Complete
                            </button>
                          ) : null}
                        </>
                      ) : null}
                    </div>
                  </div>
                </div>
                {capa?.status === "ACTIVE" && action.status !== "OPEN" ? (
                  <label style={{ display: "block", marginTop: 12 }}>
                    <strong>Completion note</strong>
                    <textarea
                      value={action.completionNote}
                      onChange={(event) => updateAction(action.key, { completionNote: event.target.value })}
                      disabled={busy || action.status === "COMPLETED"}
                      rows={2}
                      style={{ ...inputStyle, marginTop: 6, resize: "vertical" }}
                      placeholder="Record implementation evidence or the completion result."
                    />
                  </label>
                ) : null}
                {planEditable && !action.id ? (
                  <button type="button" style={{ ...buttonStyle, marginTop: 12 }} disabled={busy} onClick={() => removeAction(action.key)}>
                    Remove draft action
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">No CAPA actions defined yet.</p>
        )}
      </section>

      <section className="card">
        <h2>Effectiveness verification plan</h2>
        <div className="grid grid-2" style={{ gap: 12 }}>
          <label>
            <strong>Verification method</strong>
            <textarea
              value={verificationMethod}
              onChange={(event) => setVerificationMethod(event.target.value)}
              disabled={!planEditable || busy}
              rows={3}
              style={{ ...inputStyle, marginTop: 6, resize: "vertical" }}
              placeholder="How will effectiveness be checked?"
            />
          </label>
          <label>
            <strong>Acceptance criteria</strong>
            <textarea
              value={acceptanceCriteria}
              onChange={(event) => setAcceptanceCriteria(event.target.value)}
              disabled={!planEditable || busy}
              rows={3}
              style={{ ...inputStyle, marginTop: 6, resize: "vertical" }}
              placeholder="Define the measurable criteria for an effective CAPA."
            />
          </label>
        </div>
      </section>

      {canInvestigate ? (
        <section className="card">
          <div className="asset-status">
            {(!capa || capa.status === "DRAFT" || capa.status === "ACTIVE") ? (
              <button type="button" style={buttonStyle} disabled={busy} onClick={savePlan}>Save plan</button>
            ) : null}
            {capa?.status === "DRAFT" ? (
              <button type="button" style={buttonStyle} disabled={busy} onClick={activate}>Activate CAPA</button>
            ) : null}
            {capa?.status === "ACTIVE" ? (
              <button type="button" style={buttonStyle} disabled={busy} onClick={startVerification}>
                Start effectiveness verification
              </button>
            ) : null}
            {capa?.status === "INEFFECTIVE" ? (
              <button type="button" style={buttonStyle} disabled={busy} onClick={reopen}>Reopen CAPA</button>
            ) : null}
          </div>
          {feedback ? (
            <p role="status" style={{ marginBottom: 0 }}>
              {feedback.kind === "error" ? "Error: " : ""}{feedback.message}
            </p>
          ) : null}
        </section>
      ) : null}

      {capa?.status === "VERIFYING" ? (
        <section className="card">
          <h2>Effectiveness verification</h2>
          <p className="muted">Compare the observed result with the acceptance criteria before deciding.</p>
          <label>
            <strong>Verification result</strong>
            <textarea
              value={verificationResult}
              onChange={(event) => setVerificationResult(event.target.value)}
              disabled={busy}
              rows={4}
              style={{ ...inputStyle, background: "white", marginTop: 6, resize: "vertical" }}
            />
          </label>
          <div className="asset-status" style={{ marginTop: 12 }}>
            <button type="button" style={buttonStyle} disabled={busy || !verificationResult.trim()} onClick={() => verify(true)}>
              Mark effective
            </button>
            <button type="button" style={buttonStyle} disabled={busy || !verificationResult.trim()} onClick={() => verify(false)}>
              Mark ineffective
            </button>
          </div>
        </section>
      ) : null}

      {capa?.effectiveness ? (
        <section className="card">
          <h2>Effectiveness result</h2>
          <p><strong>{capa.effectiveness.effective ? "Effective" : "Ineffective"}</strong> · {capa.effectiveness.result}</p>
          <p className="muted" style={{ marginBottom: 0 }}>
            Verified by {capa.effectiveness.verifiedByName} at {new Date(capa.effectiveness.verifiedAt).toLocaleString()}.
          </p>
        </section>
      ) : null}
    </div>
  );
}
