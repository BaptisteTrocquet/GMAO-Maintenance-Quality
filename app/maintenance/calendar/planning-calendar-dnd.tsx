"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type DragEvent } from "react";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export type DragCalendarItem = {
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
};

export type DragCalendarDay = {
  dateKey: string;
  dayOfMonth: number;
  inMonth: boolean;
  items: DragCalendarItem[];
};

export type DragUnscheduledWorkOrder = {
  id: string;
  number: string;
  title: string;
  status: string;
  priority: string;
  dueAt: string | null;
  assetCode: string | null;
  ownerName: string | null;
};

function statusLabel(value: string) {
  return value.toLowerCase().replaceAll("_", " ");
}

function dragId(event: DragEvent<HTMLElement>) {
  return event.dataTransfer.getData("application/x-work-order-id") || event.dataTransfer.getData("text/plain");
}

export function PlanningCalendarDnd({
  organizationId,
  siteId,
  days,
  unscheduled,
  unscheduledTruncated,
  unscheduledLimit,
}: {
  organizationId: string;
  siteId: string;
  days: DragCalendarDay[];
  unscheduled: DragUnscheduledWorkOrder[];
  unscheduledTruncated: boolean;
  unscheduledLimit: number;
}) {
  const router = useRouter();
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropDate, setDropDate] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function startDrag(event: DragEvent<HTMLElement>, workOrderId: string) {
    if (pendingId) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-work-order-id", workOrderId);
    event.dataTransfer.setData("text/plain", workOrderId);
    setDraggingId(workOrderId);
    setMessage(null);
    setError(null);
  }

  async function reschedule(workOrderId: string, dateKey: string) {
    setPendingId(workOrderId);
    setMessage(null);
    setError(null);
    try {
      const response = await fetch(`/api/work-orders/${encodeURIComponent(workOrderId)}/reschedule`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId, siteId, dateKey }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { error?: { message?: string }; data?: { number?: string } }
        | null;
      if (!response.ok) {
        throw new Error(payload?.error?.message ?? "The work order could not be rescheduled");
      }
      setMessage(`${payload?.data?.number ?? "Work order"} moved to ${dateKey}.`);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The work order could not be rescheduled");
    } finally {
      setPendingId(null);
      setDraggingId(null);
      setDropDate(null);
    }
  }

  function dropOnDate(event: DragEvent<HTMLElement>, dateKey: string) {
    event.preventDefault();
    const workOrderId = dragId(event);
    if (!workOrderId || pendingId) return;
    void reschedule(workOrderId, dateKey);
  }

  return (
    <>
      {message ? <p className="card" role="status">{message}</p> : null}
      {error ? <p className="card" role="alert">{error}</p> : null}

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

          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(140px, 1fr))", gap: 8 }}>
            {days.map((day) => (
              <section
                key={day.dateKey}
                className="card"
                aria-label={`${day.dateKey}${draggingId ? ", drop target" : ""}`}
                onDragEnter={(event) => {
                  if (!draggingId) return;
                  event.preventDefault();
                  setDropDate(day.dateKey);
                }}
                onDragOver={(event) => {
                  if (!draggingId) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }}
                onDragLeave={() => setDropDate((current) => (current === day.dateKey ? null : current))}
                onDrop={(event) => dropOnDate(event, day.dateKey)}
                style={{
                  minHeight: 180,
                  padding: 10,
                  opacity: day.inMonth ? 1 : 0.62,
                  alignSelf: "stretch",
                  outline: dropDate === day.dateKey ? "2px solid currentColor" : undefined,
                  outlineOffset: dropDate === day.dateKey ? 2 : undefined,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
                  <strong>{day.dayOfMonth}</strong>
                  {day.items.length ? <span className="badge">{day.items.length}</span> : null}
                </div>

                <div style={{ display: "grid", gap: 8 }}>
                  {day.items.map((item) => {
                    const draggable = item.planned && pendingId !== item.id;
                    return (
                      <article
                        key={`${day.dateKey}-${item.id}`}
                        draggable={draggable}
                        onDragStart={draggable ? (event) => startDrag(event, item.id) : undefined}
                        onDragEnd={() => {
                          setDraggingId(null);
                          setDropDate(null);
                        }}
                        title={item.planned ? "Drag to another day to reschedule" : "Due-date marker"}
                        style={{
                          border: "1px solid #e5e7eb",
                          borderRadius: 8,
                          padding: 8,
                          display: "grid",
                          gap: 5,
                          cursor: draggable ? "grab" : undefined,
                          opacity: pendingId === item.id ? 0.55 : 1,
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
                          {item.assetCode ?? "No asset"} · {item.assigneeName ?? item.teamName ?? "Unassigned"}
                        </div>
                        <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                          {item.planned ? <span className="badge">START {item.plannedTime}</span> : null}
                          {item.due ? <span className="badge">DUE {item.dueTime}</span> : null}
                          <span className="badge">{statusLabel(item.status)}</span>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        </div>
      </section>

      <section className="section card responsive-table" aria-labelledby="unscheduled-title">
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <h2 id="unscheduled-title" style={{ marginTop: 0 }}>Unscheduled work</h2>
            <div className="muted">
              Drag an open work order onto a calendar day. Unscheduled work starts at 09:00 in the site timezone.
            </div>
          </div>
          {unscheduledTruncated ? <span className="badge">First {unscheduledLimit} shown</span> : null}
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>WO</th>
              <th>Priority</th>
              <th>Status</th>
              <th>Asset</th>
              <th>Owner</th>
              <th>Due</th>
            </tr>
          </thead>
          <tbody>
            {unscheduled.map((workOrder) => (
              <tr key={workOrder.id}>
                <td>
                  <div
                    draggable={pendingId !== workOrder.id}
                    onDragStart={(event) => startDrag(event, workOrder.id)}
                    onDragEnd={() => {
                      setDraggingId(null);
                      setDropDate(null);
                    }}
                    style={{ cursor: pendingId ? undefined : "grab", opacity: pendingId === workOrder.id ? 0.55 : 1 }}
                    title="Drag onto a calendar day to schedule at 09:00 site-local time"
                  >
                    <Link className="table-link" href={`/maintenance/${workOrder.id}`}>
                      {workOrder.number} · {workOrder.title}
                    </Link>
                  </div>
                </td>
                <td>{workOrder.priority}</td>
                <td><span className="badge">{statusLabel(workOrder.status)}</span></td>
                <td>{workOrder.assetCode ?? "—"}</td>
                <td>{workOrder.ownerName ?? "Unassigned"}</td>
                <td>{workOrder.dueAt ? workOrder.dueAt.slice(0, 10) : "—"}</td>
              </tr>
            ))}
            {unscheduled.length === 0 ? <tr><td colSpan={6}>No unscheduled open work orders.</td></tr> : null}
          </tbody>
        </table>
      </section>
    </>
  );
}
