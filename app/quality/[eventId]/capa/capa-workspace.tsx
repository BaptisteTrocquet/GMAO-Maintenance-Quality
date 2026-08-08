"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { CapaActionType, CapaSnapshot } from "@/lib/quality/capa";

type MemberOption = { id: string; name: string; role: string };

type Props = {
  organizationId: string;
  siteId: string;
  eventId: string;
  eventStatus: "OPEN" | "CONTAINED" | "INVESTIGATING" | "CLOSED";
  rootCauseStatus: "DRAFT" | "CONFIRMED" | null;
  initialCapa: CapaSnapshot | null;
  members: MemberOption[];
};

type EditableAction = {
  key: string;
  id?: string;
  type: CapaActionType;
  title: string;
  description: string;
  ownerId: string;
  dueAt: string;
};

function toLocalInput(value: string) {
  const date = new Date(value);
  const offsetMilliseconds = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMilliseconds).toISOString().slice(0, 16);
}

function editableActions(capa: CapaSnapshot | null): EditableAction[] {
  return (capa?.actions ?? []).map((action) => ({
    key: action.id,
    id: action.id,
    type: action.type,
    title: action.title,
    description: action.description ?? "",
    ownerId: action.ownerId,
    dueAt: toLocalInput(action.dueAt),
  }));
}

