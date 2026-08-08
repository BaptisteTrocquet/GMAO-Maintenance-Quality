"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Props = {
  organizationId: string;
  siteId: string;
  eventId: string;
  eventStatus: "OPEN" | "CONTAINED" | "INVESTIGATING" | "CLOSED";
};

export default function EvidenceWorkspace({
  organizationId,
  siteId,
  eventId,
  eventStatus,
}: Props) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState("EVIDENCE");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; message: string } | null>(null);

  async function upload() {
    if (!file) {
      setFeedback({ kind: "error", message: "Select a file first." });
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("kind", kind);
      form.set("description", description);
      const response = await fetch(
        `/api/quality/events/${eventId}/evidence?organizationId=${encodeURIComponent(organizationId)}&siteId=${encodeURIComponent(siteId)}`,
        { method: "POST", body: form },
      );
      const body = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "Evidence upload failed");
      setFile(null);
      setDescription("");
      setFeedback({ kind: "success", message: "Evidence attached and checksum recorded." });
      const input = document.getElementById("quality-evidence-file") as HTMLInputElement | null;
      if (input) input.value = "";
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

  const controlStyle = {
    width: "100%",
    padding: "9px 11px",
    border: "1px solid #d1d5db",
    borderRadius: 8,
    background: "white",
  } as const;

  if (eventStatus === "CLOSED") {
    return (
      <section className="card">
        <strong>Evidence register locked</strong>
        <p className="muted" style={{ marginBottom: 0 }}>
          This quality event is closed. Existing evidence remains readable, but no new file can be attached.
        </p>
      </section>
    );
  }

  return (
    <section className="card">
      <h2>Attach evidence</h2>
      <p className="muted">Maximum file size: 20 MiB. Stored bytes are verified against the recorded SHA-256 when downloaded.</p>
      <div className="grid grid-2">
        <label>
          <strong>File</strong>
          <input
            id="quality-evidence-file"
            type="file"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            disabled={busy}
            style={{ ...controlStyle, marginTop: 6 }}
          />
        </label>
        <label>
          <strong>Kind</strong>
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value)}
            disabled={busy}
            style={{ ...controlStyle, marginTop: 6 }}
          >
            <option value="EVIDENCE">Evidence</option>
            <option value="PHOTO">Photo</option>
            <option value="REPORT">Report</option>
            <option value="INSPECTION">Inspection</option>
            <option value="CONTAINMENT">Containment</option>
            <option value="RCA">Root cause</option>
            <option value="CAPA">CAPA</option>
            <option value="EFFECTIVENESS">Effectiveness</option>
          </select>
        </label>
      </div>
      <label style={{ display: "block", marginTop: 12 }}>
        <strong>Description</strong>
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          disabled={busy}
          rows={3}
          maxLength={2000}
          style={{ ...controlStyle, marginTop: 6, resize: "vertical" }}
          placeholder="Describe what this file proves or supports."
        />
      </label>
      <button
        type="button"
        onClick={upload}
        disabled={busy || !file}
        style={{
          marginTop: 14,
          border: "1px solid #111827",
          borderRadius: 8,
          padding: "9px 14px",
          background: "#111827",
          color: "white",
          cursor: "pointer",
        }}
      >
        {busy ? "Uploading…" : "Attach evidence"}
      </button>
      {feedback ? (
        <p role="status" style={{ fontWeight: 600, color: feedback.kind === "error" ? "#991b1b" : "#166534" }}>
          {feedback.message}
        </p>
      ) : null}
    </section>
  );
}
