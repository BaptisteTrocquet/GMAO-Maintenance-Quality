"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  dateKeyInTimeZone,
  rescheduleWorkOrderForDate,
} from "@/lib/maintenance/planning-calendar";

type WorkOrder = {
  id: string;
  number: string;
  title: string;
  status: string;
  priority: string;
  plannedStart: string | null;
  dueAt: string | null;
  assetCode: string | null;
  assigneeName: string | null;
  teamName: string | null;
};

type CalendarItem = WorkOrder & {
  dateKey: string;
  planned: boolean;
  due: boolean;
  plannedTime: string | null;
  dueTime: string | null;
};

type CalendarDay = {
  dateKey: string;
  dayOfMonth: number;
  inMonth: boolean;
  items: CalendarItem[];
};

type Props = {
  organizationId: string;
  siteId: string;
  timeZone: string;
  calendar: CalendarDay[];
  workOrders: WorkOrder[];
  unscheduled: WorkOrder[];
};

function statusLabel(value: string) {
  return value.toLowerCase().replaceAll("_", " ");
}

function localDateLabel(value: string | null, timeZone: string) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

function ownerLabel(workOrder: WorkOrder) {
  return workOrder.assigneeName ?? workOrder.teamName ?? "Unassigned";
}

export default function MonthlyCalendarPlanner({
  organizationId,
  siteId,
  timeZone,
  calendar,
  workOrders,
  unscheduled,
}: Props) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedDates, setSelectedDates] = useState<Record<string, string>>({});
  const workOrderById = useMemo(
    () => new Map([...workOrders, ...unscheduled].map((workOrder) => [workOrder.id, workOrder])),
    [unscheduled, workOrders],
  );

  async function moveWorkOrder(workOrderId: string, targetDateKey: string) {
    const workOrder = workOrderById.get(workOrderId);
    if (!workOrder || !targetDateKey) return;

    if (
      workOrder.plannedStart &&
      dateKeyInTimeZone(new Date(workOrder.plannedStart), timeZone) === targetDateKey
    ) {
      return;
    }

    const schedule = rescheduleWorkOrderForDate({
      plannedStart: workOrder.plannedStart ? new Date(workOrder.plannedStart) : null,
      dueAt: workOrder.dueAt ? new Date(workOrder.dueAt) : null,
      targetDateKey,
      timeZone,
    });

    setBusyId(workOrderId);
    setError(null);
    try {
      const response = await fetch(`/api/work-orders/${workOrderId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId,
          siteId,
          plannedStart: schedule.plannedStart.toISOString(),
          ...(schedule.dueAt ? { dueAt: schedule.dueAt.toISOString() } : {}),
        }),
      });
      const body = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) {
        throw new Error(body.error?.message ?? "Unable to reschedule work order");
      }
      setSelectedDates((current) => ({ ...current, [workOrderId]: targetDateKey }));
      router.refresh();
    } catch (moveError) {
      setError(moveError instanceof Error ? moveError.message : "Unable to reschedule work order");
    } finally {
      setBusyId(null);
    }
  }

  function startDrag(workOrderId: string, event: React.DragEvent<HTMLElement>) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/work-order-id", workOrderId);
  }

  function moveControls(workOrder: WorkOrder, defaultDate = "") {
    const selectedDate = selectedDates[workOrder.id] ?? defaultDate;
    const busy = busyId === workOrder.id;
    return (
      <div style={{ display: "flex", gap: 6, alignItems: "end", flexWrap: "wrap" }}>
        <label style={{ display: "grid", gap: 3, fontSize: 12 }}>
          Move to date
          <input
            type="date"
            value={selectedDate}
            onChange={(event) =>
              setSelectedDates((current) => ({ ...current, [workOrder.id]: event.target.value }))
            }
            disabled={busy}
          />
        </label>
        <button
          type="button"
          onClick={() => void moveWorkOrder(workOrder.id, selectedDate)}
          disabled={busy || !selectedDate}
        >
          {busy ? "Moving…" : "Move"}
        </button>
      </div>
    );
  }

  return (
    <>
      {error ? (
        <div className="card" role="alert" style={{ borderColor: "currentColor", marginBottom: 12 }}>
          {error}
        </div>
      ) : null}

      <section className="section" aria-label="Monthly maintenance calendar" style={{ overflowX: "auto" }}>
        <div style={{ minWidth: 980 }}>
          <div
            aria-hidden="true"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(7, minmax(140px, 1fr))",
              gap: 8,
              marginBottom: 8,
            }}
          >
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((weekday) => (
              <div
                key={weekday}
                className="card"
                style={{ padding: 10, textAlign: "center", fontWeight: 700 }}
              >
                {weekday}
              </div>
            ))}
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(7, minmax(140px, 1fr))",
              gap: 8,
            }}
          >
            {calendar.map((day) => (
              <section
                key={day.dateKey}
                className="card"
                aria-label={`${day.dateKey}, ${day.items.length} calendar items`}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const workOrderId = event.dataTransfer.getData("text/work-order-id");
                  if (workOrderId) void moveWorkOrder(workOrderId, day.dateKey);
                }}
                style={{
                  minHeight: 180,
                  padding: 10,
                  opacity: day.inMonth ? 1 : 0.62,
                  alignSelf: "stretch",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 8,
                    marginBottom: 8,
                  }}
                >
                  <strong>{day.dayOfMonth}</strong>
                  {day.items.length ? <span className="badge">{day.items.length}</span> : null}
                </div>

                <div style={{ display: "grid", gap: 8 }}>
                  {day.items.map((item) => {
                    const movable = item.planned;
                    return (
                      <article
                        key={`${day.dateKey}-${item.id}`}
                        draggable={movable && busyId !== item.id}
                        onDragStart={
                          movable ? (event) => startDrag(item.id, event) : undefined
                        }
                        aria-label={`${item.number} ${item.title}${movable ? ", draggable planned start" : ", due marker"}`}
                        style={{
                          border: "1px solid #e5e7eb",
                          borderRadius: 8,
                          padding: 8,
                          display: "grid",
                          gap: 6,
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            gap: 6,
                            alignItems: "start",
                          }}
                        >
                          <Link className="table-link" href={`/maintenance/${item.id}`}>
                            <strong>{item.number}</strong>
                          </Link>
                          <span className="badge">{item.priority}</span>
                        </div>
                        <div style={{ fontSize: 13, fontWeight: 650 }}>{item.title}</div>
                        <div className="muted" style={{ fontSize: 12 }}>
                          {item.assetCode ?? "No asset"} · {ownerLabel(item)}
                        </div>
                        <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                          {item.planned ? <span className="badge">START {item.plannedTime}</span> : null}
                          {item.due ? <span className="badge">DUE {item.dueTime}</span> : null}
                          <span className="badge">{statusLabel(item.status)}</span>
                        </div>
                        {movable ? moveControls(item, day.dateKey) : null}
                      </article>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        </div>
      </section>

      <section className="section card" aria-labelledby="unscheduled-title">
        <div>
          <h2 id="unscheduled-title" style={{ marginTop: 0 }}>Unscheduled work</h2>
          <div className="muted">
            Drag a card onto a calendar day or use the date field and Move button for keyboard planning.
          </div>
        </div>
        {unscheduled.length ? (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
              gap: 10,
              marginTop: 12,
            }}
          >
            {unscheduled.map((workOrder) => (
              <article
                className="card"
                key={workOrder.id}
                draggable={busyId !== workOrder.id}
                onDragStart={(event) => startDrag(workOrder.id, event)}
                aria-label={`${workOrder.number} ${workOrder.title}, draggable unscheduled work order`}
                style={{ padding: 12, display: "grid", gap: 8 }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <div>
                    <Link className="table-link" href={`/maintenance/${workOrder.id}`}>
                      <strong>{workOrder.number}</strong>
                    </Link>
                    <div>{workOrder.title}</div>
                  </div>
                  <span className="badge">{workOrder.priority}</span>
                </div>
                <div className="muted">
                  {workOrder.assetCode ?? "No asset"} · {ownerLabel(workOrder)}
                </div>
                <div className="muted">
                  {statusLabel(workOrder.status)} · Due {localDateLabel(workOrder.dueAt, timeZone)}
                </div>
                {moveControls(workOrder)}
              </article>
            ))}
          </div>
        ) : (
          <div className="muted" style={{ marginTop: 12 }}>No unscheduled open work orders.</div>
        )}
      </section>
    </>
  );
}