export default function CapaWorkspace({
  organizationId,
  siteId,
  eventId,
  eventStatus,
  rootCauseStatus,
  initialCapa,
  members,
}: Props) {
  const router = useRouter();
  const [capa, setCapa] = useState(initialCapa);
  const [planSummary, setPlanSummary] = useState(initialCapa?.planSummary ?? "");
  const [actions, setActions] = useState<EditableAction[]>(() => editableActions(initialCapa));
  const [completionNotes, setCompletionNotes] = useState<Record<string, string>>({});
  const [effectivenessNote, setEffectivenessNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "error" | "success"; message: string } | null>(null);

  const canWork = eventStatus === "INVESTIGATING" && rootCauseStatus === "CONFIRMED";
  const editable = canWork && (!capa || capa.status === "DRAFT");
  const allCompleted = Boolean(capa?.actions.length) && capa!.actions.every((action) => action.status === "COMPLETED");

  const memberNames = useMemo(
    () => new Map(members.map((member) => [member.id, member.name])),
    [members],
  );

  async function patch(payload: Record<string, unknown>) {
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch(`/api/quality/events/${eventId}/capa`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId, siteId, ...payload }),
      });
      const body = (await response.json()) as {
        data?: CapaSnapshot;
        error?: { message?: string };
      };
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? "CAPA update failed");
      }
      setCapa(body.data);
      setPlanSummary(body.data.planSummary);
      setActions(editableActions(body.data));
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

  function addAction() {
    const defaultOwner = members[0]?.id ?? "";
    setActions((current) => [
      ...current,
      {
        key: crypto.randomUUID(),
        type: "CORRECTIVE",
        title: "",
        description: "",
        ownerId: defaultOwner,
        dueAt: "",
      },
    ]);
  }

  function updateAction(key: string, field: keyof EditableAction, value: string) {
    setActions((current) =>
      current.map((action) =>
        action.key === key
          ? {
              ...action,
              [field]: field === "type" ? (value as CapaActionType) : value,
            }
          : action,
      ),
    );
  }

  function removeAction(key: string) {
    setActions((current) => current.filter((action) => action.key !== key));
  }

  async function saveDraft() {
    return patch({
      action: "SAVE",
      planSummary,
      actions: actions.map((item) => ({
        ...(item.id ? { id: item.id } : {}),
        type: item.type,
        title: item.title,
        description: item.description.trim() || null,
        ownerId: item.ownerId,
        dueAt: item.dueAt ? new Date(item.dueAt).toISOString() : "",
      })),
    });
  }

  async function completeAction(actionId: string) {
    const note = completionNotes[actionId]?.trim() ?? "";
    const updated = await patch({ action: "COMPLETE_ACTION", actionId, completionNote: note });
    if (updated) {
      setCompletionNotes((current) => ({ ...current, [actionId]: "" }));
    }
  }

  async function verify(result: "EFFECTIVE" | "INEFFECTIVE") {
    const updated = await patch({
      action: "VERIFY_EFFECTIVENESS",
      result,
      note: effectivenessNote,
    });
    if (updated) setEffectivenessNote("");
  }

  const inputStyle = {
    width: "100%",
    padding: "10px 12px",
    border: "1px solid #d1d5db",
    borderRadius: 8,
    background: editable ? "white" : "#f9fafb",
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
      {!canWork ? (
        <section className="card">
          <strong>CAPA prerequisites not met</strong>
          <p className="muted" style={{ marginBottom: 0 }}>
            The quality event must be investigating and its root-cause analysis must be confirmed before CAPA can be changed.
          </p>
        </section>
      ) : null}

      <section className="card">
        <div className="header asset-header" style={{ marginBottom: 16 }}>
          <div>
            <h2 style={{ margin: 0 }}>CAPA plan</h2>
            <div className="muted">Status: {capa?.status ?? "NOT STARTED"}</div>
          </div>
          <div className="asset-status">
            {capa?.approvedAt ? <span className="badge">APPROVED</span> : null}
            {capa?.closedAt ? <span className="badge">EFFECTIVE</span> : null}
          </div>
        </div>
        <label>
          <strong>Plan summary</strong>
          <textarea
            value={planSummary}
            onChange={(event) => setPlanSummary(event.target.value)}
            disabled={!editable || busy}
            rows={4}
            style={{ ...inputStyle, marginTop: 8, resize: "vertical" }}
            placeholder="Explain how the plan addresses the confirmed root cause and prevents recurrence."
          />
        </label>
      </section>

      <section className="card">
        <div className="header asset-header" style={{ marginBottom: 12 }}>
          <div>
            <h2 style={{ margin: 0 }}>Corrective & preventive actions</h2>
            <div className="muted">Every action requires an accountable owner and due date.</div>
          </div>
          {editable ? (
            <button type="button" onClick={addAction} disabled={busy} style={buttonStyle}>+ Add action</button>
          ) : null}
        </div>

        {actions.length === 0 ? <p className="muted">No CAPA actions recorded yet.</p> : null}
        <div className="grid" style={{ gap: 14 }}>
          {actions.map((action) => {
            const stored = capa?.actions.find((item) => item.id === action.id);
            return (
              <div className="card" key={action.key}>
                <div className="grid grid-2" style={{ gap: 12 }}>
                  <label>
                    <strong>Type</strong>
                    <select
                      value={action.type}
                      onChange={(event) => updateAction(action.key, "type", event.target.value)}
                      disabled={!editable || busy}
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
                      onChange={(event) => updateAction(action.key, "ownerId", event.target.value)}
                      disabled={!editable || busy}
                      style={{ ...inputStyle, marginTop: 6 }}
                    >
                      <option value="">Select owner</option>
                      {members.map((member) => (
                        <option key={member.id} value={member.id}>{member.name} · {member.role}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <strong>Action</strong>
                    <input
                      value={action.title}
                      onChange={(event) => updateAction(action.key, "title", event.target.value)}
                      disabled={!editable || busy}
                      style={{ ...inputStyle, marginTop: 6 }}
                    />
                  </label>
                  <label>
                    <strong>Due date</strong>
                    <input
                      type="datetime-local"
                      value={action.dueAt}
                      onChange={(event) => updateAction(action.key, "dueAt", event.target.value)}
                      disabled={!editable || busy}
                      style={{ ...inputStyle, marginTop: 6 }}
                    />
                  </label>
                </div>
                <label style={{ display: "block", marginTop: 12 }}>
                  <strong>Description</strong>
                  <textarea
                    value={action.description}
                    onChange={(event) => updateAction(action.key, "description", event.target.value)}
                    disabled={!editable || busy}
                    rows={2}
                    style={{ ...inputStyle, marginTop: 6, resize: "vertical" }}
                  />
                </label>

                {stored ? (
                  <div style={{ marginTop: 12 }}>
                    <span className="badge">{stored.status}</span>
                    <span className="muted" style={{ marginLeft: 8 }}>
                      {memberNames.get(stored.ownerId) ?? stored.ownerId} · due {stored.dueAt.slice(0, 16).replace("T", " ")} UTC
                    </span>
                    {stored.completionNote ? <p>{stored.completionNote}</p> : null}
                  </div>
                ) : null}

                {capa?.status === "ACTIVE" && stored?.status === "OPEN" ? (
                  <div className="grid grid-2" style={{ gap: 12, marginTop: 12 }}>
                    <input
                      aria-label={`Completion note for ${stored.title}`}
                      value={completionNotes[stored.id] ?? ""}
                      onChange={(event) =>
                        setCompletionNotes((current) => ({ ...current, [stored.id]: event.target.value }))
                      }
                      placeholder="Completion evidence / result"
                      disabled={busy}
                      style={{ ...inputStyle, background: "white" }}
                    />
                    <button
                      type="button"
                      onClick={() => completeAction(stored.id)}
                      disabled={busy || !(completionNotes[stored.id]?.trim())}
                      style={buttonStyle}
                    >
                      Complete action
                    </button>
                  </div>
                ) : null}

                {editable ? (
                  <button
                    type="button"
                    onClick={() => removeAction(action.key)}
                    disabled={busy}
                    style={{ ...buttonStyle, marginTop: 12 }}
                  >
                    Remove
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>

      {capa?.effectivenessChecks.length ? (
        <section className="card">
          <h2>Effectiveness history</h2>
          <div className="stack-list">
            {capa.effectivenessChecks.map((check, index) => (
              <div key={`${check.verifiedAt}-${index}`}>
                <strong>{check.result}</strong>
                <span className="muted"> · {check.verifiedAt.slice(0, 16).replace("T", " ")} UTC · {check.note}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {capa?.status === "ACTIVE" && allCompleted ? (
        <section className="card">
          <h2>Effectiveness verification</h2>
          <p className="muted">All actions are complete. Record objective follow-up evidence before deciding effectiveness.</p>
          <textarea
            value={effectivenessNote}
            onChange={(event) => setEffectivenessNote(event.target.value)}
            disabled={busy}
            rows={3}
            style={{ ...inputStyle, background: "white", resize: "vertical" }}
            placeholder="Follow-up inspection, trend, audit evidence, recurrence check..."
          />
          <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
            <button type="button" onClick={() => verify("EFFECTIVE")} disabled={busy || !effectivenessNote.trim()} style={buttonStyle}>
              Confirm effective
            </button>
            <button type="button" onClick={() => verify("INEFFECTIVE")} disabled={busy || !effectivenessNote.trim()} style={buttonStyle}>
              Mark ineffective & revise
            </button>
          </div>
        </section>
      ) : null}

      <section className="card">
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {editable ? (
            <button type="button" onClick={saveDraft} disabled={busy || !planSummary.trim()} style={buttonStyle}>
              Save draft
            </button>
          ) : null}
          {capa?.status === "DRAFT" && canWork ? (
            <button type="button" onClick={() => patch({ action: "APPROVE" })} disabled={busy || capa.actions.length === 0} style={buttonStyle}>
              Approve CAPA plan
            </button>
          ) : null}
          {capa?.status === "CLOSED" && canWork ? (
            <button type="button" onClick={() => patch({ action: "REOPEN" })} disabled={busy} style={buttonStyle}>
              Reopen CAPA
            </button>
          ) : null}
        </div>
        {feedback ? (
          <p role="status" style={{ marginBottom: 0 }}>{feedback.kind === "error" ? "Error: " : ""}{feedback.message}</p>
        ) : null}
      </section>
    </div>
  );
}
