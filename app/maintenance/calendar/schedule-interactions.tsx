"use client";

import type { CSSProperties, ReactNode } from "react";
import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  buildSchedulePatch,
  type WorkOrderScheduleField,
} from "@/lib/maintenance/reschedule";

const SCHEDULE_MIME = "application/x-opengmao-work-order-schedule";

type ScheduleDragPayload = {
  workOrderId: string;
  field: WorkOrderScheduleField;
  instant: string | null;
  dueAt: string | null;
  sourceDateKey: string | null;
};

type ScopeProps = {
  organizationId: string;
  siteId: string;
  timeZone: string;
};

function parseDragPayload(value: string): ScheduleDragPayload | null {
  try {
    const parsed = JSON.parse(value) as Partial<ScheduleDragPayload>;
    if (
      typeof parsed.workOrderId !== "string" ||
      (parsed.field !== "plannedStart" && parsed.field !== "dueAt") ||
      !(parsed.instant === null || typeof parsed.instant === "string") ||
      !(parsed.dueAt === null || typeof parsed.dueAt === "string") ||
      !(parsed.sourceDateKey === null || typeof parsed.sourceDateKey === "string")
    ) {
      return null;
    }
    return parsed as ScheduleDragPayload;
  } catch {
    return null;
  }
}

async function patchSchedule(
  scope: ScopeProps,
  payload: ScheduleDragPayload,
  targetDateKey: string,
) {
  const schedulePatch = buildSchedulePatch({
    field: payload.field,
    instant: payload.instant ? new Date(payload.instant) : null,
    dueAt: payload.dueAt ? new Date(payload.dueAt) : null,
    targetDateKey,
    timeZone: scope.timeZone,
  });
  const response = await fetch(`/api/work-orders/${payload.workOrderId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      organizationId: scope.organizationId,
      siteId: scope.siteId,
      ...schedulePatch,
    }),
  });
  const body = (await response.json().catch(() => null)) as
    | { error?: { message?: string } }
    | null;
  if (!response.ok) {
    throw new Error(body?.error?.message ?? "Unable to reschedule work order");
  }
}

export function ScheduleMarker({
  organizationId,
  siteId,
  timeZone,
  workOrderId,
  field,
  instant,
  dueAt,
  sourceDateKey,
  label,
}: ScopeProps & {
  workOrderId: string;
  field: WorkOrderScheduleField;
  instant: string | null;
  dueAt?: string | null;
  sourceDateKey: string | null;
  label: string;
}) {
  const router = useRouter();
  const [targetDate, setTargetDate] = useState(sourceDateKey ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const payload: ScheduleDragPayload = {
    workOrderId,
    field,
    instant,
    dueAt: dueAt ?? null,
    sourceDateKey,
  };

  async function move(targetDateKey: string) {
    if (!targetDateKey || targetDateKey === sourceDateKey) return;
    setBusy(true);
    setError(null);
    try {
      await patchSchedule({ organizationId, siteId, timeZone }, payload, targetDateKey);
      router.refresh();
    } catch (moveError) {
      setError(moveError instanceof Error ? moveError.message : "Unable to reschedule work order");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span style={{ display: "inline-grid", gap: 4 }}>
      <button
        type="button"
        className="badge"
        draggable={!busy}
        disabled={busy}
        aria-label={`${label}. Drag to another calendar day.`}
        title="Drag to another day"
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData(SCHEDULE_MIME, JSON.stringify(payload));
        }}
      >
        {busy ? "MOVING…" : label}
      </button>
      <details>
        <summary className="table-link" style={{ cursor: "pointer", fontSize: 11 }}>
          Move
        </summary>
        <div style={{ display: "flex", gap: 4, alignItems: "end", flexWrap: "wrap", marginTop: 4 }}>
          <label style={{ display: "grid", gap: 2, fontSize: 11 }}>
            Target date
            <input
              type="date"
              value={targetDate}
              onChange={(event) => setTargetDate(event.target.value)}
              disabled={busy}
            />
          </label>
          <button
            type="button"
            onClick={() => void move(targetDate)}
            disabled={busy || !targetDate || targetDate === sourceDateKey}
          >
            Apply
          </button>
        </div>
      </details>
      {error ? <span role="alert" style={{ fontSize: 11 }}>{error}</span> : null}
    </span>
  );
}

export function ScheduleDropZone({
  organizationId,
  siteId,
  timeZone,
  dateKey,
  label,
  className,
  style,
  children,
}: ScopeProps & {
  dateKey: string;
  label: string;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const router = useRouter();
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <section
      className={className}
      aria-label={label}
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes(SCHEDULE_MIME)) setDragActive(true);
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(SCHEDULE_MIME)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDragActive(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragActive(false);
        const payload = parseDragPayload(event.dataTransfer.getData(SCHEDULE_MIME));
        if (!payload || payload.sourceDateKey === dateKey) return;
        setError(null);
        void patchSchedule({ organizationId, siteId, timeZone }, payload, dateKey)
          .then(() => router.refresh())
          .catch((moveError) => {
            setError(moveError instanceof Error ? moveError.message : "Unable to reschedule work order");
          });
      }}
      style={{
        ...style,
        outline: dragActive ? "2px solid currentColor" : style?.outline,
        outlineOffset: dragActive ? 2 : style?.outlineOffset,
      }}
    >
      {children}
      {dragActive ? <div className="muted" style={{ marginTop: 6 }}>Drop schedule here</div> : null}
      {error ? <div role="alert" style={{ marginTop: 6 }}>{error}</div> : null}
    </section>
  );
}