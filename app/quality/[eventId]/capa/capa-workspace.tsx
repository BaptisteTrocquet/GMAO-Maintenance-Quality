"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  CapaSnapshot,
  QualityActionSnapshot,
  QualityActionType,
} from "@/lib/quality/capa";

type MemberOption = { id: string; displayName: string };

type Props = {
  organizationId: string;
  siteId: string;
  eventId: string;
  eventStatus: "OPEN" | "CONTAINED" | "INVESTIGATING" | "CLOSED";
  initialCapa: CapaSnapshot | null;
  members: MemberOption[];
};

type DraftAction = {
  key: string;
  actionKey: string;
  type: QualityActionType;
  title: string;
  description: string;
  ownerId: string;
  dueDate: string;
};

function dateInput(value: string | null | undefined) {
  return value ? value.slice(0, 10) : "";
}

function initialDraftActions(capa: CapaSnapshot | null): DraftAction[] {
  if (!capa?.actions.length) return [];
  return capa.actions.map((action) => ({
    key: action.id,
    actionKey: action.actionKey,
    type: action.type,
    title: action.title,
    description: action.description ?? "",
    ownerId: action.ownerId,
    dueDate: dateInput(action.dueAt),
  }));
}

function blankAction(index: number): DraftAction {
  return {
    key: `draft-${Date.now()}-${index}`,
    actionKey: `action-${index + 1}`,
    type: "CORRECTIVE",
    title: "",
    description: "",
    ownerId: "",
    dueDate: "",
  };
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
  const [objective, setObjective] = useState(initialCapa?.objective ?? "");
  const [draftActions, setDraftActions] = useState<DraftAction[]>(() => initialDraftActions(initialCapa));
  const [completionNotes, setCompletionNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; message: string } | null>(null);

  const canInvestigate = eventStatus === "INVESTIGATING";
  const isDraft = !capa || capa.status === "DRAFT";
  const isActive = capa?.status === "ACTIVE";
  const readyForEffectiveness = capa?.status === "READY_FOR_EFFECTIVENESS";
  const allActionsDispositioned = useMemo(
    () =>
      Boolean(capa?.actions.length) &&
      (capa?.actions.every(
        (action) => action.status === "COMPLETED" || action.status === "CANCELLED",
      ) ?? false),
    [capa],
  );

  async function patch(payload: Record<string, unknown>): Promise<CapaSnapshot | null> {
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
      setFeedback({ kind: "success", message: "CAPA workspace updated." });
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

  async function saveDraft() {
    return patch({
      action: "SAVE",
      objective,
      actions: draftActions.map((action) => ({
        actionKey: action.actionKey,
        type: action.type,
        title: action.title,
        description: action.description.trim() || null,
        ownerId: action.ownerId,
        dueAt: action.dueDate ? `${action.dueDate}T23:59:59.000Z` : "",
      })),
    });
  }

  function updateDraftAction(key: string, field: keyof Omit<DraftAction, "key">, value: string) {
    setDraftActions((current) =>
      current.map((action) =>
        action.key === key
          ? {
              ...action,
              [field]: field === "type" ? (value as QualityActionType) : value,
            }
          : action,
      ),
    );
  }

  function memberName(ownerId: string) {
    return members.find((member) => member.id === ownerId)?.displayName ?? ownerId;
  }

  async function transitionAction(
    action: QualityActionSnapshot,
    transition: "START" | "COMPLETE" | "CANCEL",
  ) {
    await patch({
      action: "TRANSITION_ACTION",
      actionId: action.id,
      transition,
      completionNote: completionNotes[action.id]?.trim() || null,
    });
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
      {!canInvestigate ? (
        <section className="card">
          <strong>Investigation required</strong>
          <p className="muted" style={{ marginBottom: 0 }}>
            CAPA planning and execution are available while the quality event is investigating.
          </p>
        </section>
      ) : null}

      <section className="card">
        <div className="header asset-header" style={{ marginBottom: 14 }}>
          <div>
            <h2 style={{ margin: 0 }}>CAPA plan</h2>
            <div className="muted">Status: {capa?.status ?? "NOT STARTED"}</div>
          </div>
          {capa?.activatedAt ? <span className="badge">Activated {dateInput(capa.activatedAt)}</span> : null}
        </div>
        <label>
          <strong>Objective</strong>
          <textarea
            value={objective}
            onChange={(event) => setObjective(event.target.value)}
            disabled={!canInvestigate || !isDraft || busy}
            rows={3}
            style={{ ...controlStyle, marginTop: 7, resize: "vertical" }}
            placeholder="Describe what the CAPA plan must correct and prevent."
          />
        </label>
      </section>

      {isDraft ? (
        <section className="card">
          <div className="header" style={{ marginBottom: 14 }}>
            <div>
              <h2 style={{ margin: 0 }}>Corrective / preventive actions</h2>
              <div className="muted">Every action requires a responsible owner and due date.</div>
            </div>
            <button
              type="button"
              onClick={() => setDraftActions((current) => [...current, blankAction(current.length)])}
              disabled={!canInvestigate || busy}
              style={buttonStyle}
            >
              Add action
            </button>
          </div>

          {draftActions.length ? (
            <div className="grid" style={{ gap: 14 }}>
              {draftActions.map((action, index) => (
                <section className="card" key={action.key}>
                  <div className="header" style={{ marginBottom: 10 }}>
                    <strong>Action {index + 1}</strong>
                    <button
                      type="button"
                      onClick={() => setDraftActions((current) => current.filter((item) => item.key !== action.key))}
                      disabled={!canInvestigate || busy}
                      style={buttonStyle}
                    >
                      Remove
                    </button>
                  </div>
                  <div className="grid grid-2">
                    <label>
                      <strong>Type</strong>
                      <select
                        value={action.type}
                        onChange={(event) => updateDraftAction(action.key, "type", event.target.value)}
                        disabled={!canInvestigate || busy}
                        style={{ ...controlStyle, marginTop: 6 }}
                      >
                        <option value="CORRECTIVE">Corrective</option>
                        <option value="PREVENTIVE">Preventive</option>
                      </select>
                    </label>
                    <label>
                      <strong>Action key</strong>
                      <input
                        value={action.actionKey}
                        onChange={(event) => updateDraftAction(action.key, "actionKey", event.target.value)}
                        disabled={!canInvestigate || busy}
                        style={{ ...controlStyle, marginTop: 6 }}
                      />
                    </label>
                    <label>
                      <strong>Title</strong>
                      <input
                        value={action.title}
                        onChange={(event) => updateDraftAction(action.key, "title", event.target.value)}
                        disabled={!canInvestigate || busy}
                        style={{ ...controlStyle, marginTop: 6 }}
                      />
                    </label>
                    <label>
                      <strong>Owner</strong>
                      <select
                        value={action.ownerId}
                        onChange={(event) => updateDraftAction(action.key, "ownerId", event.target.value)}
                        disabled={!canInvestigate || busy}
                        style={{ ...controlStyle, marginTop: 6 }}
                      >
                        <option value="">Select owner</option>
                        {members.map((member) => (
                          <option key={member.id} value={member.id}>{member.displayName}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <strong>Due date</strong>
                      <input
                        type="date"
                        value={action.dueDate}
                        onChange={(event) => updateDraftAction(action.key, "dueDate", event.target.value)}
                        disabled={!canInvestigate || busy}
                        style={{ ...controlStyle, marginTop: 6 }}
                      />
                    </label>
                  </div>
                  <label style={{ display: "block", marginTop: 10 }}>
                    <strong>Description</strong>
                    <textarea
                      value={action.description}
                      onChange={(event) => updateDraftAction(action.key, "description", event.target.value)}
                      disabled={!canInvestigate || busy}
                      rows={2}
                      style={{ ...controlStyle, marginTop: 6, resize: "vertical" }}
                    />
                  </label>
                </section>
              ))}
            </div>
          ) : (
            <p className="muted">Add at least one action before activating CAPA.</p>
          )}

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 16 }}>
            <button
              type="button"
              onClick={saveDraft}
              disabled={!canInvestigate || busy || !objective.trim() || !draftActions.length}
              style={buttonStyle}
            >
              Save draft
            </button>
            <button
              type="button"
              onClick={async () => {
                const saved = await saveDraft();
                if (saved) await patch({ action: "ACTIVATE" });
              }}
              disabled={!canInvestigate || busy || !objective.trim() || !draftActions.length}
              style={{ ...buttonStyle, background: "#111827", color: "white", borderColor: "#111827" }}
            >
              Activate CAPA
            </button>
          </div>
        </section>
      ) : null}

      {capa && !isDraft ? (
        <section className="card responsive-table">
          <h2>Action execution</h2>
          <table className="table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Action</th>
                <th>Owner</th>
                <th>Due</th>
                <th>Status</th>
                <th>Completion evidence</th>
                <th>Workflow</th>
              </tr>
            </thead>
            <tbody>
              {capa.actions.map((action) => (
                <tr key={action.id}>
                  <td>{action.type}</td>
                  <td><strong>{action.title}</strong>{action.description ? <div className="muted">{action.description}</div> : null}</td>
                  <td>{memberName(action.ownerId)}</td>
                  <td>{dateInput(action.dueAt)}</td>
                  <td><span className="badge">{action.status}</span></td>
                  <td>
                    {action.completionNote ?? (
                      isActive ? (
                        <input
                          value={completionNotes[action.id] ?? ""}
                          onChange={(event) => setCompletionNotes((current) => ({ ...current, [action.id]: event.target.value }))}
                          placeholder="Required to complete"
                          style={controlStyle}
                        />
                      ) : "—"
                    )}
                  </td>
                  <td>
                    {isActive && action.status === "PLANNED" ? (
                      <button type="button" onClick={() => transitionAction(action, "START")} disabled={busy} style={buttonStyle}>Start</button>
                    ) : null}
                    {isActive && (action.status === "PLANNED" || action.status === "IN_PROGRESS") ? (
                      <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                        <button
                          type="button"
                          onClick={() => transitionAction(action, "COMPLETE")}
                          disabled={busy || !(completionNotes[action.id]?.trim())}
                          style={buttonStyle}
                        >
                          Complete
                        </button>
                        <button type="button" onClick={() => transitionAction(action, "CANCEL")} disabled={busy} style={buttonStyle}>Cancel</button>
                      </div>
                    ) : null}
                    {!isActive ? "—" : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {isActive ? (
            <div style={{ marginTop: 16 }}>
              <button
                type="button"
                onClick={() => patch({ action: "READY_FOR_EFFECTIVENESS" })}
                disabled={busy || !allActionsDispositioned}
                style={{ ...buttonStyle, background: "#111827", color: "white", borderColor: "#111827" }}
              >
                Ready for effectiveness verification
              </button>
              {!allActionsDispositioned ? (
                <span className="muted" style={{ marginLeft: 10 }}>Complete or cancel every action first.</span>
              ) : null}
            </div>
          ) : null}

          {readyForEffectiveness ? (
            <p className="muted" style={{ marginBottom: 0 }}>
              All actions are dispositioned. Effectiveness verification is the next controlled step.
            </p>
          ) : null}
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
