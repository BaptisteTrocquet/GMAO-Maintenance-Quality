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
  mimeType: string | null;
  sizeBytes: number;
  checksum: string;
  description: string | null;
  actorName?: string;
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
const MAX_FILE_BYTES = 20 * 1024 * 1024;

function formatDate(value: string) {
  return `${value.replace("T", " ").slice(0, 16)} UTC`;
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
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
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setFeedback({ kind: "error", message: "Evidence files are limited to 20 MiB." });
      return;
    }

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
        data?: EvidenceItem;
        error?: { message?: string };
      };
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? "Evidence upload failed");
      }

      setEvidence((current) => [
        { ...body.data!, actorName: body.data!.actorName ?? "Current user" },
        ...current,
      ]);
      setFile(null);
      setDescription("");
      const input = document.getElementById("quality-evidence-file") as HTMLInputElement | null;
      if (input) input.value = "";
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
                  <th>Evidence</th>
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
                      <a
                        className="table-link"
                        href={`/api/quality/events/${eventId}/evidence/${item.id}?organizationId=${encodeURIComponent(organizationId)}&siteId=${encodeURIComponent(siteId)}`}
                      >
                        {item.fileName}
                      </a>
                      <div className="muted">
                        {formatSize(item.sizeBytes)} · SHA-256 {item.checksum.slice(0, 12)}…
                      </div>
                    </td>
                    <td>{item.description ?? "—"}</td>
                    <td>{item.actorName ?? "System"}</td>
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
        <h2>Attach evidence</h2>
        <p className="muted">
          Files are stored by the configured storage adapter, SHA-256 checksummed, and linked to the immutable quality audit trail. Maximum size: 20 MiB.
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
                id="quality-evidence-file"
                type="file"
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
                style={{
                  border: "1px solid #111827",
                  borderRadius: 8,
                  padding: "9px 14px",
                  background: "#111827",
                  color: "white",
                  cursor: "pointer",
                }}
              >
                {busy ? "Uploading…" : "Upload evidence"}
              </button>
            </div>
          </div>
        )}
        {feedback ? (
          <p
            role="status"
            style={{ fontWeight: 600, color: feedback.kind === "error" ? "#991b1b" : "#166534" }}
          >
            {feedback.message}
          </p>
        ) : null}
      </section>
    </div>
  );
}
