"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { rescheduleWorkOrderForDate } from "@/lib/maintenance/planning-calendar";

type CalendarWorkOrder = {
  id: string;
  number: string;
  title: string;
  status: string;
  priority: string;
  plannedStart: string | null;
  dueAt: string | null;
  assetCode: string | null;
  ownerName: string | null;
};

type CalendarItem = CalendarWorkOrder & {
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
  days: CalendarDay[];
  workOrders: CalendarWorkOrder[];
  unscheduled: CalendarWorkOrder[];
};

function statusLabel(value: string) {
  return value.toLowerCase().replaceAll("_", " ");
}

export default function CalendarRescheduler({
  organizationId,
  siteId,
  timeZone,
  days,
  workOrders,
  unscheduled,
}: Props) {
  const router = useRouter();
  const byId = useMemo(
    () => new Map([...workOrders, ...unscheduled].map((item) => [item.id, item])),
    [workOrders, unscheduled],
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selectedDates, setSelectedDates] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  async function move(workOrderId: string, targetDateKey: string) {
    const workOrder = byId.get(workOrderId);
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

  function moveControls(workOrder: CalendarWorkOrder) {
    const selectedDate = selectedDates[workOrder.id] ?? "";
    return (
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "end" }}>
        <label style={{ display: "grid", gap: 2, fontSize: 11 }}>
          Move to date
          <input
            type="date"
            value={selectedDate}
            disabled={busyId === workOrder.id}
            onChange={(event) =>
              setSelectedDates((current) => ({ ...current, [workOrder.id]: event.target.value }))
            }
          />
        </label>
        <button
          type="button"
          disabled={!selectedDate || busyId === workOrder.id}
          onClick={() => void move(workOrder.id, selectedDate)}
        >
          {busyId === workOrder.id ? "Moving…" : "Move"}
        </button>
      </div>
    );
  }

  function draggableProps(workOrderId: string, enabled: boolean) {
    return enabled
      ? {
          draggable: busyId !== workOrderId,
          onDragStart: (event: React.DragEvent<HTMLElement>) => {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/work-order-id", workOrderId);
          },
        }
      : {};
  }

  return (
    <>
      {error ? <div className="card" role="alert">{error}</div> : null}

      <section className="section" aria-label="Monthly maintenance calendar" style={{ overflowX: "auto" }}>
        <div style={{ minWidth: 980 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(140px, 1fr))", gap: 8 }}>
            {days.map((day) => (
              <section
                key={day.dateKey}
                className="card"
                aria-label={`${day.dateKey}, ${day.items.length} work-order events`}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const id = event.dataTransfer.getData("text/work-order-id");
                  if (id) void move(id, day.dateKey);
                }}
                style={{ minHeight: 180, padding: 10, opacity: day.inMonth ? 1 : 0.62 }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
                  <strong>{day.dayOfMonth}</strong>
                  {day.items.length ? <span className="badge">{day.items.length}</span> : null}
                </div>
                <div style={{ display: "grid", gap: 8 }}>
                  {day.items.map((item) => {
                    const canMove = item.planned && item.status !== "COMPLETED" && item.status !== "CANCELLED";
                    return (
                      <article
                        key={`${day.dateKey}-${item.id}`}
                        {...draggableProps(item.id, canMove)}
                        style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 8, display: "grid", gap: 5 }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
                          <Link className="table-link" href={`/maintenance/${item.id}`}><strong>{item.number}</strong></Link>
                          <span className="badge">{item.priority}</span>
                        </div>
                        <div style={{ fontSize: 13, fontWeight: 650 }}>{item.title}</div>
                        <div className="muted" style={{ fontSize: 12 }}>{item.assetCode ?? "No asset"} · {item.ownerName ?? "Unassigned"}</div>
                        <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                          {item.planned ? <span className="badge">START {item.plannedTime}</span> : null}
                          {item.due ? <span className="badge">DUE {item.dueTime}</span> : null}
                          <span className="badge">{statusLabel(item.status)}</span>
                        </div>
                        {canMove ? moveControls(item) : null}
                      </article>
                    );
                  })}
                  {day.items.length === 0 ? <div className="muted">Drop planned work here</div> : null}
                </div>
              </section>
            ))}
          </div>
        </div>
      </section>

      <section className="section card" aria-labelledby="unscheduled-title">
        <h2 id="unscheduled-title">Unscheduled work</h2>
        <p className="muted">Drag a card to a calendar day, or use the date field and Move button with the keyboard.</p>
        {unscheduled.length ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 10 }}>
            {unscheduled.map((workOrder) => (
              <article
                className="card"
                key={workOrder.id}
                {...draggableProps(workOrder.id, true)}
                style={{ padding: 12, display: "grid", gap: 7 }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
                  <Link className="table-link" href={`/maintenance/${workOrder.id}`}><strong>{workOrder.number}</strong></Link>
                  <span className="badge">{workOrder.priority}</span>
                </div>
                <div>{workOrder.title}</div>
                <div className="muted">{workOrder.assetCode ?? "No asset"} · {workOrder.ownerName ?? "Unassigned"}</div>
                {moveControls(workOrder)}
              </article>
            ))}
          </div>
        ) : <p className="muted">No unscheduled open work orders.</p>}
      </section>
    </>
  );
}