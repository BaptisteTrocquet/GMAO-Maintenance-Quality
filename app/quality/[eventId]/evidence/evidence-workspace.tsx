"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { QualityEvidenceCategory, QualityEvidenceSnapshot } from "@/lib/quality/evidence";

type Props = {
  organizationId: string;
  siteId: string;
  eventId: string;
  eventStatus: string;
  initialEvidence: QualityEvidenceSnapshot[];
};

const categories: QualityEvidenceCategory[] = [
  "CONTAINMENT",
  "ROOT_CAUSE",
  "CAPA_ACTION",
  "EFFECTIVENESS",
  "EIGHT_D",
  "OTHER",
];

const mimeTypes = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/plain",
];

export default function EvidenceWorkspace({
  organizationId,
  siteId,
  eventId,
  eventStatus,
  initialEvidence,
}: Props) {
  const router = useRouter();
  const [evidence, setEvidence] = useState(initialEvidence);
  const [category, setCategory] = useState<QualityEvidenceCategory>("OTHER");
  const [relatedActionId, setRelatedActionId] = useState("");
  const [fileName, setFileName] = useState("");
  const [storageKey, setStorageKey] = useState("");
  const [mimeType, setMimeType] = useState("application/pdf");
  const [sizeBytes, setSizeBytes] = useState(0);
  const [note, setNote] = useState("");
  const [revokeReasons, setRevokeReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "error" | "success"; message: string } | null>(null);

  const mutable = eventStatus !== "CLOSED";

  async function registerEvidence() {
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch(`/api/quality/events/${eventId}/evidence`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId,
          siteId,
          category,
          relatedActionId: relatedActionId.trim() || null,
          fileName,
          storageKey,
          mimeType,
          sizeBytes,
          note: note.trim() || null,
        }),
      });
      const body = (await response.json()) as {
        data?: QualityEvidenceSnapshot;
        error?: { message?: string };
      };
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? "Evidence registration failed");
      }
      setEvidence((current) => [body.data!, ...current]);
      setRelatedActionId("");
      setFileName("");
      setStorageKey("");
      setSizeBytes(0);
      setNote("");
      setFeedback({ kind: "success", message: "Evidence registered." });
      router.refresh();
    } catch (error) {
      setFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : "Evidence registration failed",
      });
    } finally {
      setBusy(false);
    }
  }

  async function revokeEvidence(evidenceId: string) {
    const reason = revokeReasons[evidenceId]?.trim();
    if (!reason) return;
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch(`/api/quality/events/${eventId}/evidence/${evidenceId}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId, siteId, reason }),
      });
      const body = (await response.json()) as {
        data?: QualityEvidenceSnapshot;
        error?: { message?: string };
      };
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? "Evidence revocation failed");
      }
      setEvidence((current) =>
        current.map((item) => (item.evidenceId === evidenceId ? body.data! : item)),
      );
      setFeedback({ kind: "success", message: "Evidence revoked; audit history preserved." });
      router.refresh();
    } catch (error) {
      setFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : "Evidence revocation failed",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="card">
        <h2>Evidence registry</h2>
        <p className="muted">
          This registers files already persisted by the configured storage adapter. Evidence history is immutable;
          incorrect records are revoked rather than deleted.
        </p>
        {evidence.length ? (
          <div className="responsive-table">
            <table className="table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Category</th>
                  <th>File</th>
                  <th>Type / size</th>
                  <th>Related action</th>
                  <th>Note</th>
                  <th>Storage key</th>
                </tr>
              </thead>
              <tbody>
                {evidence.map((item) => (
                  <tr key={item.evidenceId}>
                    <td><span className="badge">{item.active ? "ACTIVE" : "REVOKED"}</span></td>
                    <td>{item.category}</td>
                    <td>{item.fileName}</td>
                    <td>{item.mimeType} · {item.sizeBytes} B</td>
                    <td>{item.relatedActionId ?? "—"}</td>
                    <td>{item.active ? item.note ?? "—" : item.revokeReason ?? "Revoked"}</td>
                    <td><code>{item.storageKey}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">No evidence registered.</p>
        )}
      </section>

      {mutable ? (
        <div className="grid grid-2 section">
          <section className="card">
            <h2>Register evidence</h2>
            <label className="field">
              <span>Category</span>
              <select value={category} onChange={(event) => setCategory(event.target.value as QualityEvidenceCategory)} disabled={busy}>
                {categories.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Related CAPA/action ID (optional)</span>
              <input value={relatedActionId} onChange={(event) => setRelatedActionId(event.target.value)} disabled={busy} />
            </label>
            <label className="field">
              <span>File name</span>
              <input value={fileName} onChange={(event) => setFileName(event.target.value)} disabled={busy} />
            </label>
            <label className="field">
              <span>Storage key</span>
              <input value={storageKey} onChange={(event) => setStorageKey(event.target.value)} disabled={busy} />
            </label>
            <label className="field">
              <span>MIME type</span>
              <select value={mimeType} onChange={(event) => setMimeType(event.target.value)} disabled={busy}>
                {mimeTypes.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Size (bytes)</span>
              <input
                type="number"
                min={0}
                max={25 * 1024 * 1024}
                value={sizeBytes}
                onChange={(event) => setSizeBytes(Number(event.target.value))}
                disabled={busy}
              />
            </label>
            <label className="field">
              <span>Evidence note</span>
              <textarea rows={5} value={note} onChange={(event) => setNote(event.target.value)} disabled={busy} />
            </label>
            <button
              type="button"
              disabled={busy || !fileName.trim() || !storageKey.trim()}
              onClick={registerEvidence}
            >
              Register evidence
            </button>
          </section>

          <section className="card">
            <h2>Revoke incorrect evidence</h2>
            <p className="muted">Revocation preserves the original metadata and records who revoked it and why.</p>
            <div className="stack-list">
              {evidence.filter((item) => item.active).map((item) => (
                <div className="card" key={item.evidenceId}>
                  <strong>{item.fileName}</strong>
                  <div className="muted">{item.category}</div>
                  <label className="field">
                    <span>Reason</span>
                    <input
                      value={revokeReasons[item.evidenceId] ?? ""}
                      onChange={(event) => setRevokeReasons((current) => ({
                        ...current,
                        [item.evidenceId]: event.target.value,
                      }))}
                      disabled={busy}
                    />
                  </label>
                  <button
                    type="button"
                    disabled={busy || !(revokeReasons[item.evidenceId]?.trim())}
                    onClick={() => revokeEvidence(item.evidenceId)}
                  >
                    Revoke evidence
                  </button>
                </div>
              ))}
            </div>
          </section>
        </div>
      ) : (
        <section className="card section">
          <p className="muted">This quality event is closed. Evidence remains readable but cannot be changed.</p>
        </section>
      )}

      {feedback ? (
        <section className="card section">
          <strong>{feedback.kind === "error" ? "Update failed" : "Saved"}</strong>
          <p>{feedback.message}</p>
        </section>
      ) : null}
    </>
  );
}
