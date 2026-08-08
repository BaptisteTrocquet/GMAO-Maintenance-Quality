"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type {
  QualityEvidenceKind,
  QualityEvidencePhase,
} from "@/lib/quality/evidence";

type EvidenceItem = {
  id: string;
  phase: QualityEvidencePhase;
  kind: QualityEvidenceKind;
  fileName: string;
  storageKey: string;
  mimeType: string | null;
  sizeBytes: number | null;
  description: string | null;
  actorName: string;
  createdAt: string;
};

type Props = {
  organizationId: string;
  siteId: string;
  eventId: string;
  eventStatus: string;
  initialEvidence: EvidenceItem[];
};

const phases: QualityEvidencePhase[] = [
  "EVENT",
  "CONTAINMENT",
  "ROOT_CAUSE",
  "CAPA",
  "EFFECTIVENESS",
];
const kinds: QualityEvidenceKind[] = ["DOCUMENT", "PHOTO", "RECORD"];

function formatDate(value: string) {
  return `${value.replace("T", " ").slice(0, 16)} UTC`;
}

export default function EvidenceWorkspace({
  organizationId,
  siteId,
  eventId,
  eventStatus,
  initialEvidence,
}: Props) {
  const router = useRouter();
  const [evidence, setEvidence] = useState(initialEvidence);
  const [phase, setPhase] = useState<QualityEvidencePhase>("EVENT");
  const [kind, setKind] = useState<QualityEvidenceKind>("DOCUMENT");
  const [fileName, setFileName] = useState("");
  const [storageKey, setStorageKey] = useState("");
  const [mimeType, setMimeType] = useState("");
  const [sizeBytes, setSizeBytes] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; message: string } | null>(null);

  const closed = eventStatus === "CLOSED";
  const controlStyle = {
    width: "100%",
    padding: "9px 11px",
    border: "1px solid #d1d5db",
    borderRadius: 8,
    background: "white",
  } as const;

  async function submit() {
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch(`/api/quality/events/${eventId}/evidence`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId,
          siteId,
          phase,
          kind,
          fileName,
          storageKey,
          mimeType: mimeType.trim() || null,
          sizeBytes: sizeBytes ? Number(sizeBytes) : null,
          description: description.trim() || null,
        }),
      });
      const body = (await response.json()) as {
        data?: EvidenceItem;
        error?: { message?: string };
      };
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? "Evidence attachment failed");
      }
      setEvidence((current) => [{ ...body.data!, actorName: body.data!.actorName ?? "Current user" }, ...current]);
      setFileName("");
      setStorageKey("");
      setMimeType("");
      setSizeBytes("");
      setDescription("");
      setFeedback({ kind: "success", message: "Evidence reference attached and audited." });
      router.refresh();
    } catch (error) {
      setFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : "Evidence attachment failed",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid" style={{ gap: 18 }}>
      <section className="card">
        <h2>Evidence register</h2>
        {evidence.length ? (
          <div className="responsive-table">
            <table className="table">
              <thead>
                <tr>
                  <th>Phase</th>
                  <th>Type</th>
                  <th>File</th>
                  <th>Description</th>
                  <th>Added by</th>
                  <th>Added</th>
                </tr>
              </thead>
              <tbody>
                {evidence.map((item) => (
                  <tr key={item.id}>
                    <td><span className="badge">{item.phase}</span></td>
                    <td>{item.kind}</td>
                    <td>
                      <strong>{item.fileName}</strong>
                      <div className="muted">{item.storageKey}</div>
                    </td>
                    <td>{item.description ?? "—"}</td>
                    <td>{item.actorName}</td>
                    <td>{formatDate(item.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">No evidence attachments recorded yet.</p>
        )}
      </section>

      <section className="card">
        <h2>Attach evidence reference</h2>
        <p className="muted">
          Store the file through the configured storage workflow, then register its immutable storage key here.
        </p>
        {closed ? (
          <p className="muted">This quality event is closed; its evidence register is read-only.</p>
        ) : (
          <div className="grid grid-2">
            <label>
              <strong>Phase</strong>
              <select value={phase} onChange={(event) => setPhase(event.target.value as QualityEvidencePhase)} style={{ ...controlStyle, marginTop: 6 }}>
                {phases.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <label>
              <strong>Evidence type</strong>
              <select value={kind} onChange={(event) => setKind(event.target.value as QualityEvidenceKind)} style={{ ...controlStyle, marginTop: 6 }}>
                {kinds.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <label>
              <strong>File name</strong>
              <input value={fileName} onChange={(event) => setFileName(event.target.value)} style={{ ...controlStyle, marginTop: 6 }} placeholder="inspection-photo.jpg" />
            </label>
            <label>
              <strong>Storage key</strong>
              <input value={storageKey} onChange={(event) => setStorageKey(event.target.value)} style={{ ...controlStyle, marginTop: 6 }} placeholder="quality/event-id/inspection-photo.jpg" />
            </label>
            <label>
              <strong>MIME type</strong>
              <input value={mimeType} onChange={(event) => setMimeType(event.target.value)} style={{ ...controlStyle, marginTop: 6 }} placeholder="image/jpeg" />
            </label>
            <label>
              <strong>Size (bytes)</strong>
              <input type="number" min="0" value={sizeBytes} onChange={(event) => setSizeBytes(event.target.value)} style={{ ...controlStyle, marginTop: 6 }} />
            </label>
            <label style={{ gridColumn: "1 / -1" }}>
              <strong>Description</strong>
              <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} style={{ ...controlStyle, marginTop: 6, resize: "vertical" }} placeholder="What this evidence demonstrates" />
            </label>
            <div style={{ gridColumn: "1 / -1" }}>
              <button
                type="button"
                onClick={submit}
                disabled={busy || !fileName.trim() || !storageKey.trim()}
                style={{ border: "1px solid #111827", borderRadius: 8, padding: "9px 14px", background: "#111827", color: "white", cursor: "pointer" }}
              >
                Attach evidence
              </button>
            </div>
          </div>
        )}
        {feedback ? (
          <p role="status" style={{ fontWeight: 600, color: feedback.kind === "error" ? "#991b1b" : "#166534" }}>
            {feedback.message}
          </p>
        ) : null}
      </section>
    </div>
  );
}
