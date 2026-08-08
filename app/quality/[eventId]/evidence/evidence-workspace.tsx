"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const phases = ["EVENT", "CONTAINMENT", "ROOT_CAUSE", "CAPA", "EFFECTIVENESS", "EIGHT_D"] as const;
const kinds = ["DOCUMENT", "PHOTO", "RECORD"] as const;

type Evidence = {
  id: string;
  phase: string;
  kind: string;
  fileName: string;
  mimeType: string | null;
  sizeBytes: number;
  checksum: string;
  description: string | null;
  actorName: string;
  createdAt: string;
};

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export default function EvidenceWorkspace({
  organizationId,
  siteId,
  eventId,
  eventStatus,
  initialEvidence,
}: {
  organizationId: string;
  siteId: string;
  eventId: string;
  eventStatus: string;
  initialEvidence: Evidence[];
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<(typeof phases)[number]>("EVENT");
  const [kind, setKind] = useState<(typeof kinds)[number]>("DOCUMENT");
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const writable = eventStatus !== "CLOSED";

  async function upload() {
    if (!file) {
      setMessage("Select a file first.");
      return;
    }
    setPending(true);
    setMessage(null);
    try {
      const form = new FormData();
      form.set("organizationId", organizationId);
      form.set("siteId", siteId);
      form.set("phase", phase);
      form.set("kind", kind);
      form.set("description", description);
      form.set("file", file);
      const response = await fetch(`/api/quality/events/${eventId}/evidence`, {
        method: "POST",
        body: form,
      });
      const body = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "Evidence upload failed");
      setFile(null);
      setDescription("");
      setMessage("Evidence attached and checksum recorded.");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Evidence upload failed");
    } finally {
      setPending(false);
    }
  }

  async function remove(evidenceId: string) {
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/quality/events/${eventId}/evidence/${evidenceId}/file?organizationId=${encodeURIComponent(organizationId)}&siteId=${encodeURIComponent(siteId)}`,
        { method: "DELETE" },
      );
      const body = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "Evidence removal failed");
      setMessage("Evidence removed from the active record; audit history preserved.");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Evidence removal failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="grid grid-2">
      <section className="card quality-workspace">
        <h2>Attach evidence</h2>
        {!writable ? <p className="muted">Closed quality events are read-only.</p> : null}
        <label className="form-field">
          <span>Phase</span>
          <select value={phase} disabled={!writable || pending} onChange={(event) => setPhase(event.target.value as typeof phase)}>
            {phases.map((value) => <option key={value}>{value}</option>)}
          </select>
        </label>
        <label className="form-field">
          <span>Kind</span>
          <select value={kind} disabled={!writable || pending} onChange={(event) => setKind(event.target.value as typeof kind)}>
            {kinds.map((value) => <option key={value}>{value}</option>)}
          </select>
        </label>
        <label className="form-field">
          <span>Description</span>
          <textarea value={description} disabled={!writable || pending} rows={4} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <label className="form-field">
          <span>File · maximum 20 MB</span>
          <input type="file" disabled={!writable || pending} onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
        </label>
        <div className="workflow-actions">
          <button type="button" disabled={!writable || pending || !file} onClick={() => void upload()}>Attach evidence</button>
          {message ? <span className="muted" role="status">{message}</span> : null}
        </div>
      </section>

      <section className="card responsive-table">
        <h2>Evidence register</h2>
        {initialEvidence.length ? (
          <table className="table">
            <thead><tr><th>Phase</th><th>File</th><th>Integrity</th><th>Added</th><th>Actions</th></tr></thead>
            <tbody>
              {initialEvidence.map((evidence) => (
                <tr key={evidence.id}>
                  <td><span className="badge">{evidence.phase}</span><div className="muted">{evidence.kind}</div></td>
                  <td><strong>{evidence.fileName}</strong><div className="muted">{evidence.description ?? "—"} · {formatBytes(evidence.sizeBytes)}</div></td>
                  <td><code title={evidence.checksum}>SHA-256 {evidence.checksum.slice(0, 12)}…</code></td>
                  <td>{new Date(evidence.createdAt).toISOString().slice(0, 16).replace("T", " ")} UTC<div className="muted">{evidence.actorName}</div></td>
                  <td>
                    <a className="table-link" href={`/api/quality/events/${eventId}/evidence/${evidence.id}/file?organizationId=${encodeURIComponent(organizationId)}&siteId=${encodeURIComponent(siteId)}`}>Download</a>
                    {writable ? <button type="button" disabled={pending} onClick={() => void remove(evidence.id)}>Remove</button> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="muted">No evidence attached yet.</p>}
      </section>
    </div>
  );
}
