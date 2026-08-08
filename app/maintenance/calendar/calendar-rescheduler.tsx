"use client";

import Link from "next/link";
import { useMemo, useState, type DragEvent } from "react";
import { useRouter } from "next/navigation";
import { dateKeyInTimeZone, rescheduleWorkOrderForDate } from "@/lib/maintenance/planning-calendar";

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
  unscheduled: WorkOrder[];
  unscheduledTruncated: boolean;
};

function owner(workOrder: WorkOrder) {
  return workOrder.assigneeName ?? workOrder.teamName ?? "Unassigned";
}

export default function CalendarRescheduler({
  organizationId,
  siteId,
  timeZone,
  calendar,
  unscheduled,
  unscheduledTruncated,
}: Props) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [selectedDates, setSelectedDates] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<{ kind: "error" | "success"; message: string } | null>(null);

  const workOrders = useMemo(() => {
    const byId = new Map<string, WorkOrder>();
    for (const day of calendar) {
      for (const item of day.items) {
        if (!byId.has(item.id)) {
          byId.set(item.id, {
            id: item.id,
            number: item.number,
            title: item.title,
            status: item.status,
            priority: item.priority,
            plannedStart: item.plannedStart,
            dueAt: item.dueAt,
            assetCode: item.assetCode,
            assigneeName: item.assigneeName,
            teamName: item.teamName,
          });
        }
      }
    }
    for (const item of unscheduled) byId.set(item.id, item);
    return byId;
  }, [calendar, unscheduled]);

  async function move(workOrderId: string, targetDateKey: string) {
    const workOrder = workOrders.get(workOrderId);
    if (!workOrder || !targetDateKey) return;
    if (
      workOrder.plannedStart &&
      dateKeyInTimeZone(new Date(workOrder.plannedStart), timeZone) === targetDateKey
    ) {
      setDraggingId(null);
      return;
    }

    let schedule: ReturnType<typeof rescheduleWorkOrderForDate>;
    try {
      schedule = rescheduleWorkOrderForDate({
        plannedStart: workOrder.plannedStart ? new Date(workOrder.plannedStart) : null,
        dueAt: workOrder.dueAt ? new Date(workOrder.dueAt) : null,
        targetDateKey,
        timeZone,
      });
    } catch (error) {
      setFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : "Invalid planning date",
      });
      return;
    }

    setBusyId(workOrderId);
    setFeedback(null);
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
      setFeedback({ kind: "success", message: `${workOrder.number} moved to ${targetDateKey}.` });
      setSelectedDates((current) => ({ ...current, [workOrderId]: "" }));
      router.refresh();
    } catch (error) {
      setFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : "Unable to reschedule work order",
      });
    } finally {
      setBusyId(null);
      setDraggingId(null);
    }
  }

  function startDrag(event: DragEvent<HTMLElement>, workOrderId: string) {
    setDraggingId(workOrderId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/work-order-id", workOrderId);
  }

  function PlanningControls({ workOrder, defaultDate }: { workOrder: WorkOrder; defaultDate?: string }) {
    const currentDate = workOrder.plannedStart
      ? dateKeyInTimeZone(new Date(workOrder.plannedStart), timeZone)
      : defaultDate ?? "";
    const selected = selectedDates[workOrder.id] ?? currentDate;
    return (
      <div style={{ display: "flex", gap: 6, alignItems: "end", flexWrap: "wrap", marginTop: 6 }}>
        <label style={{ display: "grid", gap: 3, fontSize: 12 }}>
          {workOrder.plannedStart ? "Move to date" : "Plan on date"}
          <input
            type="date"
            value={selected}
            onChange={(event) =>
              setSelectedDates((current) => ({ ...current, [workOrder.id]: event.target.value }))
            }
            disabled={busyId === workOrder.id}
            aria-label={`${workOrder.plannedStart ? "Move" : "Plan"} ${workOrder.number} on date`}
          />
        </label>
        <button
          type="button"
          disabled={busyId === workOrder.id || !selected}
          onClick={() => void move(workOrder.id, selected)}
        >
          {busyId === workOrder.id ? "Moving…" : "Apply"}
        </button>
      </div>
    );
  }

  function PlannedCard({ item, dateKey }: { item: CalendarItem; dateKey: string }) {
    const workOrder = workOrders.get(item.id);
    if (!workOrder) return null;
    return (
      <article
        draggable={busyId !== item.id}
        onDragStart={(event) => startDrag(event, item.id)}
        onDragEnd={() => setDraggingId(null)}
        aria-label={`${item.number} ${item.title}, planned ${dateKey}`}
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 8,
          padding: 8,
          display: "grid",
          gap: 5,
          cursor: "grab",
          opacity: draggingId === item.id ? 0.65 : 1,
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
          {item.assetCode ?? "No asset"} · {owner(item)}
        </div>
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
          <span className="badge">START {item.plannedTime}</span>
          {item.due ? <span className="badge">DUE {item.dueTime}</span> : null}
          <span className="badge">{item.status.toLowerCase().replaceAll("_", " ")}</span>
        </div>
        <PlanningControls workOrder={workOrder} defaultDate={dateKey} />
      </article>
    );
  }

  return (
    <>
      {feedback ? (
        <section className="card" role={feedback.kind === "error" ? "alert" : "status"}>
          <strong>{feedback.kind === "error" ? "Planning update failed" : "Planning updated"}</strong>
          <div>{feedback.message}</div>
        </section>
      ) : null}

      <section className="section" aria-label="Monthly maintenance calendar" style={{ overflowX: "auto" }}>
        <div style={{ minWidth: 1120 }}>
          <div
            aria-hidden="true"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(7, minmax(160px, 1fr))",
              gap: 8,
              marginBottom: 8,
            }}
          >
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((weekday) => (
              <div key={weekday} className="card" style={{ padding: 10, textAlign: "center", fontWeight: 700 }}>
                {weekday}
              </div>
            ))}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(160px, 1fr))", gap: 8 }}>
            {calendar.map((day) => {
              const plannedItems = day.items.filter((item) => item.planned);
              const dueOnlyItems = day.items.filter((item) => item.due && !item.planned);
              return (
                <section
                  key={day.dateKey}
                  className="card"
                  tabIndex={0}
                  aria-label={`${day.dateKey}, ${plannedItems.length} planned, ${dueOnlyItems.length} due markers`}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const id = event.dataTransfer.getData("text/work-order-id") || draggingId;
                    if (id) void move(id, day.dateKey);
                  }}
                  style={{
                    minHeight: 190,
                    padding: 10,
                    opacity: day.inMonth ? 1 : 0.62,
                    alignSelf: "stretch",
                    background: draggingId ? "#f8fafc" : undefined,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
                    <strong>{day.dayOfMonth}</strong>
                    {day.items.length ? <span className="badge">{day.items.length}</span> : null}
                  </div>
                  <div style={{ display: "grid", gap: 8 }}>
                    {plannedItems.map((item) => <PlannedCard key={`start-${item.id}`} item={item} dateKey={day.dateKey} />)}
                    {dueOnlyItems.map((item) => (
                      <div key={`due-${item.id}`} style={{ borderLeft: "3px solid currentColor", paddingLeft: 6, fontSize: 12 }}>
                        <Link className="table-link" href={`/maintenance/${item.id}`}>
                          <strong>DUE {item.dueTime} · {item.number}</strong>
                        </Link>
                        <div className="muted">{item.title}</div>
                      </div>
                    ))}
                    {plannedItems.length === 0 && draggingId ? (
                      <div className="muted" style={{ fontSize: 12 }}>Drop work here</div>
                    ) : null}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      </section>

      <section className="section card" aria-labelledby="unscheduled-title">
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <h2 id="unscheduled-title" style={{ marginTop: 0 }}>Unscheduled work</h2>
            <div className="muted">Drag a card to a calendar day or use the date field and Apply button.</div>
          </div>
          {unscheduledTruncated ? <span className="badge">First 100 shown</span> : null}
        </div>
        {unscheduled.length ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 10 }}>
            {unscheduled.map((workOrder) => (
              <article
                key={workOrder.id}
                className="card"
                draggable={busyId !== workOrder.id}
                onDragStart={(event) => startDrag(event, workOrder.id)}
                onDragEnd={() => setDraggingId(null)}
                style={{ padding: 12, cursor: "grab" }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <Link className="table-link" href={`/maintenance/${workOrder.id}`}>
                    <strong>{workOrder.number}</strong>
                  </Link>
                  <span className="badge">{workOrder.priority}</span>
                </div>
                <div>{workOrder.title}</div>
                <div className="muted">{workOrder.assetCode ?? "No asset"} · {owner(workOrder)}</div>
                <div className="muted">
                  Due {workOrder.dueAt ? dateKeyInTimeZone(new Date(workOrder.dueAt), timeZone) : "—"}
                </div>
                <PlanningControls workOrder={workOrder} />
              </article>
            ))}
          </div>
        ) : (
          <div className="muted">No unscheduled open work orders.</div>
        )}
      </section>
    </>
  );
}
