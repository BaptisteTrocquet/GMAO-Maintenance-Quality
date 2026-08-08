"use client";

import Link from "next/link";
import { useState, type DragEvent } from "react";
import { useRouter } from "next/navigation";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

type CalendarItem = {
  id: string;
  number: string;
  title: string;
  status: string;
  priority: string;
  plannedStart: string | null;
  dueAt: string | null;
  planned: boolean;
  due: boolean;
  plannedTime: string | null;
  dueTime: string | null;
  assetCode: string | null;
  ownerName: string | null;
};

type CalendarDay = {
  dateKey: string;
  dayOfMonth: number;
  inMonth: boolean;
  items: CalendarItem[];
};

type UnscheduledItem = {
  id: string;
  number: string;
  title: string;
  status: string;
  priority: string;
  dueAt: string | null;
  assetCode: string | null;
  ownerName: string | null;
};

type Props = {
  organizationId: string;
  siteId: string;
  days: CalendarDay[];
  unscheduled: UnscheduledItem[];
  calendarTruncated: boolean;
  unscheduledTruncated: boolean;
  calendarLimit: number;
  unscheduledLimit: number;
};

function statusLabel(value: string) {
  return value.toLowerCase().replaceAll("_", " ");
}

function dateLabel(value: string | null) {
  return value ? value.slice(0, 10) : "—";
}

