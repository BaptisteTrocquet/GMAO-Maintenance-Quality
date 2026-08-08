"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { EightDDisciplineKey, EightDSnapshot } from "@/lib/quality/eight-d";

type MemberOption = { id: string; name: string; role: string };
type Discipline = { key: EightDDisciplineKey; label: string; complete: boolean; source: string };

type Props = {
  organizationId: string;
  siteId: string;
  eventId: string;
  eventStatus: string;
  initialEightD: EightDSnapshot | null;
  disciplines: Discipline[];
  members: MemberOption[];
};

export default function EightDWorkspace({
  organizationId,
  siteId,
  eventId,
  eventStatus,
  initialEightD,
  disciplines,
  members,
}: Props) {
  const router = useRouter();
  const [eightD, setEightD] = useState(initialEightD);
  const [leaderId, setLeaderId] = useState(initialEightD?.leaderId ?? members[0]?.id ?? "");
  const [teamMemberIds, setTeamMemberIds] = useState<string[]>(
    initialEightD?.teamMemberIds ?? (members[0] ? [members[0].id] : []),
  );
  const [problemStatement, setProblemStatement] = useState(initialEightD?.problemStatement ?? "");
  const [preventionSummary, setPreventionSummary] = useState(initialEightD?.preventionSummary ?? "");
  const [recognitionNote, setRecognitionNote] = useState(initialEightD?.recognitionNote ?? "");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "error" | "success"; message: string } | null>(null);

  const memberNames = useMemo(
    () => new Map(members.map((member) => [member.id, member.name])),
    [members],
  );

  const editableDraft = !eightD || eightD.status === "DRAFT";

  async function patch(payload: Record<string, unknown>, successMessage: string) {
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch(`/api/quality/events/${eventId}/eight-d`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId, siteId, ...payload }),
      });
      const body = (await response.json()) as {
        data?: EightDSnapshot;
        error?: { message?: string };
      };
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? "8D update failed");
      }
      setEightD(body.data);
      setLeaderId(body.data.leaderId);
      setTeamMemberIds(body.data.teamMemberIds);
      setProblemStatement(body.data.problemStatement);
      setPreventionSummary(body.data.preventionSummary ?? "");
      setRecognitionNote(body.data.recognitionNote ?? "");
      setFeedback({ kind: "success", message: successMessage });
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

  function toggleMember(userId: string) {
    setTeamMemberIds((current) => {
      if (userId === leaderId) return current.includes(userId) ? current : [...current, userId];
      return current.includes(userId)
        ? current.filter((id) => id !== userId)
        : [...current, userId];
    });
  }

  function changeLeader(userId: string) {
    setLeaderId(userId);
    setTeamMemberIds((current) => (current.includes(userId) ? current : [...current, userId]));
  }

  return (
    <>
      <section className="card">
        <div className="header asset-header">
          <div>
            <h2>8D progress</h2>
            <div className="muted">Operational steps remain owned by their existing quality workspaces.</div>
          </div>
          <div className="asset-status">
            <span className="badge">EVENT {eventStatus}</span>
            <span className="badge">8D {eightD?.status ?? "NOT STARTED"}</span>
          </div>
        </div>
        <div className="grid grid-2">
          {disciplines.map((discipline) => (
            <div className="card" key={discipline.key}>
              <strong>{discipline.key} · {discipline.label}</strong>
              <div className="muted">Source: {discipline.source}</div>
              <span className="badge">{discipline.complete ? "COMPLETE" : "OPEN"}</span>
            </div>
          ))}
        </div>
        <div className="section stack-list">
          <Link className="table-link" href={`/quality/${eventId}`}>D3 · Quality event containment →</Link>
          <Link className="table-link" href={`/quality/${eventId}/root-cause`}>D4 · Root-cause workspace →</Link>
          <Link className="table-link" href={`/quality/${eventId}/capa`}>D5/D6 · CAPA workspace →</Link>
        </div>
      </section>

      <div className="grid grid-2 section">
        <section className="card">
          <h2>D1 · Build the team</h2>
          <label className="field">
            <span>8D leader</span>
            <select value={leaderId} onChange={(event) => changeLeader(event.target.value)} disabled={!editableDraft || busy}>
              <option value="">Select leader</option>
              {members.map((member) => (
                <option value={member.id} key={member.id}>{member.name} · {member.role}</option>
              ))}
            </select>
          </label>
          <div className="stack-list section">
            {members.map((member) => (
              <label key={member.id}>
                <input
                  type="checkbox"
                  checked={teamMemberIds.includes(member.id)}
                  disabled={!editableDraft || busy || member.id === leaderId}
                  onChange={() => toggleMember(member.id)}
                />{" "}
                {member.name} <span className="muted">· {member.role}</span>
              </label>
            ))}
          </div>
          {eightD ? (
            <p className="muted">
              Current team: {eightD.teamMemberIds.map((id) => memberNames.get(id) ?? id).join(", ") || "—"}
            </p>
          ) : null}
        </section>

        <section className="card">
          <h2>D2 · Describe the problem</h2>
          <label className="field">
            <span>Problem statement</span>
            <textarea
              rows={8}
              value={problemStatement}
              disabled={!editableDraft || busy}
              onChange={(event) => setProblemStatement(event.target.value)}
              placeholder="Describe what happened, where, when and with what impact."
            />
          </label>
          {editableDraft ? (
            <button
              type="button"
              disabled={busy || !leaderId || !problemStatement.trim()}
              onClick={() => patch({
                action: "SAVE",
                leaderId,
                teamMemberIds,
                problemStatement,
              }, "D1/D2 draft saved.")}
            >
              Save D1/D2
            </button>
          ) : null}
          {eightD?.status === "DRAFT" ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => patch({ action: "APPROVE" }, "8D approved and activated.")}
            >
              Approve 8D
            </button>
          ) : null}
        </section>

        <section className="card">
          <h2>D7 · Prevent recurrence</h2>
          <p className="muted">Available after confirmed root cause and effective, closed CAPA.</p>
          <label className="field">
            <span>Systemic prevention summary</span>
            <textarea
              rows={7}
              value={preventionSummary}
              disabled={eightD?.status !== "ACTIVE" || busy}
              onChange={(event) => setPreventionSummary(event.target.value)}
              placeholder="Describe standards, controls, training or systemic changes that prevent recurrence."
            />
          </label>
          {eightD?.status === "ACTIVE" ? (
            <button
              type="button"
              disabled={busy || !preventionSummary.trim()}
              onClick={() => patch({ action: "RECORD_PREVENTION", preventionSummary }, "D7 prevention recorded.")}
            >
              Record D7
            </button>
          ) : null}
        </section>

        <section className="card">
          <h2>D8 · Recognize and close</h2>
          <label className="field">
            <span>Recognition / closure note</span>
            <textarea
              rows={7}
              value={recognitionNote}
              disabled={eightD?.status !== "ACTIVE" || busy}
              onChange={(event) => setRecognitionNote(event.target.value)}
              placeholder="Recognize contributors and summarize the verified closure."
            />
          </label>
          {eightD?.status === "ACTIVE" ? (
            <button
              type="button"
              disabled={busy || !recognitionNote.trim()}
              onClick={() => patch({ action: "CLOSE", recognitionNote }, "8D closed.")}
            >
              Close 8D
            </button>
          ) : null}
          {eightD?.status === "CLOSED" ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => patch({ action: "REOPEN" }, "8D reopened as draft.")}
            >
              Reopen 8D
            </button>
          ) : null}
        </section>
      </div>

      {feedback ? (
        <section className="card section">
          <strong>{feedback.kind === "error" ? "Update failed" : "Saved"}</strong>
          <p>{feedback.message}</p>
        </section>
      ) : null}
    </>
  );
}
