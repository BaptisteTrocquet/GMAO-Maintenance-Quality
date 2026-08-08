"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type WorkOrder = {
  id: string;
  number: string;
  title: string;
  status: string;
  priority: string;
  plannedStart: string | null;
  dueAt: string | null;
  plannedDateKey: string | null;
  dueDateKey: string | null;
  plannedTime: string | null;
  assetCode: string | null;
  ownerName: string | null;
};

type Props = {
  organizationId: string;
  siteId: string;
  monthKey: string;
  gridDates: Array<string | null>;
  workOrders: WorkOrder[];
  unplanned: WorkOrder[];
  calendarTruncated: boolean;
  unplannedTruncated: boolean;
};

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function dayNumber(dateKey: string) {
  return Number(dateKey.slice(-2));
}

export default function PlanningCalendarBoard({
  organizationId,
  siteId,
  monthKey,
  gridDates,
  workOrders,
  unplanned,
  calendarTruncated,
  unplannedTruncated,
}: Props) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [targetDates, setTargetDates] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<{ kind: "error" | "success"; message: string } | null>(null);

  const plannedByDate = useMemo(() => {
    const result = new Map<string, WorkOrder[]>();
    for (const workOrder of workOrders) {
      if (!workOrder.plannedDateKey) continue;
      result.set(workOrder.plannedDateKey, [
        ...(result.get(workOrder.plannedDateKey) ?? []),
        workOrder,
      ]);
    }
    return result;
  }, [workOrders]);

  const dueByDate = useMemo(() => {
    const result = new Map<string, WorkOrder[]>();
    for (const workOrder of workOrders) {
      if (!workOrder.dueDateKey || workOrder.dueDateKey === workOrder.plannedDateKey) continue;
      result.set(workOrder.dueDateKey, [...(result.get(workOrder.dueDateKey) ?? []), workOrder]);
    }
    return result;
  }, [workOrders]);

  async function reschedule(workOrderId: string, targetDate: string) {
    if (!targetDate) return;
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
      setFeedback({ kind: "success", message: `Work order moved to ${targetDate}.` });
      setTargetDates((current) => ({ ...current, [workOrderId]: "" }));
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

  function dragStart(event: React.DragEvent, workOrderId: string) {
    setDraggingId(workOrderId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/work-order-id", workOrderId);
  }

  function drop(event: React.DragEvent, targetDate: string) {
    event.preventDefault();
    const workOrderId = event.dataTransfer.getData("text/work-order-id") || draggingId;
    if (workOrderId) void reschedule(workOrderId, targetDate);
  }

  function PlanningControls({ workOrder, compact = false }: { workOrder: WorkOrder; compact?: boolean }) {
    const value = targetDates[workOrder.id] ?? workOrder.plannedDateKey ?? "";
    return (
      <div style={{ display: "flex", gap: 5, alignItems: "center", marginTop: compact ? 5 : 8 }}>
        <label style={{ fontSize: 12 }}>
          <span className="muted">{workOrder.plannedDateKey ? "Move" : "Schedule"}</span>
          <input
            type="date"
            value={value}
            onChange={(event) => setTargetDates((current) => ({
              ...current,
              [workOrder.id]: event.target.value,
            }))}
            disabled={busyId === workOrder.id}
            aria-label={`${workOrder.plannedDateKey ? "Move" : "Schedule"} ${workOrder.number} to date`}
            style={{ display: "block", maxWidth: 130, padding: 4, marginTop: 3 }}
          />
        </label>
        <button
          type="button"
          disabled={busyId === workOrder.id || !value}
          onClick={() => void reschedule(workOrder.id, value)}
          aria-label={`${workOrder.plannedDateKey ? "Move" : "Schedule"} ${workOrder.number}`}
          style={{ padding: "5px 7px", alignSelf: "end" }}
        >
          {busyId === workOrder.id ? "…" : "Apply"}
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

      <section className="card section" aria-label={`Maintenance planning calendar ${monthKey}`}>
        {calendarTruncated ? (
          <p className="muted" role="status">
            The calendar is bounded to the first 500 matching work orders. Narrow the month or site scope before rescheduling large backlogs.
          </p>
        ) : null}
        <div
          role="grid"
          aria-label={`Work-order calendar ${monthKey}`}
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(7, minmax(180px, 1fr))",
            minWidth: 1260,
            gap: 1,
            background: "#e5e7eb",
            border: "1px solid #e5e7eb",
            overflow: "hidden",
          }}
        >
          {WEEKDAYS.map((weekday) => (
            <div
              key={weekday}
              role="columnheader"
              style={{ background: "white", padding: 8, fontWeight: 700 }}
            >
              {weekday}
            </div>
          ))}

          {gridDates.map((dateKey, index) => {
            if (!dateKey) {
              return <div key={`empty-${index}`} role="gridcell" aria-hidden="true" style={{ background: "#f8fafc", minHeight: 150 }} />;
            }
            const planned = plannedByDate.get(dateKey) ?? [];
            const due = dueByDate.get(dateKey) ?? [];
            return (
              <div
                key={dateKey}
                role="gridcell"
                tabIndex={0}
                aria-label={`${dateKey}, ${planned.length} planned work orders, ${due.length} due markers`}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }}
                onDrop={(event) => drop(event, dateKey)}
                style={{
                  background: draggingId ? "#f8fafc" : "white",
                  minHeight: 170,
                  padding: 8,
                  outlineOffset: -2,
                }}
              >
                <div style={{ fontWeight: 700, marginBottom: 7 }}>{dayNumber(dateKey)}</div>
                <div style={{ display: "grid", gap: 6 }}>
                  {planned.map((workOrder) => (
                    <article
                      key={workOrder.id}
                      draggable={busyId !== workOrder.id}
                      onDragStart={(event) => dragStart(event, workOrder.id)}
                      onDragEnd={() => setDraggingId(null)}
                      aria-label={`${workOrder.number} ${workOrder.title}, planned ${dateKey}`}
                      style={{
                        border: "1px solid #d1d5db",
                        borderRadius: 8,
                        padding: 7,
                        background: draggingId === workOrder.id ? "#f3f4f6" : "white",
                        cursor: "grab",
                      }}
                    >
                      <Link className="table-link" href={`/maintenance/${workOrder.id}`}>
                        <strong>{workOrder.number}</strong>
                      </Link>
                      <div style={{ fontSize: 13 }}>{workOrder.title}</div>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {workOrder.plannedTime ?? "08:00"} · {workOrder.assetCode ?? "No asset"}
                      </div>
                      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 4 }}>
                        <span className="badge">{workOrder.priority}</span>
                        <span className="badge">{workOrder.status}</span>
                      </div>
                      <PlanningControls workOrder={workOrder} compact />
                    </article>
                  ))}

                  {due.map((workOrder) => (
                    <div
                      key={`due-${workOrder.id}`}
                      style={{ borderLeft: "3px solid currentColor", paddingLeft: 6, fontSize: 12 }}
                    >
                      <strong>Due · {workOrder.number}</strong>
                      <div className="muted">{workOrder.title}</div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="card section">
        <div className="header" style={{ marginBottom: 12 }}>
          <div>
            <h2 style={{ margin: 0 }}>Unplanned backlog</h2>
            <div className="muted">Drag a work order onto a calendar day, or use the date control with the keyboard.</div>
          </div>
          <span className="badge">{unplanned.length}{unplannedTruncated ? "+" : ""}</span>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))",
            gap: 10,
          }}
        >
          {unplanned.map((workOrder) => (
            <article
              key={workOrder.id}
              draggable={busyId !== workOrder.id}
              onDragStart={(event) => dragStart(event, workOrder.id)}
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
              <div className="muted">
                {workOrder.assetCode ?? "No asset"} · {workOrder.ownerName ?? "Unassigned"}
              </div>
              <div className="muted">Due {workOrder.dueDateKey ?? "—"}</div>
              <PlanningControls workOrder={workOrder} />
            </article>
          ))}
        </div>
        {unplanned.length === 0 ? <p className="muted">No unplanned active work orders.</p> : null}
        {unplannedTruncated ? (
          <p className="muted" role="status">Showing the first 50 unplanned work orders.</p>
        ) : null}
      </section>
    </>
  );
}
