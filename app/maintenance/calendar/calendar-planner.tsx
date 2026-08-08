"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { movePlannedStartToDate } from "@/lib/maintenance/planning-calendar";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DRAG_TYPE = "application/x-open-gmao-work-order";

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

type UnscheduledItem = {
  id: string;
  number: string;
  title: string;
  status: string;
  priority: string;
  plannedStart: null;
  dueAt: string | null;
  assetCode: string | null;
  ownerName: string | null;
};

type Props = {
  organizationId: string;
  siteId: string;
  timeZone: string;
  days: CalendarDay[];
  unscheduled: UnscheduledItem[];
  unscheduledTruncated: boolean;
  unscheduledLimit: number;
};

type DragPayload = {
  id: string;
  plannedStart: string | null;
};

function statusLabel(value: string) {
  return value.toLowerCase().replaceAll("_", " ");
}

function localDateKey(value: string | null, timeZone: string) {
  if (!value) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
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
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  async function reschedule(payload: DragPayload, targetDateKey: string) {
    setBusyId(payload.id);
    setError(null);
    try {
      const plannedStart = movePlannedStartToDate({
        plannedStart: payload.plannedStart ? new Date(payload.plannedStart) : null,
        targetDateKey,
        timeZone,
      });
      const response = await fetch(`/api/work-orders/${payload.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId,
          siteId,
          plannedStart: plannedStart.toISOString(),
        }),
      });
      const body = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) {
        throw new Error(body.error?.message ?? "Work-order rescheduling failed");
      }
      router.refresh();
    } catch (rescheduleError) {
      setError(
        rescheduleError instanceof Error
          ? rescheduleError.message
          : "Work-order rescheduling failed",
      );
    } finally {
      setBusyId(null);
      setDropTarget(null);
    }
  }

  function beginDrag(event: React.DragEvent, payload: DragPayload) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(payload));
  }

  function readDrag(event: React.DragEvent): DragPayload | null {
    const raw = event.dataTransfer.getData(DRAG_TYPE);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<DragPayload>;
      if (typeof parsed.id !== "string") return null;
      return {
        id: parsed.id,
        plannedStart: typeof parsed.plannedStart === "string" ? parsed.plannedStart : null,
      };
    } catch {
      return null;
    }
  }

  function dateControl(payload: DragPayload, label: string) {
    return (
      <label style={{ display: "grid", gap: 3, fontSize: 11 }}>
        <span className="muted">Move date</span>
        <input
          type="date"
          aria-label={`Reschedule ${label}`}
          value={localDateKey(payload.plannedStart, timeZone)}
          disabled={busyId === payload.id}
          onChange={(event) => {
            if (event.target.value) void reschedule(payload, event.target.value);
          }}
          style={{ width: "100%", minWidth: 0 }}
        />
      </label>
    );
  }

  return (
    <>
      {error ? (
        <div className="card" role="alert" style={{ marginTop: 16, color: "#991b1b" }}>
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
            {days.map((day) => {
              const activeDrop = dropTarget === day.dateKey;
              return (
                <section
                  key={day.dateKey}
                  className="card"
                  aria-label={`${day.dateKey} planning drop zone`}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    setDropTarget(day.dateKey);
                  }}
                  onDragLeave={() => setDropTarget((current) => current === day.dateKey ? null : current)}
                  onDrop={(event) => {
                    event.preventDefault();
                    const payload = readDrag(event);
                    if (payload) void reschedule(payload, day.dateKey);
                  }}
                  style={{
                    minHeight: 210,
                    padding: 10,
                    opacity: day.inMonth ? 1 : 0.62,
                    alignSelf: "stretch",
                    outline: activeDrop ? "2px solid currentColor" : undefined,
                    outlineOffset: activeDrop ? 2 : undefined,
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
                      const payload = { id: item.id, plannedStart: item.plannedStart };
                      return (
                        <article
                          key={`${day.dateKey}-${item.id}`}
                          draggable={busyId !== item.id}
                          onDragStart={(event) => beginDrag(event, payload)}
                          onDragEnd={() => setDropTarget(null)}
                          aria-label={`${item.number} ${item.title}; draggable work order`}
                          style={{
                            border: "1px solid #e5e7eb",
                            borderRadius: 8,
                            padding: 8,
                            display: "grid",
                            gap: 6,
                            cursor: busyId === item.id ? "wait" : "grab",
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
                          {dateControl(payload, item.number)}
                        </article>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      </section>

      <section className="section card responsive-table" aria-labelledby="unscheduled-title">
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <h2 id="unscheduled-title" style={{ marginTop: 0 }}>Unscheduled work</h2>
            <div className="muted">Drag an open work order onto a calendar day, or use its date field.</div>
          </div>
          {unscheduledTruncated ? (
            <span className="badge">First {unscheduledLimit} shown</span>
          ) : null}
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
              <th>Plan date</th>
            </tr>
          </thead>
          <tbody>
            {unscheduled.map((workOrder) => {
              const payload = { id: workOrder.id, plannedStart: workOrder.plannedStart };
              return (
                <tr
                  key={workOrder.id}
                  draggable={busyId !== workOrder.id}
                  onDragStart={(event) => beginDrag(event, payload)}
                  onDragEnd={() => setDropTarget(null)}
                  style={{ cursor: busyId === workOrder.id ? "wait" : "grab" }}
                >
                  <td>
                    <Link className="table-link" href={`/maintenance/${workOrder.id}`}>
                      {workOrder.number} · {workOrder.title}
                    </Link>
                  </td>
                  <td>{workOrder.priority}</td>
                  <td><span className="badge">{statusLabel(workOrder.status)}</span></td>
                  <td>{workOrder.assetCode ?? "—"}</td>
                  <td>{workOrder.ownerName ?? "Unassigned"}</td>
                  <td>{workOrder.dueAt ? workOrder.dueAt.slice(0, 10) : "—"}</td>
                  <td style={{ minWidth: 150 }}>{dateControl(payload, workOrder.number)}</td>
                </tr>
              );
            })}
            {unscheduled.length === 0 ? (
              <tr><td colSpan={7}>No unscheduled open work orders.</td></tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </>
  );
}
