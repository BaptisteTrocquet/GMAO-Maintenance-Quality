"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { EightDDiscipline, EightDSnapshot } from "@/lib/quality/eight-d";

type MemberOption = { id: string; displayName: string };
type TeamRow = { key: string; userId: string; responsibility: string };

type Props = {
  organizationId: string;
  siteId: string;
  eventId: string;
  eventStatus: "OPEN" | "CONTAINED" | "INVESTIGATING" | "CLOSED";
  initialEightD: EightDSnapshot | null;
  members: MemberOption[];
};

const DISCIPLINES: Array<{ key: EightDDiscipline; label: string; summary: string }> = [
  { key: "D1", label: "D1 · Team", summary: "Establish the cross-functional 8D team." },
  { key: "D2", label: "D2 · Problem", summary: "Describe the problem precisely." },
  { key: "D3", label: "D3 · Containment", summary: "Confirm immediate containment is complete." },
  { key: "D4", label: "D4 · Root cause", summary: "Confirm the structured root-cause analysis." },
  { key: "D5", label: "D5 · Permanent actions", summary: "Select approved permanent CAPA actions." },
  { key: "D6", label: "D6 · Validate", summary: "Validate implementation and effectiveness." },
  { key: "D7", label: "D7 · Prevent recurrence", summary: "Capture systemic preventive changes." },
  { key: "D8", label: "D8 · Close", summary: "Close and recognize the team." },
];

function initialTeam(snapshot: EightDSnapshot | null): TeamRow[] {
  return (snapshot?.d1Team ?? []).map((member) => ({
    key: member.userId,
    userId: member.userId,
    responsibility: member.responsibility,
  }));
}

function disciplineIndex(value: EightDDiscipline) {
  return DISCIPLINES.findIndex((discipline) => discipline.key === value);
}

