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
  sizeBytes: number;
  checksum: string;
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
  "EIGHT_D",
];
const kinds: QualityEvidenceKind[] = ["DOCUMENT", "PHOTO", "RECORD"];

function formatDate(value: string) {
  return `${value.replace("T", " ").slice(0, 16)} UTC`;
}

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
}: Props) {
  const router = useRouter();
  const [evidence, setEvidence] = useState(initialEvidence);
  const [phase, setPhase] = useState<QualityEvidencePhase>("EVENT");
  const [kind, setKind] = useState<QualityEvidenceKind>("DOCUMENT");
  const [file, setFile] = useState<File | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; message: string } | null>(null);

  const closed = eventStatus === "CLOSED";
  const scopeQuery = `organizationId=${encodeURIComponent(organizationId)}&siteId=${encodeURIComponent(siteId)}`;
  const controlStyle = {
    width: "100%",
    padding: "9px 11px",
    border: "1px solid #d1d5db",
    borderRadius: 8,
    background: "white",
  } as const;

  async function submit() {
    if (!file) return;
    setBusy(true);
    setFeedback(null);
    try {
      const formData = new FormData();
      formData.set("organizationId", organizationId);
      formData.set("siteId", siteId);
      formData.set("phase", phase);
      formData.set("kind", kind);
      formData.set("description", description.trim());
      formData.set("file", file);

      const response = await fetch(`/api/quality/events/${eventId}/evidence`, {
        method: "POST",
        body: formData,
      });
      const body = (await response.json()) as {
        data?: Omit<EvidenceItem, "actorName">;
        error?: { message?: string };
      };
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? "Evidence upload failed");
      }
      setEvidence((current) => [
        { ...body.data!, actorName: "Current user" },
        ...current,
      ]);
      setFile(null);
      setFileInputKey((value) => value + 1);
      setDescription("");
      setFeedback({ kind: "success", message: "Evidence uploaded, checksummed and audited." });
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

  async function removeEvidence(evidenceId: string) {
    setRemovingId(evidenceId);
    setFeedback(null);
    try {
      const response = await fetch(
        `/api/quality/events/${eventId}/evidence/${evidenceId}/file?${scopeQuery}`,
        { method: "DELETE" },
      );
      const body = (await response.json()) as {
        data?: { storageRetained?: boolean };
        error?: { message?: string };
      };
      if (!response.ok) {
        throw new Error(body.error?.message ?? "Evidence withdrawal failed");
      }
      setEvidence((current) => current.filter((item) => item.id !== evidenceId));
      setFeedback({
        kind: "success",
        message:
          body.data?.storageRetained === false
            ? "Evidence withdrawn from active use; retention state requires review."
            : "Evidence withdrawn from active use. The audited record and stored bytes are retained.",
      });
      router.refresh();
    } catch (error) {
      setFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : "Evidence withdrawal failed",
      });
    } finally {
      setRemovingId(null);
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
                  <th>Integrity</th>
                  <th>Description</th>
                  <th>Added by</th>
                  <th>Added</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {evidence.map((item) => (
                  <tr key={item.id}>
                    <td><span className="badge">{item.phase}</span></td>
                    <td>{item.kind}</td>
                    <td>
                      <strong>{item.fileName}</strong>
                      <div className="muted">{formatBytes(item.sizeBytes)}</div>
                    </td>
                    <td>
                      <span className="muted" title={item.checksum}>
                        SHA-256 {item.checksum.slice(0, 12)}…
                      </span>
                    </td>
                    <td>{item.description ?? "—"}</td>
                    <td>{item.actorName}</td>
                    <td>{formatDate(item.createdAt)}</td>
                    <td>
                      <a
                        href={`/api/quality/events/${eventId}/evidence/${item.id}/file?${scopeQuery}`}
                      >
                        Download
                      </a>
                      {!closed ? (
                        <>
                          {" · "}
                          <button
                            type="button"
                            onClick={() => removeEvidence(item.id)}
                            disabled={removingId === item.id}
                            style={{ border: 0, padding: 0, background: "transparent", textDecoration: "underline", cursor: "pointer" }}
                          >
                            {removingId === item.id ? "Withdrawing…" : "Withdraw"}
                          </button>
                        </>
                      ) : null}
                    </td>
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
        <h2>Upload evidence</h2>
        <p className="muted">
          Files are stored by the configured storage adapter, checksummed with SHA-256 and registered immutably in the quality audit trail. Withdrawn evidence remains retained for historical traceability. Maximum size: 20 MB.
        </p>
        {closed ? (
          <p className="muted">This quality event is closed; its evidence register is read-only.</p>
        ) : (
          <div className="grid grid-2">
            <label>
              <strong>Phase</strong>
              <select
                value={phase}
                onChange={(event) => setPhase(event.target.value as QualityEvidencePhase)}
                style={{ ...controlStyle, marginTop: 6 }}
              >
                {phases.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <label>
              <strong>Evidence type</strong>
              <select
                value={kind}
                onChange={(event) => setKind(event.target.value as QualityEvidenceKind)}
                style={{ ...controlStyle, marginTop: 6 }}
              >
                {kinds.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <label style={{ gridColumn: "1 / -1" }}>
              <strong>File</strong>
              <input
                key={fileInputKey}
                type="file"
                accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.csv,.docx,.xlsx,.zip"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                style={{ ...controlStyle, marginTop: 6 }}
              />
            </label>
            <label style={{ gridColumn: "1 / -1" }}>
              <strong>Description</strong>
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={3}
                style={{ ...controlStyle, marginTop: 6, resize: "vertical" }}
                placeholder="What this evidence demonstrates"
              />
            </label>
            <div style={{ gridColumn: "1 / -1" }}>
              <button
                type="button"
                onClick={submit}
                disabled={busy || !file}
                style={{ border: "1px solid #111827", borderRadius: 8, padding: "9px 14px", background: "#111827", color: "white", cursor: "pointer" }}
              >
                {busy ? "Uploading…" : "Upload evidence"}
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
