"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { EightDDiscipline, EightDSnapshot } from "@/lib/quality/eight-d";

type MemberOption = { id: string; name: string; role: string };
type EditableTeamMember = { key: string; userId: string; responsibility: string };

type Props = {
  organizationId: string;
  siteId: string;
  eventId: string;
  eventStatus: "OPEN" | "CONTAINED" | "INVESTIGATING" | "CLOSED";
  initialEightD: EightDSnapshot | null;
  members: MemberOption[];
};

const disciplineInfo: Record<EightDDiscipline, { title: string; description: string }> = {
  D1: { title: "D1 · Build the team", description: "Define accountable team members and their responsibilities." },
  D2: { title: "D2 · Describe the problem", description: "Write a precise problem statement for the team." },
  D3: { title: "D3 · Contain the problem", description: "Requires completed immediate containment on the quality event." },
  D4: { title: "D4 · Confirm root cause", description: "Requires a confirmed root-cause analysis." },
  D5: { title: "D5 · Select permanent actions", description: "Freezes the approved CAPA actions and accountable owners into the 8D record." },
  D6: { title: "D6 · Implement and validate", description: "Requires every CAPA action complete and effectiveness confirmed." },
  D7: { title: "D7 · Prevent recurrence", description: "Record systemic changes that prevent similar failures elsewhere." },
  D8: { title: "D8 · Close and recognize", description: "Capture the closure and team-recognition note before completing 8D." },
};

