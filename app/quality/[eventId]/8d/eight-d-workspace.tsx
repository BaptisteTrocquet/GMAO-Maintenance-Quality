"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { EightDSnapshot } from "@/lib/quality/eight-d";

type Member = { id: string; name: string; role: string };
type TeamDraft = { userId: string; responsibility: string };

const DISCIPLINES = ["D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8"] as const;
const LABELS: Record<(typeof DISCIPLINES)[number], string> = {
  D1: "Build the team",
  D2: "Describe the problem",
  D3: "Contain the problem",
  D4: "Confirm root cause",
  D5: "Choose permanent actions",
  D6: "Implement permanent actions",
  D7: "Prevent recurrence",
  D8: "Recognize and close",
};

export default function EightDWorkspace({
  organizationId,
  siteId,
  eventId,
  eventStatus,
  initialEightD,
  members,
}: {
  organizationId: string;
  siteId: string;
  eventId: string;
  eventStatus: string;
  initialEightD: EightDSnapshot | null;
  members: Member[];
}) {
  const router = useRouter();
  const [team, setTeam] = useState<TeamDraft[]>(() =>
    initialEightD?.d1Team.map((member) => ({
      userId: member.userId,
      responsibility: member.responsibility,
    })) ?? [],
  );
  const [problemStatement, setProblemStatement] = useState(initialEightD?.d2ProblemStatement ?? "");
  const [preventionSummary, setPreventionSummary] = useState(initialEightD?.d7PreventionSummary ?? "");
  const [systemicChangesText, setSystemicChangesText] = useState(
    initialEightD?.d7SystemicChanges.join("\n") ?? "",
  );
  const [recognitionNote, setRecognitionNote] = useState(initialEightD?.d8RecognitionNote ?? "");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const current = initialEightD?.currentDiscipline ?? "D1";
  const completed = initialEightD?.status === "COMPLETED";
  const investigating = eventStatus === "INVESTIGATING";
  const editable = investigating && !completed && !pending;

  async function parseResponse(response: Response) {
    const body = (await response.json()) as { error?: { message?: string } };
    if (!response.ok) throw new Error(body.error?.message ?? "8D workflow request failed");
  }

  async function save() {
    const response = await fetch(`/api/quality/events/${eventId}/8d`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        organizationId,
        siteId,
        team,
        problemStatement,
        preventionSummary,
        systemicChanges: systemicChangesText
          .split("\n")
          .map((value) => value.trim())
          .filter(Boolean),
        recognitionNote,
      }),
    });
    await parseResponse(response);
  }

  async function run(action: "SAVE" | "ADVANCE") {
    if (!investigating) {
      setMessage("Start or reopen the quality-event investigation before editing 8D.");
      return;
    }
    setPending(true);
    setMessage(null);
    try {
      await save();
      if (action === "ADVANCE") {
        const response = await fetch(`/api/quality/events/${eventId}/8d`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ organizationId, siteId, action: "ADVANCE" }),
        });
        await parseResponse(response);
        setMessage(current === "D8" ? "8D completed." : `${current} completed.`);
      } else {
        setMessage("8D workspace saved.");
      }
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "8D workflow request failed");
    } finally {
      setPending(false);
    }
  }

  function addTeamMember() {
    const firstUnused = members.find((member) => !team.some((entry) => entry.userId === member.id));
    if (!firstUnused) return;
    setTeam([...team, { userId: firstUnused.id, responsibility: "" }]);
  }

  return (
    <div className="grid grid-2">
      <section className="card">
        <h2>8D progression</h2>
        <div className="stack-list">
          {DISCIPLINES.map((discipline) => {
            const currentIndex = DISCIPLINES.indexOf(current);
            const disciplineIndex = DISCIPLINES.indexOf(discipline);
            const state = completed || disciplineIndex < currentIndex
              ? "✓"
              : discipline === current
                ? "→"
                : "○";
            return (
              <div key={discipline}>
                <strong>{state} {discipline}</strong>
                <span className="muted"> · {LABELS[discipline]}</span>
              </div>
            );
          })}
        </div>
      </section>

      <section className="card">
        <h2>Current discipline · {current}</h2>
        <p>{LABELS[current]}</p>
        <div className="muted">
          Version {initialEightD?.version ?? 0} · {initialEightD?.status ?? "NOT STARTED"}
        </div>
        {!investigating ? (
          <p className="muted">The workspace is read-only until the quality event is INVESTIGATING.</p>
        ) : null}
      </section>

      <section className="card">
        <h2>D1 · Team</h2>
        <div className="stack-list">
          {team.map((entry, index) => (
            <div className="quality-action-row" key={`${entry.userId}-${index}`}>
              <select
                value={entry.userId}
                disabled={!editable}
                onChange={(event) => {
                  const next = [...team];
                  next[index] = { ...entry, userId: event.target.value };
                  setTeam(next);
                }}
              >
                {members.map((member) => (
                  <option key={member.id} value={member.id}>{member.name} · {member.role}</option>
                ))}
              </select>
              <input
                value={entry.responsibility}
                disabled={!editable}
                placeholder="Responsibility"
                onChange={(event) => {
                  const next = [...team];
                  next[index] = { ...entry, responsibility: event.target.value };
                  setTeam(next);
                }}
              />
              <button
                type="button"
                disabled={!editable}
                onClick={() => setTeam(team.filter((_, teamIndex) => teamIndex !== index))}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
        <button type="button" disabled={!editable || team.length >= members.length} onClick={addTeamMember}>
          Add team member
        </button>
      </section>

      <section className="card">
        <h2>D2 · Problem statement</h2>
        <textarea
          value={problemStatement}
          disabled={!editable}
          rows={7}
          placeholder="Define what, where, when and how large the problem is."
          onChange={(event) => setProblemStatement(event.target.value)}
        />
      </section>

      <section className="card">
        <h2>D3–D6 · Controlled evidence</h2>
        <dl className="detail-list">
          <div><dt>D3 containment</dt><dd>{initialEightD?.d3Containment ? "Frozen" : "Pending"}</dd></div>
          <div><dt>D4 root cause</dt><dd>{initialEightD?.d4RootCause ? "Frozen" : "Pending"}</dd></div>
          <div><dt>D5 permanent actions</dt><dd>{initialEightD?.d5Actions.length ?? 0}</dd></div>
          <div><dt>D6 implemented actions</dt><dd>{initialEightD?.d6Implementation?.actions.length ?? 0}</dd></div>
        </dl>
        <p className="muted">
          These disciplines are captured from completed containment, confirmed RCA and approved/completed CAPA records. They cannot be typed over in 8D.
        </p>
      </section>

      <section className="card">
        <h2>D7 · Prevent recurrence</h2>
        <textarea
          value={preventionSummary}
          disabled={!editable}
          rows={5}
          placeholder="Describe how recurrence is prevented systemically."
          onChange={(event) => setPreventionSummary(event.target.value)}
        />
        <label className="form-field section">
          <span>Systemic changes · one per line</span>
          <textarea
            value={systemicChangesText}
            disabled={!editable}
            rows={5}
            onChange={(event) => setSystemicChangesText(event.target.value)}
          />
        </label>
      </section>

      <section className="card">
        <h2>D8 · Recognize and close</h2>
        <textarea
          value={recognitionNote}
          disabled={!editable}
          rows={5}
          placeholder="Record closure, learning and team recognition."
          onChange={(event) => setRecognitionNote(event.target.value)}
        />
        {initialEightD?.d8Effectiveness ? (
          <p className="muted">Effectiveness: {initialEightD.d8Effectiveness.note}</p>
        ) : null}
      </section>

      <section className="card">
        <h2>Workflow actions</h2>
        <div className="workflow-actions">
          <button type="button" disabled={!editable} onClick={() => void run("SAVE")}>Save workspace</button>
          <button type="button" disabled={!editable} onClick={() => void run("ADVANCE")}>Complete {current}</button>
          {message ? <span className="muted" role="status">{message}</span> : null}
        </div>
      </section>
    </div>
  );
}