export default function EightDWorkspace({
  organizationId,
  siteId,
  eventId,
  eventStatus,
  initialEightD,
  members,
}: Props) {
  const router = useRouter();
  const [eightD, setEightD] = useState(initialEightD);
  const [team, setTeam] = useState<TeamRow[]>(() => initialTeam(initialEightD));
  const [problemStatement, setProblemStatement] = useState(initialEightD?.d2ProblemStatement ?? "");
  const [preventionSummary, setPreventionSummary] = useState(initialEightD?.d7PreventionSummary ?? "");
  const [systemicChanges, setSystemicChanges] = useState<string[]>(
    initialEightD?.d7SystemicChanges.length ? initialEightD.d7SystemicChanges : [""],
  );
  const [recognitionNote, setRecognitionNote] = useState(initialEightD?.d8RecognitionNote ?? "");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "error" | "success"; message: string } | null>(null);

  const canManage = eventStatus === "INVESTIGATING" && eightD?.status !== "COMPLETED";
  const current = eightD?.currentDiscipline ?? "D1";
  const currentIndex = disciplineIndex(current);

  const inputStyle = {
    width: "100%",
    padding: "10px 12px",
    border: "1px solid #d1d5db",
    borderRadius: 8,
    background: canManage ? "white" : "#f9fafb",
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
      const response = await fetch(`/api/quality/events/${eventId}/eight-d`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId, siteId, ...payload }),
      });
      const body = (await response.json()) as {
        data?: EightDSnapshot;
        error?: { message?: string; code?: string };
      };
      if (!response.ok || !body.data) {
        const code = body.error?.code ? `${body.error.code}: ` : "";
        throw new Error(`${code}${body.error?.message ?? "8D update failed"}`);
      }
      setEightD(body.data);
      setTeam(initialTeam(body.data));
      setProblemStatement(body.data.d2ProblemStatement);
      setPreventionSummary(body.data.d7PreventionSummary);
      setSystemicChanges(body.data.d7SystemicChanges.length ? body.data.d7SystemicChanges : [""]);
      setRecognitionNote(body.data.d8RecognitionNote);
      setFeedback({ kind: "success", message: "8D updated." });
      router.refresh();
      return body.data;
    } catch (error) {
      setFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : "8D update failed",
      });
      return null;
    } finally {
      setBusy(false);
    }
  }

  function addTeamMember() {
    setTeam((currentRows) => [
      ...currentRows,
      {
        key: `${Date.now()}-${currentRows.length}`,
        userId: members.find((member) => !currentRows.some((row) => row.userId === member.id))?.id ?? "",
        responsibility: "",
      },
    ]);
  }

  function updateTeamMember(key: string, patch: Partial<TeamRow>) {
    setTeam((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  function removeTeamMember(key: string) {
    setTeam((rows) => rows.filter((row) => row.key !== key));
  }

  function updateSystemicChange(index: number, value: string) {
    setSystemicChanges((changes) => changes.map((change, itemIndex) => (itemIndex === index ? value : change)));
  }

  async function save() {
    return request("PUT", {
      team: team
        .filter((row) => row.userId)
        .map((row) => ({ userId: row.userId, responsibility: row.responsibility })),
      problemStatement,
      preventionSummary,
      systemicChanges: systemicChanges.map((value) => value.trim()).filter(Boolean),
      recognitionNote,
    });
  }

  async function advance() {
    const saved = await save();
    if (!saved) return;
    await request("PATCH", { action: "ADVANCE" });
  }

  return (
    <div className="grid" style={{ gap: 18 }}>
      {eventStatus !== "INVESTIGATING" ? (
        <section className="card">
          <strong>Investigation required</strong>
          <p className="muted" style={{ marginBottom: 0 }}>
            8D can advance only while the quality event is in investigation.
          </p>
        </section>
      ) : null}

      <section className="card">
        <div className="header asset-header" style={{ marginBottom: 12 }}>
          <div>
            <h2 style={{ margin: 0 }}>8D progress</h2>
            <div className="muted">Current discipline: {current}</div>
          </div>
          <div className="asset-status">
            <span className="badge">{eightD?.status ?? "NOT STARTED"}</span>
          </div>
        </div>
        <div className="grid grid-2" style={{ gap: 10 }}>
          {DISCIPLINES.map((discipline, index) => {
            const state =
              eightD?.status === "COMPLETED" || index < currentIndex
                ? "Completed"
                : index === currentIndex
                  ? "Current"
                  : "Pending";
            return (
              <div className="card" key={discipline.key}>
                <div className="asset-status" style={{ justifyContent: "space-between" }}>
                  <strong>{discipline.label}</strong>
                  <span className="badge">{state}</span>
                </div>
                <div className="muted" style={{ marginTop: 6 }}>{discipline.summary}</div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="card">
        <h2>D1 · Establish the team</h2>
        <p className="muted">Team labels are frozen into the 8D record when saved.</p>
        <div className="grid" style={{ gap: 10 }}>
          {team.map((row) => (
            <div className="grid grid-2" style={{ gap: 10 }} key={row.key}>
              <select
                value={row.userId}
                disabled={!canManage || busy || currentIndex > 0}
                onChange={(event) => updateTeamMember(row.key, { userId: event.target.value })}
                style={inputStyle}
              >
                <option value="">Select team member</option>
                {members.map((member) => (
                  <option value={member.id} key={member.id}>{member.displayName}</option>
                ))}
              </select>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  value={row.responsibility}
                  disabled={!canManage || busy || currentIndex > 0}
                  onChange={(event) => updateTeamMember(row.key, { responsibility: event.target.value })}
                  placeholder="Responsibility"
                  style={inputStyle}
                />
                {canManage && currentIndex === 0 ? (
                  <button type="button" style={buttonStyle} disabled={busy} onClick={() => removeTeamMember(row.key)}>
                    Remove
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
        {canManage && currentIndex === 0 ? (
          <button type="button" style={{ ...buttonStyle, marginTop: 10 }} disabled={busy} onClick={addTeamMember}>
            + Team member
          </button>
        ) : null}
      </section>

      <section className="card">
        <h2>D2 · Describe the problem</h2>
        <textarea
          value={problemStatement}
          disabled={!canManage || busy || currentIndex > 1}
          onChange={(event) => setProblemStatement(event.target.value)}
          rows={5}
          style={{ ...inputStyle, resize: "vertical" }}
          placeholder="Describe what happened, where, when, scope and impact."
        />
      </section>

      <section className="card">
        <h2>D3 · Immediate containment</h2>
        {eightD?.d3Containment ? (
          <p>{eightD.d3Containment.summary} <span className="muted">· completed {new Date(eightD.d3Containment.completedAt).toLocaleString()}</span></p>
        ) : (
          <p className="muted">Derived from the quality-event containment. Complete containment before advancing D3.</p>
        )}
      </section>

      <section className="card">
        <h2>D4 · Root cause</h2>
        {eightD?.d4RootCause ? (
          <p>{eightD.d4RootCause.summary} <span className="muted">· confirmed {new Date(eightD.d4RootCause.confirmedAt).toLocaleString()}</span></p>
        ) : (
          <p className="muted">Derived from the confirmed RCA workspace. Confirm RCA before advancing D4.</p>
        )}
      </section>

      <section className="card">
        <h2>D5 · Permanent corrective actions</h2>
        {eightD?.d5Actions.length ? (
          <div className="stack-list">
            {eightD.d5Actions.map((action) => (
              <div key={action.id}>
                <strong>{action.type} · {action.title}</strong>
                <span className="muted"> · {action.ownerName} · due {new Date(action.dueAt).toLocaleString()}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">Derived from the approved CAPA. CAPA approval is the D5 gate.</p>
        )}
      </section>

      <section className="card">
        <h2>D6 · Implement and validate</h2>
        {eightD?.d6Validation ? (
          <>
            <p>{eightD.d6Validation.effectivenessNote}</p>
            <div className="muted">
              {eightD.d6Validation.completedActionIds.length} permanent actions completed · validation {new Date(eightD.d6Validation.verifiedAt).toLocaleString()}
            </div>
          </>
        ) : (
          <p className="muted">Requires every CAPA action completed and the latest effectiveness verification to be EFFECTIVE.</p>
        )}
      </section>

      <section className="card">
        <h2>D7 · Prevent recurrence</h2>
        <label>
          <strong>Prevention summary</strong>
          <textarea
            value={preventionSummary}
            disabled={!canManage || busy || currentIndex > 6}
            onChange={(event) => setPreventionSummary(event.target.value)}
            rows={4}
            style={{ ...inputStyle, marginTop: 6, resize: "vertical" }}
            placeholder="Describe the systemic prevention approach."
          />
        </label>
        <div style={{ marginTop: 12 }}>
          <strong>Systemic changes</strong>
          <div className="grid" style={{ gap: 8, marginTop: 6 }}>
            {systemicChanges.map((change, index) => (
              <div style={{ display: "flex", gap: 8 }} key={index}>
                <input
                  value={change}
                  disabled={!canManage || busy || currentIndex > 6}
                  onChange={(event) => updateSystemicChange(index, event.target.value)}
                  placeholder="Procedure, standard, training or control changed"
                  style={inputStyle}
                />
                {canManage && currentIndex <= 6 && systemicChanges.length > 1 ? (
                  <button
                    type="button"
                    style={buttonStyle}
                    disabled={busy}
                    onClick={() => setSystemicChanges((items) => items.filter((_, itemIndex) => itemIndex !== index))}
                  >
                    Remove
                  </button>
                ) : null}
              </div>
            ))}
          </div>
          {canManage && currentIndex <= 6 ? (
            <button
              type="button"
              style={{ ...buttonStyle, marginTop: 8 }}
              disabled={busy}
              onClick={() => setSystemicChanges((items) => [...items, ""])}
            >
              + Systemic change
            </button>
          ) : null}
        </div>
      </section>

      <section className="card">
        <h2>D8 · Close and recognize</h2>
        <textarea
          value={recognitionNote}
          disabled={!canManage || busy}
          onChange={(event) => setRecognitionNote(event.target.value)}
          rows={4}
          style={{ ...inputStyle, resize: "vertical" }}
          placeholder="Summarize closure and recognize the team contribution."
        />
      </section>

      {canManage ? (
        <section className="card">
          <div className="asset-status">
            <button type="button" style={buttonStyle} disabled={busy} onClick={save}>Save workspace</button>
            <button type="button" style={buttonStyle} disabled={busy} onClick={advance}>
              Advance {current}
            </button>
          </div>
          {feedback ? (
            <p role="status" style={{ marginBottom: 0 }}>
              {feedback.kind === "error" ? "Error: " : ""}{feedback.message}
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
