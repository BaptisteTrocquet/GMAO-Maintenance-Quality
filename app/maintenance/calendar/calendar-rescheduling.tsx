"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  dateKeyInTimeZone,
  rescheduleWorkOrderForDate,
} from "@/lib/maintenance/rescheduling";

const WORK_ORDER_DRAG_TYPE = "application/x-opengmao-work-order";

type ReschedulableWorkOrder = {
  id: string;
  number: string;
  plannedStart: string | null;
  dueAt: string | null;
};

type MoveContext = {
  organizationId: string;
  siteId: string;
  timeZone: string;
};

async function patchSchedule(
  context: MoveContext,
  workOrder: ReschedulableWorkOrder,
  targetDateKey: string,
) {
  if (
    workOrder.plannedStart &&
    dateKeyInTimeZone(new Date(workOrder.plannedStart), context.timeZone) === targetDateKey
  ) {
    return;
  }

  const schedule = rescheduleWorkOrderForDate({
    plannedStart: workOrder.plannedStart ? new Date(workOrder.plannedStart) : null,
    dueAt: workOrder.dueAt ? new Date(workOrder.dueAt) : null,
    targetDateKey,
    timeZone: context.timeZone,
  });

  const response = await fetch(`/api/work-orders/${workOrder.id}/schedule`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      organizationId: context.organizationId,
      siteId: context.siteId,
      plannedStart: schedule.plannedStart.toISOString(),
      dueAt: schedule.dueAt?.toISOString() ?? null,
    }),
  });
  const body = (await response.json()) as { error?: { message?: string } };
  if (!response.ok) {
    throw new Error(body.error?.message ?? "Unable to reschedule work order");
  }
}

function dragPayload(workOrder: ReschedulableWorkOrder) {
  return JSON.stringify(workOrder);
}

function parseDragPayload(value: string): ReschedulableWorkOrder | null {
  try {
    const parsed = JSON.parse(value) as Partial<ReschedulableWorkOrder>;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.number !== "string" ||
      !(parsed.plannedStart === null || typeof parsed.plannedStart === "string") ||
      !(parsed.dueAt === null || typeof parsed.dueAt === "string")
    ) {
      return null;
    }
    return parsed as ReschedulableWorkOrder;
  } catch {
    return null;
  }
}

export function CalendarDayDropZone({
  organizationId,
  siteId,
  timeZone,
  dateKey,
  label,
  children,
  style,
}: MoveContext & {
  dateKey: string;
  label: string;
  children: ReactNode;
  style?: React.CSSProperties;
}) {
  const router = useRouter();
  const [active, setActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function drop(value: string) {
    const workOrder = parseDragPayload(value);
    if (!workOrder) {
      setError("Invalid work-order drag payload.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await patchSchedule({ organizationId, siteId, timeZone }, workOrder, dateKey);
      router.refresh();
    } catch (moveError) {
      setError(moveError instanceof Error ? moveError.message : "Unable to reschedule work order");
    } finally {
      setBusy(false);
      setActive(false);
    }
  }

  return (
    <section
      className="card"
      aria-label={label}
      aria-busy={busy}
      onDragEnter={(event) => {
        event.preventDefault();
        setActive(true);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setActive(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        const value =
          event.dataTransfer.getData(WORK_ORDER_DRAG_TYPE) ||
          event.dataTransfer.getData("text/plain");
        void drop(value);
      }}
      style={{
        ...style,
        outline: active ? "2px solid currentColor" : undefined,
        outlineOffset: active ? 2 : undefined,
      }}
    >
      {children}
      {error ? <div role="alert" style={{ marginTop: 8 }}>{error}</div> : null}
    </section>
  );
}

export function RescheduleControls({
  organizationId,
  siteId,
  timeZone,
  workOrder,
  disabled = false,
}: MoveContext & {
  workOrder: ReschedulableWorkOrder;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [targetDate, setTargetDate] = useState(
    workOrder.plannedStart
      ? dateKeyInTimeZone(new Date(workOrder.plannedStart), timeZone)
      : "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function move() {
    if (!targetDate || disabled) return;
    setBusy(true);
    setError(null);
    try {
      await patchSchedule({ organizationId, siteId, timeZone }, workOrder, targetDate);
      router.refresh();
    } catch (moveError) {
      setError(moveError instanceof Error ? moveError.message : "Unable to reschedule work order");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 6, marginTop: 7 }}>
      <div style={{ display: "flex", gap: 6, alignItems: "end", flexWrap: "wrap" }}>
        <button
          type="button"
          draggable={!disabled && !busy}
          disabled={disabled || busy}
          aria-label={`Drag ${workOrder.number} to another calendar day`}
          onDragStart={(event) => {
            const payload = dragPayload(workOrder);
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData(WORK_ORDER_DRAG_TYPE, payload);
            event.dataTransfer.setData("text/plain", payload);
          }}
          style={{ cursor: disabled ? "not-allowed" : "grab" }}
        >
          Drag
        </button>
        <label style={{ display: "grid", gap: 2, fontSize: 12 }}>
          Move to date
          <input
            type="date"
            value={targetDate}
            onChange={(event) => setTargetDate(event.target.value)}
            disabled={disabled || busy}
            aria-label={`Move ${workOrder.number} to date`}
          />
        </label>
        <button
          type="button"
          onClick={move}
          disabled={disabled || busy || !targetDate}
        >
          {busy ? "Moving…" : "Move"}
        </button>
      </div>
      {error ? <div role="alert">{error}</div> : null}
    </div>
  );
}
