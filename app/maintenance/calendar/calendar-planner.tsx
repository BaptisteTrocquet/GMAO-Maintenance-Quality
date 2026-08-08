"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  dateKeyInTimeZone,
  rescheduleWorkOrderForDate,
} from "@/lib/maintenance/planning-calendar";

type CalendarWorkOrder = {
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

type Props = {
  organizationId: string;
  siteId: string;
  timeZone: string;
  days: Array<{ key: string; label: string }>;
  workOrders: CalendarWorkOrder[];
  unscheduled: CalendarWorkOrder[];
};

function formatTime(value: string | null, timeZone: string) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function WorkOrderCard({
  workOrder,
  timeZone,
  busy,
  selectedDate,
  onSelectedDate,
  onMove,
  onDragStart,
}: {
  workOrder: CalendarWorkOrder;
  timeZone: string;
  busy: boolean;
  selectedDate: string;
  onSelectedDate: (value: string) => void;
  onMove: () => void;
  onDragStart: (workOrderId: string, event: React.DragEvent<HTMLElement>) => void;
}) {
  return (
    <article
      className="card"
      draggable={!busy}
      onDragStart={(event) => onDragStart(workOrder.id, event)}
      aria-label={`${workOrder.number} ${workOrder.title}`}
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
        {workOrder.assetCode ?? "No asset"} · {workOrder.assigneeName ?? workOrder.teamName ?? "Unassigned"}
      </div>
      <div className="muted">
        {workOrder.plannedStart ? `Start ${formatTime(workOrder.plannedStart, timeZone)}` : "Not planned"}
        {workOrder.dueAt ? ` · Due ${formatTime(workOrder.dueAt, timeZone)}` : ""}
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "end", flexWrap: "wrap" }}>
        <label style={{ display: "grid", gap: 3, fontSize: 12 }}>
          Move to date
          <input
            type="date"
            value={selectedDate}
            onChange={(event) => onSelectedDate(event.target.value)}
            disabled={busy}
          />
        </label>
        <button type="button" onClick={onMove} disabled={busy || !selectedDate}>
          {busy ? "Moving…" : "Move"}
        </button>
      </div>
    </article>
  );
}

export default function CalendarPlanner({
  organizationId,
  siteId,
  timeZone,
  days,
  workOrders,
  unscheduled,
}: Props) {
  const router = useRouter();
  const allItems = useMemo(() => [...workOrders, ...unscheduled], [workOrders, unscheduled]);
  const byId = useMemo(() => new Map(allItems.map((item) => [item.id, item])), [allItems]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dates, setDates] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      allItems.map((item) => [
        item.id,
        item.plannedStart ? dateKeyInTimeZone(new Date(item.plannedStart), timeZone) : days[0]?.key ?? "",
      ]),
    ),
  );

  const grouped = useMemo(() => {
    const result = new Map<string, CalendarWorkOrder[]>();
    for (const day of days) result.set(day.key, []);
    for (const workOrder of workOrders) {
      if (!workOrder.plannedStart) continue;
      const key = dateKeyInTimeZone(new Date(workOrder.plannedStart), timeZone);
      result.get(key)?.push(workOrder);
    }
    return result;
  }, [days, timeZone, workOrders]);

  async function moveWorkOrder(workOrderId: string, targetDateKey: string) {
    const workOrder = byId.get(workOrderId);
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
      const response = await fetch(`/api/work-orders/${workOrder.id}`, {
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

  function card(workOrder: CalendarWorkOrder) {
    return (
      <WorkOrderCard
        key={workOrder.id}
        workOrder={workOrder}
        timeZone={timeZone}
        busy={busyId === workOrder.id}
        selectedDate={dates[workOrder.id] ?? ""}
        onSelectedDate={(value) => setDates((current) => ({ ...current, [workOrder.id]: value }))}
        onMove={() => moveWorkOrder(workOrder.id, dates[workOrder.id] ?? "")}
        onDragStart={startDrag}
      />
    );
  }

  return (
    <>
      {error ? (
        <div className="card" role="alert" style={{ borderColor: "currentColor", marginBottom: 12 }}>
          {error}
        </div>
      ) : null}

      <div style={{ overflowX: "auto", paddingBottom: 8 }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${days.length}, minmax(220px, 1fr))`,
            gap: 10,
            minWidth: days.length * 220,
            alignItems: "start",
          }}
        >
          {days.map((day) => {
            const items = grouped.get(day.key) ?? [];
            return (
              <section
                key={day.key}
                aria-label={`${day.label}, ${items.length} planned work orders`}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const id = event.dataTransfer.getData("text/work-order-id");
                  if (id) void moveWorkOrder(id, day.key);
                }}
                style={{ display: "grid", gap: 8, minWidth: 0 }}
              >
                <div className="card" style={{ padding: 10, position: "sticky", top: 0, zIndex: 1 }}>
                  <strong>{day.label}</strong>
                  <div className="muted">{items.length} planned</div>
                </div>
                {items.map(card)}
                {items.length === 0 ? (
                  <div className="card muted" style={{ padding: 12 }}>Drop work here</div>
                ) : null}
              </section>
            );
          })}
        </div>
      </div>

      <section className="card section" aria-labelledby="unscheduled-heading">
        <h2 id="unscheduled-heading">Not planned</h2>
        <p className="muted">
          Drag a card onto a calendar day or use the date field and Move button for keyboard planning.
        </p>
        {unscheduled.length ? (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
              gap: 10,
            }}
          >
            {unscheduled.map(card)}
          </div>
        ) : (
          <div className="muted">No unplanned work orders in this site.</div>
        )}
      </section>
    </>
  );
}
