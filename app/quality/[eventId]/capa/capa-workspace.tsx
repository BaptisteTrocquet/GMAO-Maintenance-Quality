"use client";

import { useMemo, useState } from "react";
import type { CapaSnapshot } from "@/lib/quality/capa";

type Member = { id: string; name: string };
type EditableAction = {
  id: string;
  type: "CORRECTIVE" | "PREVENTIVE";
  title: string;
  description: string;
  ownerId: string;
  dueAt: string;
};

function toLocalInput(value: string) {
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function initialActions(capa: CapaSnapshot | null): EditableAction[] {
  return (
    capa?.actions.map((action) => ({
      id: action.id,
      type: action.type,
      title: action.title,
      description: action.description ?? "",
      ownerId: action.ownerId,
      dueAt: toLocalInput(action.dueAt),
    })) ?? []
  );
}

export default function CapaWorkspace({
  organizationId,
  siteId,
  eventId,
  eventStatus,
  rootCauseConfirmed,
  members,
  initialCapa,
}: {
  organizationId: string;
  siteId: string;
  eventId: string;
  eventStatus: string;
  rootCauseConfirmed: boolean;
  members: Member[];
  initialCapa: CapaSnapshot | null;
}) {
  const [capa, setCapa] = useState<CapaSnapshot | null>(initialCapa);
  const [objective, setObjective] = useState(initialCapa?.objective ?? "");
  const [actions, setActions] = useState<EditableAction[]>(() => initialActions(initialCapa));
  const [evidenceByAction, setEvidenceByAction] = useState<Record<string, string>>({});
  const [effectivenessMethod, setEffectivenessMethod] = useState(initialCapa?.effectiveness?.method ?? "");
  const [effectivenessOwnerId, setEffectivenessOwnerId] = useState(initialCapa?.effectiveness?.ownerId ?? members[0]?.id ?? "");
  const [effectivenessDueAt, setEffectivenessDueAt] = useState(
    initialCapa?.effectiveness?.dueAt ? toLocalInput(initialCapa.effectiveness.dueAt) : "",
  );
  const [effectivenessEvidence, setEffectivenessEvidence] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const locked = eventStatus !== "INVESTIGATING" || capa?.status === "CLOSED";
  const canEditDefinition = !locked && capa?.status !== "EFFECTIVENESS_REVIEW";
  const completedActions = useMemo(
    () => capa?.actions.filter((action) => action.status === "COMPLETED").length ?? 0,
    [capa],
  );

  async function run(body: Record<string, unknown>) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/quality/events/${eventId}/capa`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId, siteId, ...body }),
      });
      const payload = (await response.json()) as {
        data?: CapaSnapshot;
        error?: { message?: string; code?: string };
      };
      if (!response.ok || !payload.data) {
        throw new Error(payload.error?.message ?? payload.error?.code ?? "CAPA update failed");
      }
      setCapa(payload.data);
      setObjective(payload.data.objective);
      setActions(initialActions(payload.data));
      setEffectivenessMethod(payload.data.effectiveness?.method ?? "");
      setEffectivenessOwnerId(payload.data.effectiveness?.ownerId ?? effectivenessOwnerId);
      setEffectivenessDueAt(
        payload.data.effectiveness?.dueAt ? toLocalInput(payload.data.effectiveness.dueAt) : effectivenessDueAt,
      );
      setMessage("Saved.");
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "CAPA update failed");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    await run({
      action: "SAVE",
      objective,
      actions: actions.map((item) => ({
        ...item,
        description: item.description || null,
        dueAt: new Date(item.dueAt).toISOString(),
      })),
    });
  }

  async function activate() {
    const saved = await save();
    if (!saved) return;
    await run({ action: "ACTIVATE" });
  }

  function addAction() {
    setActions((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        type: "CORRECTIVE",
        title: "",
        description: "",
        ownerId: members[0]?.id ?? "",
        dueAt: "",
      },
    ]);
  }

  function updateAction(id: string, patch: Partial<EditableAction>) {
    setActions((current) =>
      current.map((action) => (action.id === id ? { ...action, ...patch } : action)),
    );
  }

  async function transitionAction(
    actionId: string,
    status: "IN_PROGRESS" | "COMPLETED" | "CANCELLED",
  ) {
    await run({
      action: "TRANSITION_ACTION",
      actionId,
      status,
      evidence: evidenceByAction[actionId] || null,
    });
  }

  return (
    <div className="stack-list">
      <section className="card">
        <div className="header asset-header">
          <div>
            <h2>CAPA plan</h2>
            <div className="muted">
              Root cause {rootCauseConfirmed ? "confirmed" : "not confirmed"} · {completedActions} completed action(s)
            </div>
          </div>
          <div className="asset-status">
            <span className="badge">{capa?.status ?? "NOT STARTED"}</span>
          </div>
        </div>

        <label>
          Objective
          <textarea
            value={objective}
            disabled={!canEditDefinition || busy}
            onChange={(event) => setObjective(event.target.value)}
            rows={3}
          />
        </label>

        <div className="section">
          <div className="header asset-header">
            <h3>Corrective / preventive actions</h3>
            <button type="button" disabled={!canEditDefinition || busy} onClick={addAction}>
              Add action
            </button>
          </div>

          {actions.length ? (
            <div className="stack-list">
              {actions.map((action, index) => {
                const runtime = capa?.actions.find((candidate) => candidate.id === action.id);
                const immutable = runtime?.status === "COMPLETED" || runtime?.status === "CANCELLED";
                return (
                  <section className="card" key={action.id}>
                    <div className="header asset-header">
                      <strong>Action {index + 1}</strong>
                      <span className="badge">{runtime?.status ?? "OPEN"}</span>
                    </div>
                    <div className="grid grid-2">
                      <label>
                        Type
                        <select
                          value={action.type}
                          disabled={!canEditDefinition || immutable || busy}
                          onChange={(event) =>
                            updateAction(action.id, {
                              type: event.target.value as EditableAction["type"],
                            })
                          }
                        >
                          <option value="CORRECTIVE">Corrective</option>
                          <option value="PREVENTIVE">Preventive</option>
                        </select>
                      </label>
                      <label>
                        Owner
                        <select
                          value={action.ownerId}
                          disabled={!canEditDefinition || immutable || busy}
                          onChange={(event) => updateAction(action.id, { ownerId: event.target.value })}
                        >
                          {members.map((member) => (
                            <option key={member.id} value={member.id}>{member.name}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Title
                        <input
                          value={action.title}
                          disabled={!canEditDefinition || immutable || busy}
                          onChange={(event) => updateAction(action.id, { title: event.target.value })}
                        />
                      </label>
                      <label>
                        Due date
                        <input
                          type="datetime-local"
                          value={action.dueAt}
                          disabled={!canEditDefinition || immutable || busy}
                          onChange={(event) => updateAction(action.id, { dueAt: event.target.value })}
                        />
                      </label>
                    </div>
                    <label>
                      Description
                      <textarea
                        value={action.description}
                        disabled={!canEditDefinition || immutable || busy}
                        onChange={(event) => updateAction(action.id, { description: event.target.value })}
                        rows={2}
                      />
                    </label>

                    {capa?.status === "ACTIVE" && runtime && !immutable ? (
                      <div className="section">
                        <label>
                          Completion evidence / cancellation rationale
                          <textarea
                            value={evidenceByAction[action.id] ?? ""}
                            disabled={busy}
                            onChange={(event) =>
                              setEvidenceByAction((current) => ({
                                ...current,
                                [action.id]: event.target.value,
                              }))
                            }
                            rows={2}
                          />
                        </label>
                        <div className="asset-status">
                          {runtime.status === "OPEN" ? (
                            <button type="button" disabled={busy} onClick={() => transitionAction(action.id, "IN_PROGRESS")}>
                              Start
                            </button>
                          ) : null}
                          <button type="button" disabled={busy} onClick={() => transitionAction(action.id, "COMPLETED")}>
                            Complete
                          </button>
                          <button type="button" disabled={busy} onClick={() => transitionAction(action.id, "CANCELLED")}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : null}

                    {runtime?.completionEvidence ? (
                      <p className="muted">Evidence: {runtime.completionEvidence}</p>
                    ) : null}
                  </section>
                );
              })}
            </div>
          ) : (
            <p className="muted">Add at least one corrective or preventive action.</p>
          )}
        </div>

        {canEditDefinition ? (
          <div className="asset-status section">
            <button type="button" disabled={busy} onClick={save}>Save CAPA</button>
            {capa?.status === "DRAFT" || !capa ? (
              <button type="button" disabled={busy || !rootCauseConfirmed} onClick={activate}>
                Activate CAPA
              </button>
            ) : null}
          </div>
        ) : null}
      </section>

      {capa?.status === "ACTIVE" ? (
        <section className="card">
          <h2>Effectiveness review plan</h2>
          <div className="grid grid-2">
            <label>
              Verification method
              <input
                value={effectivenessMethod}
                disabled={busy}
                onChange={(event) => setEffectivenessMethod(event.target.value)}
              />
            </label>
            <label>
              Owner
              <select
                value={effectivenessOwnerId}
                disabled={busy}
                onChange={(event) => setEffectivenessOwnerId(event.target.value)}
              >
                {members.map((member) => (
                  <option key={member.id} value={member.id}>{member.name}</option>
                ))}
              </select>
            </label>
            <label>
              Due date
              <input
                type="datetime-local"
                value={effectivenessDueAt}
                disabled={busy}
                onChange={(event) => setEffectivenessDueAt(event.target.value)}
              />
            </label>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              run({
                action: "SUBMIT_EFFECTIVENESS",
                method: effectivenessMethod,
                ownerId: effectivenessOwnerId,
                dueAt: new Date(effectivenessDueAt).toISOString(),
              })
            }
          >
            Submit effectiveness review
          </button>
        </section>
      ) : null}

      {capa?.status === "EFFECTIVENESS_REVIEW" ? (
        <section className="card">
          <h2>Verify effectiveness</h2>
          <p>
            {capa.effectiveness?.method} · Owner {capa.effectiveness?.ownerName} · due {capa.effectiveness?.dueAt}
          </p>
          <label>
            Verification evidence
            <textarea
              value={effectivenessEvidence}
              disabled={busy}
              onChange={(event) => setEffectivenessEvidence(event.target.value)}
              rows={3}
            />
          </label>
          <div className="asset-status">
            <button
              type="button"
              disabled={busy}
              onClick={() => run({ action: "VERIFY_EFFECTIVENESS", result: "EFFECTIVE", evidence: effectivenessEvidence })}
            >
              Effective — close CAPA
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => run({ action: "VERIFY_EFFECTIVENESS", result: "INEFFECTIVE", evidence: effectivenessEvidence })}
            >
              Ineffective — reopen actions
            </button>
          </div>
        </section>
      ) : null}

      {capa?.status === "CLOSED" ? (
        <section className="card">
          <h2>CAPA closed</h2>
          <p>{capa.effectiveness?.evidence ?? "Effectiveness verified."}</p>
        </section>
      ) : null}

      {message ? <div className="muted">{message}</div> : null}
    </div>
  );
}
