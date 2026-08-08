"use client";

import { ChangeEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  isWorkOrderPhotoMimeType,
  MAX_WORK_ORDER_PHOTO_BYTES,
} from "@/lib/work-orders/attachment-policy";

type UploadState = "idle" | "ready" | "uploading" | "success" | "error";

type UploadResponse = {
  data?: { id: string; fileName: string };
  error?: { code: string; message: string };
};

export default function WorkOrderCameraAttachments({
  organizationId,
  siteId,
  workOrderId,
  disabled = false,
}: {
  organizationId: string;
  siteId: string;
  workOrderId: string;
  disabled?: boolean;
}) {
  const router = useRouter();
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [state, setState] = useState<UploadState>("idle");
  const [message, setMessage] = useState(
    disabled ? "Photos are disabled for cancelled work orders." : "Take a photo or choose an existing image.",
  );

  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const nextUrl = URL.createObjectURL(file);
    setPreviewUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [file]);

  function resetSelection() {
    setFile(null);
    setState("idle");
    setMessage("Take a photo or choose an existing image.");
    if (cameraInputRef.current) cameraInputRef.current.value = "";
    if (galleryInputRef.current) galleryInputRef.current.value = "";
  }

  function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0] ?? null;
    if (!selected) return;

    const mimeType = selected.type.toLowerCase();
    if (!isWorkOrderPhotoMimeType(mimeType)) {
      setFile(null);
      setState("error");
      setMessage("Use a JPEG, PNG, or WebP image.");
      return;
    }
    if (selected.size === 0) {
      setFile(null);
      setState("error");
      setMessage("The selected photo is empty.");
      return;
    }
    if (selected.size > MAX_WORK_ORDER_PHOTO_BYTES) {
      setFile(null);
      setState("error");
      setMessage("Photo is too large. Maximum size is 10 MB.");
      return;
    }

    setFile(selected);
    setState("ready");
    setMessage(`${selected.name || "Camera photo"} is ready to upload.`);
  }

  async function uploadPhoto() {
    if (!file || state === "uploading") return;
    setState("uploading");
    setMessage("Uploading photo…");

    const form = new FormData();
    form.append("file", file, file.name || "camera-photo.jpg");

    try {
      const params = new URLSearchParams({ organizationId, siteId });
      const response = await fetch(
        `/api/work-orders/${encodeURIComponent(workOrderId)}/attachments/upload?${params.toString()}`,
        { method: "POST", body: form },
      );
      const body = (await response.json()) as UploadResponse;
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? "Photo upload failed");
      }

      setState("success");
      setMessage(`${body.data.fileName} was added to this work order.`);
      setFile(null);
      if (cameraInputRef.current) cameraInputRef.current.value = "";
      if (galleryInputRef.current) galleryInputRef.current.value = "";
      router.refresh();
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "Photo upload failed");
    }
  }

  const busy = state === "uploading";

  return (
    <div style={{ display: "grid", gap: 12, marginBottom: 14 }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button
          type="button"
          disabled={disabled || busy}
          onClick={() => cameraInputRef.current?.click()}
          style={{ minHeight: 44, padding: "10px 14px", borderRadius: 9, cursor: "pointer" }}
        >
          Take photo
        </button>
        <button
          type="button"
          disabled={disabled || busy}
          onClick={() => galleryInputRef.current?.click()}
          style={{ minHeight: 44, padding: "10px 14px", borderRadius: 9, cursor: "pointer" }}
        >
          Choose image
        </button>
      </div>

      <input
        ref={cameraInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        onChange={chooseFile}
        aria-label="Take work order photo"
        disabled={disabled || busy}
        style={{ display: "none" }}
      />
      <input
        ref={galleryInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        onChange={chooseFile}
        aria-label="Choose work order image"
        disabled={disabled || busy}
        style={{ display: "none" }}
      />

      {previewUrl && file ? (
        <div style={{ display: "grid", gap: 10 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={previewUrl}
            alt="Selected work order attachment preview"
            style={{ width: "100%", maxHeight: 320, objectFit: "contain", borderRadius: 10 }}
          />
          <div className="muted">
            {(file.size / 1024 / 1024).toFixed(2)} MB · {file.type}
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button
              type="button"
              disabled={busy}
              onClick={() => void uploadPhoto()}
              style={{ minHeight: 44, padding: "10px 14px", borderRadius: 9, cursor: "pointer" }}
            >
              {busy ? "Uploading…" : "Upload photo"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={resetSelection}
              style={{ minHeight: 44, padding: "10px 14px", borderRadius: 9, cursor: "pointer" }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      <p className="muted" aria-live="polite" style={{ margin: 0 }}>
        {message}
      </p>
      <p className="muted" style={{ margin: 0 }}>
        JPEG, PNG or WebP · maximum 10 MB. Camera access starts only after you tap Take photo.
      </p>
    </div>
  );
}
