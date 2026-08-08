"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { CapaSnapshot } from "@/lib/quality/capa";
import type { EightDDiscipline, EightDSnapshot } from "@/lib/quality/eight-d";

type MemberOption = { id: string; name: string; role: string };
type EditableTeamMember = { key: string; userId: string; responsibility: string };

type Props = {
  organizationId: string;
  siteId: string;
  eventId: string;
  initialEightD: EightDSnapshot | null;
  capa: CapaSnapshot | null;
  members: MemberOption[];
};

const DISCIPLINES: Array<{ id: EightDDiscipline; label: string }> = [
  { id: "D1", label: "Team" },
  { id: "D2", label: "Problem" },
  { id: "D3", label: "Containment" },
  { id: "D4", label: "Root cause" },
  { id: "D5", label: "Corrective actions" },
  { id: "D6", label: "Implement & validate" },
  { id: "D7", label: "Prevent recurrence" },
  { id: "D8", label: "Close & recognize" },
];

function editableTeam(snapshot: EightDSnapshot | null): EditableTeamMember[] {
  return (snapshot?.d1Team ?? []).map((member) => ({
    key: member.userId,
    userId: member.userId,
    responsibility: member.responsibility,
  }));
}

export default function EightDWorkspace({
  organizationId,
  siteId,
  eventId,
  initialEightD,
  capa,
  members,
}: Props) {
  const router = useRouter();
  const [eightD, setEightD] = useState(initialEightD);
  const [team, setTeam] = useState<EditableTeamMember[]>(() => editableTeam(initialEightD));
  const [problemStatement, setProblemStatement] = useState(initialEightD?.d2ProblemStatement ?? "");
  const [impactScope, setImpactScope] = useState(initialEightD?.d2ImpactScope ?? "");
  const [escapePoint, setEscapePoint] = useState(initialEightD?.d4EscapePointDraft ?? "");
  const [validationNote, setValidationNote] = useState(initialEightD?.d6ValidationNoteDraft ?? "");
  const [preventionSummary, setPreventionSummary] = useState(initialEightD?.d7PreventionSummary ?? "");
  const [systemicChanges, setSystemicChanges] = useState((initialEightD?.d7SystemicChanges ?? []).join("\n"));
  const [recognitionNote, setRecognitionNote] = useState(initialEightD?.d8RecognitionNote ?? "");
  const [lessonsLearned, setLessonsLearned] = useState(initialEightD?.d8LessonsLearned ?? "");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const completedIndex = useMemo(() => {
    if (!eightD) return -1;
    if (eightD.status === "COMPLETED") return 7;
    return Math.max(DISCIPLINES.findIndex((discipline) => discipline.id === eightD.currentDiscipline) - 1, -1);
  }, [eightD]);

  const ineffectiveCapa =
    capa?.status === "DRAFT" && capa.effectivenessChecks.at(-1)?.result === "INEFFECTIVE";
  const editable = eightD?.status !== "COMPLETED";
  const currentDiscipline: EightDDiscipline = eightD?.currentDiscipline ?? "D1";
  const canEdit = (discipline: EightDDiscipline) => editable && currentDiscipline === discipline;
  const hasEditableFields = currentDiscipline !== "D3" && currentDiscipline !== "D5";

  async function request(method: "PUT" | "PATCH", payload: Record<string, unknown>) {
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch(`/api/quality/events/${eventId}/eight-d`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId, siteId, ...payload }),
      });
      const body = (await response.json()) as { data?: EightDSnapshot; error?: { message?: string } };
      if (!response.ok || !body.data) throw new Error(body.error?.message ?? "8D update failed");
      setEightD(body.data);
      setTeam(editableTeam(body.data));
      setProblemStatement(body.data.d2ProblemStatement);
      setImpactScope(body.data.d2ImpactScope);
      setEscapePoint(body.data.d4EscapePointDraft);
      setValidationNote(body.data.d6ValidationNoteDraft);
      setPreventionSummary(body.data.d7PreventionSummary);
      setSystemicChanges(body.data.d7SystemicChanges.join("\n"));
      setRecognitionNote(body.data.d8RecognitionNote);
      setLessonsLearned(body.data.d8LessonsLearned);
      setFeedback("8D updated.");
      router.refresh();
      return body.data;
    } catch (error) {
      setFeedback(error instanceof Error ? `Error: ${error.message}` : "Error: 8D update failed");
      return null;
    } finally {
      setBusy(false);
    }
  }

  function addTeamMember() {
    setTeam((current) => [
      ...current,
      { key: crypto.randomUUID(), userId: members[0]?.id ?? "", responsibility: "" },
    ]);
  }

  function updateTeamMember(key: string, field: "userId" | "responsibility", value: string) {
    setTeam((current) =>
      current.map((member) => (member.key === key ? { ...member, [field]: value } : member)),
    );
  }

  function currentPayload(): Record<string, unknown> {
    switch (currentDiscipline) {
      case "D1":
        return { team: team.map(({ userId, responsibility }) => ({ userId, responsibility })) };
      case "D2":
        return { problemStatement, impactScope };
      case "D4":
        return { escapePoint };
      case "D6":
        return { validationNote };
      case "D7":
        return {
          preventionSummary,
          systemicChanges: systemicChanges
            .split("\n")
            .map((value) => value.trim())
            .filter(Boolean),
        };
      case "D8":
        return { recognitionNote, lessonsLearned };
      case "D3":
      case "D5":
        return {};
    }
  }

  async function save() {
    if (!hasEditableFields) return eightD;
    return request("PUT", currentPayload());
  }

  async function advance() {
    if (hasEditableFields) {
      const saved = await save();
      if (!saved) return;
    }
    await request("PATCH", { action: "ADVANCE" });
  }

  const inputStyle = {
    width: "100%",
    padding: "10px 12px",
    border: "1px solid #d1d5db",
    borderRadius: 8,
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
        <h2>8D progress</h2>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {DISCIPLINES.map((discipline, index) => (
            <span className="badge" key={discipline.id}>
              {index <= completedIndex ? "✓ " : eightD?.currentDiscipline === discipline.id ? "→ " : ""}
              {discipline.id} · {discipline.label}
            </span>
          ))}
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Completed disciplines are locked. Their frozen evidence remains visible but cannot be rewritten by later steps.
        </p>
      </section>

      <section className="card">
        <div className="header asset-header" style={{ marginBottom: 12 }}>
          <div>
            <h2 style={{ margin: 0 }}>D1 · Establish the team</h2>
            <div className="muted">Freeze accountable participants and responsibilities in the 8D record.</div>
          </div>
          {canEdit("D1") ? <button type="button" onClick={addTeamMember} style={buttonStyle}>+ Team member</button> : null}
        </div>
        <div className="grid" style={{ gap: 10 }}>
          {team.map((member) => (
            <div className="grid grid-2" style={{ gap: 10 }} key={member.key}>
              <select
                value={member.userId}
                onChange={(event) => updateTeamMember(member.key, "userId", event.target.value)}
                disabled={!canEdit("D1") || busy}
                style={{ ...inputStyle, background: canEdit("D1") ? "white" : "#f9fafb" }}
              >
                <option value="">Select member</option>
                {members.map((option) => <option key={option.id} value={option.id}>{option.name} · {option.role}</option>)}
              </select>
              <input
                value={member.responsibility}
                onChange={(event) => updateTeamMember(member.key, "responsibility", event.target.value)}
                disabled={!canEdit("D1") || busy}
                placeholder="Responsibility in the 8D"
                style={{ ...inputStyle, background: canEdit("D1") ? "white" : "#f9fafb" }}
              />
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>D2 · Describe the problem</h2>
        <textarea value={problemStatement} onChange={(event) => setProblemStatement(event.target.value)} disabled={!canEdit("D2") || busy} rows={3} placeholder="Specific, observable problem statement" style={{ ...inputStyle, resize: "vertical", background: canEdit("D2") ? "white" : "#f9fafb" }} />
        <textarea value={impactScope} onChange={(event) => setImpactScope(event.target.value)} disabled={!canEdit("D2") || busy} rows={2} placeholder="Impact / scope / affected population" style={{ ...inputStyle, resize: "vertical", marginTop: 10, background: canEdit("D2") ? "white" : "#f9fafb" }} />
      </section>

      <section className="card">
        <h2>D3 · Interim containment</h2>
        {eightD?.d3Containment ? (
          <p>{eightD.d3Containment.summary} <span className="muted">· completed {eightD.d3Containment.completedAt.slice(0, 16).replace("T", " ")} UTC</span></p>
        ) : <p className="muted">This gate reads the completed immediate containment from the quality event.</p>}
      </section>

      <section className="card">
        <h2>D4 · Root cause & escape point</h2>
        {eightD?.d4RootCause ? <p><strong>Root cause:</strong> {eightD.d4RootCause.summary}</p> : <p className="muted">This gate requires a confirmed RCA.</p>}
        <textarea value={escapePoint} onChange={(event) => setEscapePoint(event.target.value)} disabled={!canEdit("D4") || busy} rows={2} placeholder="Where and why did the detection/control system allow the issue to escape?" style={{ ...inputStyle, resize: "vertical", background: canEdit("D4") ? "white" : "#f9fafb" }} />
      </section>

      <section className="card">
        <h2>D5 · Permanent corrective actions</h2>
        {eightD?.d5Actions.length ? (
          <div className="stack-list">
            {eightD.d5Actions.map((action) => (
              <div key={action.id}><strong>{action.type}</strong> · {action.title}<span className="muted"> · {action.ownerName} · due {action.dueAt.slice(0, 10)}</span></div>
            ))}
          </div>
        ) : <p className="muted">This gate freezes the approved CAPA actions.</p>}
      </section>

      <section className="card">
        <h2>D6 · Implement & validate</h2>
        <textarea value={validationNote} onChange={(event) => setValidationNote(event.target.value)} disabled={!canEdit("D6") || busy} rows={3} placeholder="Objective validation evidence for the implemented corrective actions" style={{ ...inputStyle, resize: "vertical", background: canEdit("D6") ? "white" : "#f9fafb" }} />
        {eightD?.d6Implementation ? <p className="muted">Validated: {eightD.d6Implementation.validationNote}</p> : null}
      </section>

      <section className="card">
        <h2>D7 · Prevent recurrence</h2>
        <textarea value={preventionSummary} onChange={(event) => setPreventionSummary(event.target.value)} disabled={!canEdit("D7") || busy} rows={3} placeholder="How recurrence is prevented systemically" style={{ ...inputStyle, resize: "vertical", background: canEdit("D7") ? "white" : "#f9fafb" }} />
        <textarea value={systemicChanges} onChange={(event) => setSystemicChanges(event.target.value)} disabled={!canEdit("D7") || busy} rows={3} placeholder="One systemic change per line" style={{ ...inputStyle, resize: "vertical", marginTop: 10, background: canEdit("D7") ? "white" : "#f9fafb" }} />
      </section>

      <section className="card">
        <h2>D8 · Close & recognize</h2>
        <textarea value={recognitionNote} onChange={(event) => setRecognitionNote(event.target.value)} disabled={!canEdit("D8") || busy} rows={2} placeholder="Team recognition / closure note" style={{ ...inputStyle, resize: "vertical", background: canEdit("D8") ? "white" : "#f9fafb" }} />
        <textarea value={lessonsLearned} onChange={(event) => setLessonsLearned(event.target.value)} disabled={!canEdit("D8") || busy} rows={3} placeholder="Lessons learned and knowledge to retain" style={{ ...inputStyle, resize: "vertical", marginTop: 10, background: canEdit("D8") ? "white" : "#f9fafb" }} />
      </section>

      <section className="card">
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {editable && hasEditableFields ? <button type="button" disabled={busy} onClick={save} style={buttonStyle}>Save {currentDiscipline}</button> : null}
          {editable ? <button type="button" disabled={busy} onClick={advance} style={buttonStyle}>Complete {currentDiscipline} →</button> : null}
          {ineffectiveCapa && eightD && eightD.status !== "COMPLETED" ? (
            <button type="button" disabled={busy} onClick={() => request("PATCH", { action: "RESET_AFTER_INEFFECTIVE_CAPA" })} style={buttonStyle}>
              Return 8D to D5 for revised CAPA
            </button>
          ) : null}
        </div>
        {feedback ? <p role="status" style={{ marginBottom: 0 }}>{feedback}</p> : null}
      </section>
    </div>
  );
}
