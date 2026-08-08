"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type BarcodeResult = { rawValue?: string };
type BarcodeDetectorInstance = {
  detect(source: HTMLVideoElement): Promise<BarcodeResult[]>;
};
type BarcodeDetectorConstructor = {
  new (options?: { formats?: string[] }): BarcodeDetectorInstance;
  getSupportedFormats?: () => Promise<string[]>;
};
type ScanApiResponse = {
  data?: {
    asset: { id: string; code: string; name: string };
    href: string;
  };
  error?: { code: string; message: string };
};

type ScannerStatus = "idle" | "starting" | "scanning" | "resolving" | "unsupported" | "error";

function barcodeDetectorConstructor() {
  return (
    globalThis as typeof globalThis & {
      BarcodeDetector?: BarcodeDetectorConstructor;
    }
  ).BarcodeDetector;
}

export default function AssetQrScanner({
  organizationId,
  siteId,
}: {
  organizationId: string;
  siteId: string;
}) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const detectorRef = useRef<BarcodeDetectorInstance | null>(null);
  const resolvingRef = useRef(false);
  const lastPayloadRef = useRef<string | null>(null);
  const [status, setStatus] = useState<ScannerStatus>("idle");
  const [message, setMessage] = useState("Camera is off.");
  const [manualPayload, setManualPayload] = useState("");

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    detectorRef.current = null;
    resolvingRef.current = false;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  useEffect(() => () => stopCamera(), [stopCamera]);

  const resolvePayload = useCallback(
    async (payload: string) => {
      if (resolvingRef.current) return;
      resolvingRef.current = true;
      setStatus("resolving");
      setMessage("Checking asset access…");

      try {
        const response = await fetch("/api/assets/scan", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ organizationId, siteId, payload }),
        });
        const body = (await response.json()) as ScanApiResponse;
        if (!response.ok || !body.data) {
          throw new Error(body.error?.message ?? "Unable to resolve this QR code");
        }

        stopCamera();
        setMessage(`Opening ${body.data.asset.code} · ${body.data.asset.name}`);
        router.push(body.data.href);
      } catch (error) {
        resolvingRef.current = false;
        lastPayloadRef.current = null;
        setStatus(streamRef.current ? "scanning" : "error");
        setMessage(error instanceof Error ? error.message : "Unable to resolve this QR code");
      }
    },
    [organizationId, router, siteId, stopCamera],
  );

  const startCamera = useCallback(async () => {
    stopCamera();
    setStatus("starting");
    setMessage("Requesting camera access…");

    const Detector = barcodeDetectorConstructor();
    if (!Detector || !navigator.mediaDevices?.getUserMedia) {
      setStatus("unsupported");
      setMessage("This browser cannot scan QR codes with the camera. Paste the asset QR route below.");
      return;
    }

    try {
      const supportedFormats = await Detector.getSupportedFormats?.();
      if (supportedFormats && !supportedFormats.includes("qr_code")) {
        setStatus("unsupported");
        setMessage("QR detection is not supported by this browser. Paste the asset QR route below.");
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      streamRef.current = stream;
      detectorRef.current = new Detector({ formats: ["qr_code"] });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      lastPayloadRef.current = null;
      setStatus("scanning");
      setMessage("Point the camera at an OpenGMAO asset QR label.");
    } catch (error) {
      stopCamera();
      setStatus("error");
      const denied = error instanceof DOMException && error.name === "NotAllowedError";
      setMessage(
        denied
          ? "Camera permission was denied. Allow camera access or paste the asset QR route below."
          : "The camera could not be started. You can still paste the asset QR route below.",
      );
    }
  }, [stopCamera]);

  useEffect(() => {
    if (status !== "scanning") return;

    const timer = window.setInterval(() => {
      const video = videoRef.current;
      const detector = detectorRef.current;
      if (!video || !detector || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      if (resolvingRef.current) return;

      void detector
        .detect(video)
        .then((codes) => {
          const payload = codes.find((code) => code.rawValue?.trim())?.rawValue?.trim();
          if (!payload || payload === lastPayloadRef.current) return;
          lastPayloadRef.current = payload;
          void resolvePayload(payload);
        })
        .catch(() => {
          // A single bad frame should not stop the scanner.
        });
    }, 300);

    return () => window.clearInterval(timer);
  }, [resolvePayload, status]);

  function submitManual(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const payload = manualPayload.trim();
    if (!payload) {
      setStatus("error");
      setMessage("Paste an asset QR route before opening it.");
      return;
    }
    void resolvePayload(payload);
  }

  const cameraActive = status === "scanning" || status === "starting" || status === "resolving";

  return (
    <div className="grid grid-2">
      <section className="card" aria-labelledby="camera-scanner-title">
        <h2 id="camera-scanner-title">Camera scanner</h2>
        <div
          style={{
            position: "relative",
            overflow: "hidden",
            borderRadius: 12,
            background: "#111827",
            aspectRatio: "4 / 3",
            marginBottom: 14,
          }}
        >
          <video
            ref={videoRef}
            muted
            playsInline
            aria-label="QR scanner camera preview"
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          />
          {!cameraActive ? (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "grid",
                placeItems: "center",
                padding: 24,
                color: "white",
                textAlign: "center",
              }}
            >
              Camera preview
            </div>
          ) : null}
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={() => void startCamera()}
            disabled={status === "starting" || status === "resolving"}
            style={{ minHeight: 44, padding: "10px 16px", borderRadius: 9, cursor: "pointer" }}
          >
            {status === "scanning" ? "Restart camera" : "Start camera"}
          </button>
          {streamRef.current ? (
            <button
              type="button"
              onClick={() => {
                stopCamera();
                setStatus("idle");
                setMessage("Camera is off.");
              }}
              style={{ minHeight: 44, padding: "10px 16px", borderRadius: 9, cursor: "pointer" }}
            >
              Stop camera
            </button>
          ) : null}
        </div>
        <p className="muted" aria-live="polite">
          {message}
        </p>
      </section>

      <section className="card" aria-labelledby="manual-scanner-title">
        <h2 id="manual-scanner-title">Open a scanned route manually</h2>
        <p className="muted">
          Use this fallback when camera QR detection is unavailable. Only asset routes from this OpenGMAO
          installation are accepted.
        </p>
        <form onSubmit={submitManual} style={{ display: "grid", gap: 12 }}>
          <label htmlFor="asset-qr-payload">Asset QR route or URL</label>
          <input
            id="asset-qr-payload"
            value={manualPayload}
            onChange={(event) => setManualPayload(event.target.value)}
            placeholder="/assets/asset-id"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            style={{ minHeight: 44, padding: "10px 12px", border: "1px solid #d1d5db", borderRadius: 9 }}
          />
          <button
            type="submit"
            disabled={status === "resolving"}
            style={{ minHeight: 44, padding: "10px 16px", borderRadius: 9, cursor: "pointer" }}
          >
            Open asset
          </button>
        </form>
      </section>
    </div>
  );
}
