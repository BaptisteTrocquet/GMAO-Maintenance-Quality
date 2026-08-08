"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type EvidenceItem = {
  id: string;
  fileName: string;
  mimeType: string | null;
  sizeBytes: number;
  checksum: string;
  kind: string;
  description: string | null;
  createdAt: string;
  uploaderName: string;
};

type Props = {
  organizationId: string;
  siteId: string;
  eventId: string;
  eventStatus: "OPEN" | "CONTAINED" | "INVESTIGATING" | "CLOSED";
  initialEvidence: EvidenceItem[];
};

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

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
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const closed = eventStatus === "CLOSED";

  async function upload(formData: FormData) {
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch(
        `/api/quality/events/${eventId}/evidence?organizationId=${encodeURIComponent(organizationId)}&siteId=${encodeURIComponent(siteId)}`,
        { method: "POST", body: formData },
      );
      const body = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) {
        throw new Error(body.error?.message ?? "Evidence upload failed");
      }
      setFeedback({ kind: "success", message: "Evidence attached and checksum recorded." });
      router.refresh();
    } catch (error) {
      setFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : "Evidence upload failed",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid" style={{ gap: 18 }}>
      <section className="card">
        <div className="header" style={{ marginBottom: 12 }}>
          <div>
            <h2 style={{ margin: 0 }}>Evidence files</h2>
            <div className="muted">
              Immutable file references with SHA-256 integrity verification.
            </div>
          </div>
          <span className="badge">{initialEvidence.length} file{initialEvidence.length === 1 ? "" : "s"}</span>
        </div>

        {initialEvidence.length ? (
          <div className="responsive-table">
            <table className="table">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Kind</th>
                  <th>Uploaded by</th>
                  <th>Uploaded</th>
                  <th>Size</th>
                  <th>Checksum</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {initialEvidence.map((evidence) => (
                  <tr key={evidence.id}>
                    <td>
                      <strong>{evidence.fileName}</strong>
                      {evidence.description ? <div className="muted">{evidence.description}</div> : null}
                    </td>
                    <td>{evidence.kind}</td>
                    <td>{evidence.uploaderName}</td>
                    <td>{formatDate(evidence.createdAt)}</td>
                    <td>{formatBytes(evidence.sizeBytes)}</td>
                    <td title={evidence.checksum}><code>{evidence.checksum.slice(0, 12)}…</code></td>
                    <td>
                      <a
                        className="table-link"
                        href={`/api/quality/events/${eventId}/evidence/${evidence.id}/file?organizationId=${encodeURIComponent(organizationId)}&siteId=${encodeURIComponent(siteId)}`}
                      >
                        Download
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">No evidence file has been attached to this event.</p>
        )}
      </section>

      <section className="card">
        <h2>Attach evidence</h2>
        {closed ? (
          <p className="muted">
            This quality event is closed. Existing evidence remains readable, but new evidence cannot be attached.
          </p>
        ) : (
          <form
            action={async (formData) => {
              await upload(formData);
            }}
            className="grid grid-2"
          >
            <label style={{ gridColumn: "1 / -1" }}>
              <strong>File</strong>
              <input name="file" type="file" required disabled={busy} style={{ display: "block", marginTop: 8 }} />
            </label>
            <label>
              <strong>Kind</strong>
              <select name="kind" defaultValue="EVIDENCE" disabled={busy} style={{ width: "100%", marginTop: 8, padding: 9 }}>
                <option value="EVIDENCE">Evidence</option>
                <option value="PHOTO">Photo</option>
                <option value="INSPECTION">Inspection</option>
                <option value="MEASUREMENT">Measurement</option>
                <option value="REPORT">Report</option>
              </select>
            </label>
            <label style={{ gridColumn: "1 / -1" }}>
              <strong>Description</strong>
              <textarea
                name="description"
                rows={3}
                maxLength={2000}
                disabled={busy}
                placeholder="What does this file demonstrate?"
                style={{ width: "100%", marginTop: 8, padding: 10, resize: "vertical" }}
              />
            </label>
            <div style={{ gridColumn: "1 / -1" }}>
              <button type="submit" disabled={busy}>
                {busy ? "Uploading…" : "Attach evidence"}
              </button>
            </div>
          </form>
        )}

        {feedback ? (
          <p
            role="status"
            style={{
              marginBottom: 0,
              fontWeight: 600,
              color: feedback.kind === "error" ? "#991b1b" : "#166534",
            }}
          >
            {feedback.message}
          </p>
        ) : null}
      </section>
    </div>
  );
}
