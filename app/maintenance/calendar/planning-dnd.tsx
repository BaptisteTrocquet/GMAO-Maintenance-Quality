"use client";

import { type DragEvent, type FormEvent, type ReactNode, useState } from "react";
import { useRouter } from "next/navigation";

const DRAG_TYPE = "application/x-opengmao-work-order";

async function reschedule(input: {
  workOrderId: string;
  organizationId: string;
  siteId: string;
  targetDate: string;
}) {
  const response = await fetch(`/api/work-orders/${input.workOrderId}/reschedule`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      organizationId: input.organizationId,
      siteId: input.siteId,
      targetDate: input.targetDate,
    }),
  });
  const body = (await response.json()) as { error?: { message?: string } };
  if (!response.ok) throw new Error(body.error?.message ?? "Work-order rescheduling failed");
}

export function PlanningDayDropZone({
  organizationId,
  siteId,
  targetDate,
  children,
}: {
  organizationId: string;
  siteId: string;
  targetDate: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const [active, setActive] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setActive(false);
    const workOrderId = event.dataTransfer.getData(DRAG_TYPE) || event.dataTransfer.getData("text/plain");
    if (!workOrderId) return;
    try {
      setMessage("Moving…");
      await reschedule({ workOrderId, organizationId, siteId, targetDate });
      setMessage("Moved");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Move failed");
    }
  }

  return (
    <div
      onDragEnter={(event) => {
        event.preventDefault();
        setActive(true);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setActive(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setActive(false);
      }}
      onDrop={handleDrop}
      aria-label={`Planning day ${targetDate}`}
      style={{
        minHeight: 128,
        borderRadius: 8,
        outline: active ? "2px dashed currentColor" : undefined,
        outlineOffset: active ? 2 : undefined,
      }}
    >
      {children}
      {message ? <div className="muted" role="status" style={{ marginTop: 6 }}>{message}</div> : null}
    </div>
  );
}

export function PlanningMoveControl({
  workOrderId,
  organizationId,
  siteId,
  currentDate,
  label = "Move",
}: {
  workOrderId: string;
  organizationId: string;
  siteId: string;
  currentDate?: string;
  label?: string;
}) {
  const router = useRouter();
  const [targetDate, setTargetDate] = useState(currentDate ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function handleDragStart(event: DragEvent<HTMLDivElement>) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(DRAG_TYPE, workOrderId);
    event.dataTransfer.setData("text/plain", workOrderId);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!targetDate) return;
    setBusy(true);
    setMessage(null);
    try {
      await reschedule({ workOrderId, organizationId, siteId, targetDate });
      setMessage("Moved");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Move failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      draggable
      onDragStart={handleDragStart}
      aria-label={`Drag work order ${workOrderId} to another planning day`}
      style={{ marginTop: 6, cursor: "grab" }}
    >
      <details>
        <summary className="muted" style={{ cursor: "pointer" }}>
          ↕ {label}
        </summary>
        <form onSubmit={handleSubmit} style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
          <label>
            <span className="sr-only">Target planning date</span>
            <input
              type="date"
              value={targetDate}
              onChange={(event) => setTargetDate(event.target.value)}
              required
              disabled={busy}
            />
          </label>
          <button type="submit" disabled={busy || !targetDate}>
            {busy ? "Moving…" : "Move"}
          </button>
        </form>
        {message ? <div className="muted" role="status">{message}</div> : null}
      </details>
    </div>
  );
}