export default function CalendarPlanner({
  organizationId,
  siteId,
  days,
  unscheduled,
  calendarTruncated,
  unscheduledTruncated,
  calendarLimit,
  unscheduledLimit,
}: Props) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [targetDates, setTargetDates] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<{
    kind: "error" | "success";
    message: string;
  } | null>(null);

  async function reschedule(workOrderId: string, targetDate: string) {
    if (!targetDate || busyId) return;
    setBusyId(workOrderId);
    setFeedback(null);
    try {
      const response = await fetch(`/api/work-orders/${workOrderId}/reschedule`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId, siteId, targetDate }),
      });
      const body = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) {
        throw new Error(body.error?.message ?? "Work-order rescheduling failed");
      }
      setTargetDates((current) => ({ ...current, [workOrderId]: "" }));
      setFeedback({ kind: "success", message: `Work order moved to ${targetDate}.` });
      router.refresh();
    } catch (error) {
      setFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : "Work-order rescheduling failed",
      });
    } finally {
      setBusyId(null);
      setDraggingId(null);
    }
  }

  function startDrag(event: DragEvent, workOrderId: string) {
    setDraggingId(workOrderId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/work-order-id", workOrderId);
  }

  function drop(event: DragEvent, targetDate: string) {
    event.preventDefault();
    const workOrderId = event.dataTransfer.getData("text/work-order-id") || draggingId;
    if (workOrderId) void reschedule(workOrderId, targetDate);
  }

  function DateControl({
    workOrderId,
    number,
    currentDate,
  }: {
    workOrderId: string;
    number: string;
    currentDate: string | null;
  }) {
    const value = targetDates[workOrderId] ?? currentDate ?? "";
    return (
      <div style={{ display: "flex", gap: 5, alignItems: "end", marginTop: 6 }}>
        <label style={{ fontSize: 12 }}>
          <span className="muted">{currentDate ? "Move" : "Schedule"}</span>
          <input
            type="date"
            value={value}
            onChange={(event) =>
              setTargetDates((current) => ({ ...current, [workOrderId]: event.target.value }))
            }
            disabled={busyId === workOrderId}
            aria-label={`${currentDate ? "Move" : "Schedule"} ${number} to date`}
            style={{ display: "block", maxWidth: 135, padding: 4, marginTop: 3 }}
          />
        </label>
        <button
          type="button"
          disabled={busyId === workOrderId || !value}
          onClick={() => void reschedule(workOrderId, value)}
          aria-label={`${currentDate ? "Move" : "Schedule"} ${number}`}
          style={{ padding: "5px 8px" }}
        >
          {busyId === workOrderId ? "…" : "Apply"}
        </button>
      </div>
    );
  }

  return (
    <>
      {feedback ? (
        <section className="card" role={feedback.kind === "error" ? "alert" : "status"}>
          <strong>{feedback.kind === "error" ? "Reschedule failed" : "Planning updated"}</strong>
          <div>{feedback.message}</div>
        </section>
      ) : null}

      {calendarTruncated ? (
        <section className="card" role="status">
          Calendar rendering is bounded to {calendarLimit} matching work orders. Narrow the site or month before rescheduling a larger backlog.
        </section>
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
              <div key={weekday} className="card" style={{ padding: 10, textAlign: "center", fontWeight: 700 }}>
                {weekday}
              </div>
            ))}
          </div>

          <div
            role="grid"
            aria-label="Work-order planning calendar"
            style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(140px, 1fr))", gap: 8 }}
          >
            {days.map((day) => (
              <section
                key={day.dateKey}
                className="card"
                role="gridcell"
                tabIndex={0}
                aria-label={`${day.dateKey}, ${day.items.length} work-order marker${day.items.length === 1 ? "" : "s"}`}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }}
                onDrop={(event) => drop(event, day.dateKey)}
                style={{
                  minHeight: 190,
                  padding: 10,
                  opacity: day.inMonth ? 1 : 0.62,
                  alignSelf: "stretch",
                  outlineOffset: -2,
                  background: draggingId ? "#f8fafc" : undefined,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
                  <strong>{day.dayOfMonth}</strong>
                  {day.items.length ? <span className="badge">{day.items.length}</span> : null}
                </div>

                <div style={{ display: "grid", gap: 8 }}>
                  {day.items.map((item) =>
                    item.planned ? (
                      <article
                        key={`${day.dateKey}-${item.id}`}
                        draggable={busyId !== item.id}
                        onDragStart={(event) => startDrag(event, item.id)}
                        onDragEnd={() => setDraggingId(null)}
                        aria-label={`${item.number} ${item.title}, planned ${day.dateKey}`}
                        style={{
                          border: "1px solid #e5e7eb",
                          borderRadius: 8,
                          padding: 8,
                          display: "grid",
                          gap: 5,
                          cursor: "grab",
                          background: draggingId === item.id ? "#f3f4f6" : "white",
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 6, alignItems: "start" }}>
                          <Link className="table-link" href={`/maintenance/${item.id}`}>
                            <strong>{item.number}</strong>
                          </Link>
                          <span className="badge">{item.priority}</span>
                        </div>
                        <div style={{ fontSize: 13, fontWeight: 650 }}>{item.title}</div>
                        <div className="muted" style={{ fontSize: 12 }}>
                          {item.assetCode ?? "No asset"} · {item.ownerName ?? "Unassigned"}
                        </div>
                        <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                          <span className="badge">START {item.plannedTime}</span>
                          {item.due ? <span className="badge">DUE {item.dueTime}</span> : null}
                          <span className="badge">{statusLabel(item.status)}</span>
                        </div>
                        <DateControl workOrderId={item.id} number={item.number} currentDate={day.dateKey} />
                      </article>
                    ) : (
                      <div
                        key={`due-${day.dateKey}-${item.id}`}
                        style={{ borderLeft: "3px solid currentColor", paddingLeft: 6, fontSize: 12 }}
                      >
                        <Link className="table-link" href={`/maintenance/${item.id}`}>
                          <strong>DUE · {item.number}</strong>
                        </Link>
                        <div className="muted">{item.title}</div>
                      </div>
                    ),
                  )}
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
            <div className="muted">Drag onto a calendar day, or choose a date and Apply with the keyboard.</div>
          </div>
          {unscheduledTruncated ? <span className="badge">First {unscheduledLimit} shown</span> : null}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", gap: 10 }}>
          {unscheduled.map((workOrder) => (
            <article
              key={workOrder.id}
              draggable={busyId !== workOrder.id}
              onDragStart={(event) => startDrag(event, workOrder.id)}
              onDragEnd={() => setDraggingId(null)}
              className="card"
              style={{ padding: 12, cursor: "grab" }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <Link className="table-link" href={`/maintenance/${workOrder.id}`}>
                  <strong>{workOrder.number}</strong>
                </Link>
                <span className="badge">{workOrder.priority}</span>
              </div>
              <div>{workOrder.title}</div>
              <div className="muted">{workOrder.assetCode ?? "No asset"} · {workOrder.ownerName ?? "Unassigned"}</div>
              <div className="muted">Due {dateLabel(workOrder.dueAt)}</div>
              <DateControl workOrderId={workOrder.id} number={workOrder.number} currentDate={null} />
            </article>
          ))}
        </div>
        {unscheduled.length === 0 ? <p className="muted">No unscheduled open work orders.</p> : null}
      </section>
    </>
  );
}
