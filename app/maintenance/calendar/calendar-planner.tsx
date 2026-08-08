"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { rescheduleWorkOrderForDate } from "@/lib/maintenance/rescheduling";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

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

type UnscheduledWorkOrder = {
  id: string;
  number: string;
  title: string;
  status: string;
  priority: string;
  plannedStart: null;
  dueAt: string | null;
  assetCode: string | null;
  assigneeName: string | null;
  teamName: string | null;
};

type Props = {
  organizationId: string;
  siteId: string;
  timeZone: string;
  days: CalendarDay[];
  unscheduled: UnscheduledWorkOrder[];
  unscheduledTruncated: boolean;
  unscheduledLimit: number;
};

function statusLabel(value: string) {
  return value.toLowerCase().replaceAll("_", " ");
}

export default function CalendarPlanner({
  organizationId,
  siteId,
  timeZone,
  days,
  unscheduled,
  unscheduledTruncated,
  unscheduledLimit,
}: Props) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dates, setDates] = useState<Record<string, string>>({});

  const movableById = useMemo(() => {
    const values = new Map<string, CalendarItem | UnscheduledWorkOrder>();
    for (const day of days) {
      for (const item of day.items) {
        if (item.planned) values.set(item.id, item);
      }
    }
    for (const item of unscheduled) values.set(item.id, item);
    return values;
  }, [days, unscheduled]);

  async function moveWorkOrder(workOrderId: string, targetDateKey: string) {
    const workOrder = movableById.get(workOrderId);
    if (!workOrder || !targetDateKey) return;

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

  function moveControls(item: CalendarItem | UnscheduledWorkOrder) {
    const busy = busyId === item.id;
    return (
      <div className="calendar-move-controls">
        <label>
          <span className="sr-only">Move {item.number} to date</span>
          <input
            type="date"
            value={dates[item.id] ?? ""}
            onChange={(event) => setDates((current) => ({ ...current, [item.id]: event.target.value }))}
            disabled={busy}
            aria-label={`Move ${item.number} to date`}
          />
        </label>
        <button
          type="button"
          onClick={() => moveWorkOrder(item.id, dates[item.id] ?? "")}
          disabled={busy || !dates[item.id]}
        >
          {busy ? "Moving…" : "Move"}
        </button>
      </div>
    );
  }

  return (
    <>
      {error ? <div className="card calendar-error" role="alert">{error}</div> : null}

      <section className="section calendar-scroll" aria-label="Monthly maintenance calendar">
        <div className="calendar-month-grid">
          <div className="calendar-weekdays" aria-hidden="true">
            {WEEKDAYS.map((weekday) => (
              <div key={weekday} className="card calendar-weekday"><strong>{weekday}</strong></div>
            ))}
          </div>

          <div className="calendar-days">
            {days.map((day) => (
              <section
                key={day.dateKey}
                className="card calendar-day"
                aria-label={day.dateKey}
                data-date={day.dateKey}
                data-in-month={day.inMonth ? "true" : "false"}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const workOrderId = event.dataTransfer.getData("text/work-order-id");
                  if (workOrderId) void moveWorkOrder(workOrderId, day.dateKey);
                }}
              >
                <div className="calendar-day-header">
                  <strong>{day.dayOfMonth}</strong>
                  {day.items.length ? <span className="badge">{day.items.length}</span> : null}
                </div>

                <div className="calendar-day-items">
                  {day.items.map((item) => (
                    <article
                      key={`${day.dateKey}-${item.id}`}
                      className={`calendar-event${item.planned ? " calendar-event-planned" : ""}`}
                      draggable={item.planned && busyId !== item.id}
                      onDragStart={item.planned ? (event) => startDrag(item.id, event) : undefined}
                      aria-label={`${item.number} ${item.title}${item.planned ? ", planned item" : ", due marker"}`}
                    >
                      <div className="calendar-event-header">
                        <Link className="table-link" href={`/maintenance/${item.id}`}>
                          <strong>{item.number}</strong>
                        </Link>
                        <span className="badge">{item.priority}</span>
                      </div>
                      <div className="calendar-event-title">{item.title}</div>
                      <div className="muted calendar-event-meta">
                        {item.assetCode ?? "No asset"} · {item.assigneeName ?? item.teamName ?? "Unassigned"}
                      </div>
                      <div className="calendar-event-tags">
                        {item.planned ? <span className="badge">START {item.plannedTime}</span> : null}
                        {item.due ? <span className="badge">DUE {item.dueTime}</span> : null}
                        <span className="badge">{statusLabel(item.status)}</span>
                      </div>
                      {item.planned ? moveControls(item) : null}
                    </article>
                  ))}
                  {day.items.length === 0 ? <div className="calendar-drop-hint muted">Drop planned work here</div> : null}
                </div>
              </section>
            ))}
          </div>
        </div>
      </section>

      <section className="section card" aria-labelledby="unscheduled-title">
        <div className="calendar-unscheduled-header">
          <div>
            <h2 id="unscheduled-title">Unscheduled work</h2>
            <div className="muted">Drag onto a calendar day, or use the date field and Move button.</div>
          </div>
          {unscheduledTruncated ? <span className="badge">First {unscheduledLimit} shown</span> : null}
        </div>

        {unscheduled.length ? (
          <div className="calendar-unscheduled-grid">
            {unscheduled.map((item) => (
              <article
                key={item.id}
                className="calendar-event calendar-event-planned"
                draggable={busyId !== item.id}
                onDragStart={(event) => startDrag(item.id, event)}
                aria-label={`${item.number} ${item.title}, unscheduled item`}
              >
                <div className="calendar-event-header">
                  <Link className="table-link" href={`/maintenance/${item.id}`}><strong>{item.number}</strong></Link>
                  <span className="badge">{item.priority}</span>
                </div>
                <div className="calendar-event-title">{item.title}</div>
                <div className="muted calendar-event-meta">
                  {item.assetCode ?? "No asset"} · {item.assigneeName ?? item.teamName ?? "Unassigned"}
                </div>
                <div className="calendar-event-tags">
                  <span className="badge">{statusLabel(item.status)}</span>
                  {item.dueAt ? <span className="badge">HAS DUE DATE</span> : null}
                </div>
                {moveControls(item)}
              </article>
            ))}
          </div>
        ) : <div className="muted">No unscheduled open work orders.</div>}
      </section>
    </>
  );
}
