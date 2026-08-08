"use client";

import Link from "next/link";
import { useState, type DragEvent } from "react";
import { useRouter } from "next/navigation";
import { buildWorkOrderRescheduleRequest } from "@/lib/maintenance/reschedule";

const DRAG_MIME = "application/x-gmao-work-order-schedule";

type CalendarItem = {
  id: string;
  number: string;
  title: string;
  status: string;
  priority: string;
  assetCode: string | null;
  assigneeName: string | null;
  teamName: string | null;
  planned: boolean;
  due: boolean;
  plannedTime: string | null;
  dueTime: string | null;
  plannedStart: string | null;
  dueAt: string | null;
};

type DragPayload = {
  workOrderId: string;
  workOrderNumber: string;
  sourceInstant: string;
};

type Props = {
  organizationId: string;
  siteId: string;
  timeZone: string;
  day: {
    dateKey: string;
    dayOfMonth: number;
    inMonth: boolean;
    items: CalendarItem[];
  };
  maxItems?: number;
};

function statusLabel(value: string) {
  return value.toLowerCase().replaceAll("_", " ");
}

function eventTiming(item: CalendarItem) {
  const values: string[] = [];
  if (item.planned) values.push(`Start${item.plannedTime ? ` ${item.plannedTime}` : ""}`);
  if (item.due) values.push(`Due${item.dueTime ? ` ${item.dueTime}` : ""}`);
  return values.join(" · ");
}

function readPayload(event: DragEvent) {
  const raw = event.dataTransfer.getData(DRAG_MIME) || event.dataTransfer.getData("text/plain");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DragPayload>;
    if (
      typeof parsed.workOrderId !== "string" ||
      typeof parsed.workOrderNumber !== "string" ||
      typeof parsed.sourceInstant !== "string"
    ) {
      return null;
    }
    return parsed as DragPayload;
  } catch {
    return null;
  }
}

export default function ReschedulableCalendarDay({
  organizationId,
  siteId,
  timeZone,
  day,
  maxItems = 8,
}: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "error" | "success"; message: string } | null>(null);
  const hiddenCount = Math.max(day.items.length - maxItems, 0);

  async function move(payload: DragPayload, targetDateKey: string) {
    setBusy(payload.workOrderId);
    setFeedback(null);
    try {
      const request = buildWorkOrderRescheduleRequest({
        workOrderId: payload.workOrderId,
        organizationId,
        siteId,
        field: "plannedStart",
        instant: new Date(payload.sourceInstant),
        targetDateKey,
        timeZone,
      });
      const response = await fetch(request.url, {
        method: request.method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request.body),
      });
      const body = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) {
        throw new Error(body.error?.message ?? "Work-order rescheduling failed");
      }
      setFeedback({
        kind: "success",
        message: `${payload.workOrderNumber} start moved to ${targetDateKey}.`,
      });
      router.refresh();
    } catch (error) {
      setFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : "Work-order rescheduling failed",
      });
    } finally {
      setBusy(null);
    }
  }

  function startDrag(event: DragEvent<HTMLButtonElement>, payload: DragPayload) {
    const encoded = JSON.stringify(payload);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(DRAG_MIME, encoded);
    event.dataTransfer.setData("text/plain", encoded);
  }

  async function keyboardMove(payload: DragPayload) {
    const target = window.prompt(
      `Move ${payload.workOrderNumber} start to local date (YYYY-MM-DD)`,
      day.dateKey,
    );
    if (!target?.trim()) return;
    await move(payload, target.trim());
  }

  async function drop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragOver(false);
    const payload = readPayload(event);
    if (!payload) {
      setFeedback({ kind: "error", message: "This drag item is not a work-order start marker." });
      return;
    }
    await move(payload, day.dateKey);
  }

  function scheduleHandle(item: CalendarItem) {
    if (!item.planned || !item.plannedStart) return null;
    const payload: DragPayload = {
      workOrderId: item.id,
      workOrderNumber: item.number,
      sourceInstant: item.plannedStart,
    };
    return (
      <button
        type="button"
        draggable={busy === null}
        disabled={busy !== null}
        onDragStart={(event) => startDrag(event, payload)}
        onClick={() => keyboardMove(payload)}
        aria-label={`Move ${item.number} planned start; drag to another day or activate to enter a date`}
        title="Drag planned start to another day, or activate to enter a date"
        style={{ padding: "4px 7px", cursor: busy ? "wait" : "grab" }}
      >
        {busy === item.id ? "…" : "START"}
      </button>
    );
  }

  return (
    <section
      className="card"
      aria-label={`${day.dateKey}, ${day.items.length} work-order event${day.items.length === 1 ? "" : "s"}. Drop a planned-start marker here to reschedule it.`}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={drop}
      style={{
        minHeight: 170,
        padding: 10,
        opacity: day.inMonth ? 1 : 0.62,
        outline: dragOver ? "2px solid currentColor" : undefined,
        outlineOffset: dragOver ? 2 : undefined,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
        <strong>{day.dayOfMonth}</strong>
        {day.items.length ? <span className="badge">{day.items.length}</span> : null}
      </div>

      {feedback ? (
        <div
          role={feedback.kind === "error" ? "alert" : "status"}
          style={{ marginTop: 7, fontSize: 12, fontWeight: feedback.kind === "error" ? 650 : undefined }}
        >
          {feedback.message}
        </div>
      ) : null}

      <div style={{ display: "grid", gap: 7, marginTop: 8 }}>
        {day.items.slice(0, maxItems).map((item) => (
          <article key={`${day.dateKey}-${item.id}`} style={{ borderTop: "1px solid #e5e7eb", paddingTop: 7 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
              <Link className="table-link" href={`/maintenance/${item.id}`}>
                {item.number}
              </Link>
              <span className="badge">{item.priority}</span>
            </div>
            <div style={{ fontSize: 13, marginTop: 3 }}>{item.title}</div>
            <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>
              {eventTiming(item)} · {statusLabel(item.status)}
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              {item.assetCode ?? "No asset"} · {item.assigneeName ?? item.teamName ?? "Unassigned"}
            </div>
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 6 }} aria-label="Schedule controls">
              {scheduleHandle(item)}
              {item.due ? <span className="badge">DUE · read only</span> : null}
            </div>
          </article>
        ))}
        {hiddenCount ? <div className="muted">+{hiddenCount} more on this day</div> : null}
      </div>
    </section>
  );
}
