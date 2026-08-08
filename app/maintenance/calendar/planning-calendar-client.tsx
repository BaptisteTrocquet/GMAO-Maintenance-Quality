"use client";

import Link from "next/link";
import { useMemo, useState, type DragEvent } from "react";
import { useRouter } from "next/navigation";
import { localDateKey, rescheduleWorkOrderDates } from "@/lib/maintenance/calendar-reschedule";

type CalendarItem = {
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

type UnscheduledWorkOrder = Omit<CalendarItem, "planned" | "due" | "plannedTime" | "dueTime">;

type Props = {
  organizationId: string;
  siteId: string;
  timeZone: string;
  days: CalendarDay[];
  unscheduled: UnscheduledWorkOrder[];
  unscheduledTruncated: boolean;
  unscheduledLimit: number;
};

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function statusLabel(value: string) {
  return value.toLowerCase().replaceAll("_", " ");
}

function canReschedule(status: string) {
  return status !== "COMPLETED" && status !== "CANCELLED";
}

function formatDue(value: string | null, timeZone: string) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export default function PlanningCalendarClient({
  organizationId,
  siteId,
  timeZone,
  days,
  unscheduled,
  unscheduledTruncated,
  unscheduledLimit,
}: Props) {
  const router = useRouter();
  const uniqueWorkOrders = useMemo(() => {
    const map = new Map<string, CalendarItem | UnscheduledWorkOrder>();
    for (const day of days) {
      for (const item of day.items) map.set(item.id, item);
    }
    for (const item of unscheduled) map.set(item.id, item);
    return map;
  }, [days, unscheduled]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [targetDates, setTargetDates] = useState<Record<string, string>>(() => {
    const values: Record<string, string> = {};
    for (const [id, item] of uniqueWorkOrders) {
      values[id] = item.plannedStart
        ? localDateKey(new Date(item.plannedStart), timeZone)
        : "";
    }
    return values;
  });

  async function reschedule(workOrderId: string, targetDateKey: string) {
    const workOrder = uniqueWorkOrders.get(workOrderId);
    if (!workOrder || !targetDateKey || !canReschedule(workOrder.status)) return;
    if (
      workOrder.plannedStart &&
      localDateKey(new Date(workOrder.plannedStart), timeZone) === targetDateKey
    ) {
      return;
    }

    const dates = rescheduleWorkOrderDates({
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
          plannedStart: dates.plannedStart.toISOString(),
          ...(dates.dueAt ? { dueAt: dates.dueAt.toISOString() } : {}),
        }),
      });
      const body = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) {
        throw new Error(body.error?.message ?? "Unable to reschedule work order");
      }
      router.refresh();
    } catch (moveError) {
      setError(moveError instanceof Error ? moveError.message : "Unable to reschedule work order");
    } finally {
      setBusyId(null);
    }
  }

  function startDrag(workOrderId: string, event: DragEvent<HTMLElement>) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/work-order-id", workOrderId);
  }

  function moveControls(workOrder: CalendarItem | UnscheduledWorkOrder) {
    if (!canReschedule(workOrder.status)) return null;
    return (
      <div style={{ display: "flex", gap: 5, alignItems: "end", flexWrap: "wrap" }}>
        <label style={{ display: "grid", gap: 2, fontSize: 11 }}>
          Move to
          <input
            type="date"
            value={targetDates[workOrder.id] ?? ""}
            disabled={busyId === workOrder.id}
            onChange={(event) =>
              setTargetDates((current) => ({ ...current, [workOrder.id]: event.target.value }))
            }
          />
        </label>
        <button
          type="button"
          onClick={() => void reschedule(workOrder.id, targetDates[workOrder.id] ?? "")}
          disabled={busyId === workOrder.id || !targetDates[workOrder.id]}
          aria-label={`Move ${workOrder.number} to selected date`}
        >
          {busyId === workOrder.id ? "Moving…" : "Move"}
        </button>
      </div>
    );
  }

  return (
    <>
      {error ? (
        <div className="card" role="alert" style={{ marginBottom: 12 }}>
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
            {WEEKDAYS.map((weekday) => (
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
            {days.map((day) => (
              <section
                key={day.dateKey}
                className="card"
                aria-label={`${day.dateKey}, drop planned work here`}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const workOrderId = event.dataTransfer.getData("text/work-order-id");
                  if (workOrderId) void reschedule(workOrderId, day.dateKey);
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
                    const draggable = item.planned && canReschedule(item.status);
                    return (
                      <article
                        key={`${day.dateKey}-${item.id}`}
                        draggable={draggable && busyId !== item.id}
                        onDragStart={draggable ? (event) => startDrag(item.id, event) : undefined}
                        aria-label={`${item.number} ${item.title}${draggable ? ", draggable planned work" : ""}`}
                        style={{
                          border: "1px solid #e5e7eb",
                          borderRadius: 8,
                          padding: 8,
                          display: "grid",
                          gap: 5,
                          cursor: draggable ? "grab" : undefined,
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
                          {item.assetCode ?? "No asset"} · {item.assigneeName ?? item.teamName ?? "Unassigned"}
                        </div>
                        <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                          {item.planned ? <span className="badge">START {item.plannedTime}</span> : null}
                          {item.due ? <span className="badge">DUE {item.dueTime}</span> : null}
                          <span className="badge">{statusLabel(item.status)}</span>
                        </div>
                        {item.planned ? moveControls(item) : null}
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
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <h2 id="unscheduled-title" style={{ marginTop: 0 }}>Unscheduled work</h2>
            <div className="muted">
              Drag open work onto a calendar day or choose a date and use Move for keyboard/mobile planning.
            </div>
          </div>
          {unscheduledTruncated ? <span className="badge">First {unscheduledLimit} shown</span> : null}
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
                key={workOrder.id}
                className="card"
                draggable={canReschedule(workOrder.status) && busyId !== workOrder.id}
                onDragStart={(event) => startDrag(workOrder.id, event)}
                aria-label={`${workOrder.number} ${workOrder.title}, draggable unscheduled work`}
                style={{ padding: 12, display: "grid", gap: 8 }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <Link className="table-link" href={`/maintenance/${workOrder.id}`}>
                    <strong>{workOrder.number}</strong> · {workOrder.title}
                  </Link>
                  <span className="badge">{workOrder.priority}</span>
                </div>
                <div className="muted">
                  {workOrder.assetCode ?? "No asset"} · {workOrder.assigneeName ?? workOrder.teamName ?? "Unassigned"}
                </div>
                <div className="muted">Due {formatDue(workOrder.dueAt, timeZone)}</div>
                {moveControls(workOrder)}
              </article>
            ))}
          </div>
        ) : (
          <p className="muted">No unscheduled open work orders.</p>
        )}
      </section>
    </>
  );
}