function initialTeam(eightD: EightDSnapshot | null): EditableTeamMember[] {
  return (eightD?.d1Team ?? []).map((member) => ({
    key: member.userId,
    userId: member.userId,
    responsibility: member.responsibility,
  }));
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
  const [team, setTeam] = useState<EditableTeamMember[]>(() => initialTeam(initialEightD));
  const [problemStatement, setProblemStatement] = useState(initialEightD?.d2ProblemStatement ?? "");
  const [preventionSummary, setPreventionSummary] = useState(initialEightD?.d7PreventionSummary ?? "");
  const [systemicChanges, setSystemicChanges] = useState((initialEightD?.d7SystemicChanges ?? []).join("\n"));
  const [recognitionNote, setRecognitionNote] = useState(initialEightD?.d8RecognitionNote ?? "");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "error" | "success"; message: string } | null>(null);

  const discipline = eightD?.currentDiscipline ?? "D1";
  const completed = eightD?.status === "COMPLETED";
  const canWork = eventStatus === "INVESTIGATING" && !completed;
  const memberNames = useMemo(() => new Map(members.map((member) => [member.id, member.name])), [members]);

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
        error?: { message?: string };
      };
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? "8D update failed");
      }
      setEightD(body.data);
      setProblemStatement(body.data.d2ProblemStatement);
      setPreventionSummary(body.data.d7PreventionSummary);
      setSystemicChanges(body.data.d7SystemicChanges.join("\n"));
      setRecognitionNote(body.data.d8RecognitionNote);
      setTeam(initialTeam(body.data));
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
    const defaultMember = members.find((member) => !team.some((item) => item.userId === member.id));
    setTeam((current) => [
      ...current,
      { key: crypto.randomUUID(), userId: defaultMember?.id ?? members[0]?.id ?? "", responsibility: "" },
    ]);
  }

  function updateTeamMember(key: string, field: "userId" | "responsibility", value: string) {
    setTeam((current) => current.map((member) => member.key === key ? { ...member, [field]: value } : member));
  }

  async function saveCurrent() {
    if (discipline === "D1") {
      return request("PUT", {
        team: team.map((member) => ({ userId: member.userId, responsibility: member.responsibility })),
      });
    }
    if (discipline === "D2") return request("PUT", { problemStatement });
    if (discipline === "D7") {
      return request("PUT", {
        preventionSummary,
        systemicChanges: systemicChanges.split("\n").map((value) => value.trim()).filter(Boolean),
      });
    }
    if (discipline === "D8") return request("PUT", { recognitionNote });
    return eightD;
  }

  async function advance() {
    const saved = await saveCurrent();
    if (!saved) return;
    await request("PATCH", { action: "ADVANCE" });
  }

  const inputStyle = {
    width: "100%",
    padding: "10px 12px",
    border: "1px solid #d1d5db",
    borderRadius: 8,
    background: canWork ? "white" : "#f9fafb",
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
        <div className="header asset-header" style={{ marginBottom: 12 }}>
          <div>
            <h2 style={{ margin: 0 }}>{disciplineInfo[discipline].title}</h2>
            <div className="muted">{disciplineInfo[discipline].description}</div>
          </div>
          <div className="asset-status">
            <span className="badge">{eightD?.status ?? "NOT STARTED"}</span>
            <span className="badge">{discipline}</span>
          </div>
        </div>
        {eventStatus !== "INVESTIGATING" && !completed ? (
          <p className="muted">Start the quality-event investigation before editing or advancing 8D.</p>
        ) : null}
        {completed ? <p><strong>8D completed.</strong> The record is immutable and remains available as historical evidence.</p> : null}
      </section>

      {discipline === "D1" ? (
        <section className="card">
          <div className="header" style={{ marginBottom: 12 }}>
            <div><h2 style={{ margin: 0 }}>Team</h2><div className="muted">Each member needs a clear responsibility.</div></div>
            <button type="button" onClick={addTeamMember} disabled={!canWork || busy} style={buttonStyle}>Add member</button>
          </div>
          <div className="grid" style={{ gap: 10 }}>
            {team.map((member) => (
              <div key={member.key} style={{ display: "grid", gridTemplateColumns: "minmax(180px, 1fr) 2fr auto", gap: 10 }}>
                <select value={member.userId} onChange={(event) => updateTeamMember(member.key, "userId", event.target.value)} disabled={!canWork || busy} style={inputStyle}>
                  <option value="">Select member</option>
                  {members.map((option) => <option key={option.id} value={option.id}>{option.name} · {option.role}</option>)}
                </select>
                <input value={member.responsibility} onChange={(event) => updateTeamMember(member.key, "responsibility", event.target.value)} disabled={!canWork || busy} style={inputStyle} placeholder="Responsibility in the 8D team" />
                <button type="button" onClick={() => setTeam((current) => current.filter((item) => item.key !== member.key))} disabled={!canWork || busy} style={buttonStyle}>Remove</button>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {discipline === "D2" ? (
        <section className="card">
          <h2>Problem statement</h2>
          <textarea value={problemStatement} onChange={(event) => setProblemStatement(event.target.value)} disabled={!canWork || busy} rows={5} style={{ ...inputStyle, resize: "vertical" }} placeholder="What failed, where, when, how much and with what impact?" />
        </section>
      ) : null}

      {discipline === "D7" ? (
        <section className="card">
          <h2>Prevent recurrence</h2>
          <label><strong>Prevention summary</strong><textarea value={preventionSummary} onChange={(event) => setPreventionSummary(event.target.value)} disabled={!canWork || busy} rows={4} style={{ ...inputStyle, marginTop: 6, resize: "vertical" }} /></label>
          <label style={{ display: "block", marginTop: 14 }}><strong>Systemic changes</strong><textarea value={systemicChanges} onChange={(event) => setSystemicChanges(event.target.value)} disabled={!canWork || busy} rows={6} style={{ ...inputStyle, marginTop: 6, resize: "vertical" }} placeholder="One systemic change per line" /></label>
        </section>
      ) : null}

      {discipline === "D8" ? (
        <section className="card">
          <h2>Closure and recognition</h2>
          <textarea value={recognitionNote} onChange={(event) => setRecognitionNote(event.target.value)} disabled={!canWork || busy} rows={5} style={{ ...inputStyle, resize: "vertical" }} placeholder="Summarize closure, lessons learned and recognize the team contribution." />
        </section>
      ) : null}

      {eightD ? (
        <section className="card">
          <h2>Frozen evidence from completed disciplines</h2>
          <dl className="detail-list">
            <div><dt>D1 team</dt><dd>{eightD.d1Team.map((member) => `${member.displayName} — ${member.responsibility}`).join(", ") || "—"}</dd></div>
            <div><dt>D2 problem</dt><dd>{eightD.d2ProblemStatement || "—"}</dd></div>
            <div><dt>D3 containment</dt><dd>{eightD.d3Containment?.summary ?? "—"}</dd></div>
            <div><dt>D4 root cause</dt><dd>{eightD.d4RootCause?.summary ?? "—"}</dd></div>
            <div><dt>D5 CAPA actions</dt><dd>{eightD.d5Actions.map((action) => `${action.title} — ${action.ownerName}`).join(", ") || "—"}</dd></div>
            <div><dt>D6 effectiveness</dt><dd>{eightD.d6Implementation?.effectivenessNote ?? "—"}</dd></div>
            <div><dt>D7 prevention</dt><dd>{eightD.d7PreventionSummary || "—"}</dd></div>
            <div><dt>D8 recognition</dt><dd>{eightD.d8RecognitionNote || "—"}</dd></div>
          </dl>
        </section>
      ) : null}

      {feedback ? (
        <p role="status" style={{ fontWeight: 600, color: feedback.kind === "error" ? "#991b1b" : "#166534" }}>{feedback.message}</p>
      ) : null}

      {!completed ? (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {(discipline === "D1" || discipline === "D2" || discipline === "D7" || discipline === "D8") ? (
            <button type="button" onClick={() => void saveCurrent()} disabled={!canWork || busy} style={buttonStyle}>{busy ? "Saving…" : "Save"}</button>
          ) : null}
          <button type="button" onClick={() => void advance()} disabled={!canWork || busy} style={{ ...buttonStyle, background: "#111827", color: "white", borderColor: "#111827" }}>
            {discipline === "D8" ? "Complete 8D" : `Complete ${discipline} →`}
          </button>
        </div>
      ) : null}

      {eightD?.d1Team.length ? (
        <p className="muted">Team snapshot: {eightD.d1Team.map((member) => memberNames.get(member.userId) ?? member.displayName).join(", ")}</p>
      ) : null}
    </div>
  );
}
