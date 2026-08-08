"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  dateKeyInTimeZone,
  rescheduleWorkOrderForDate,
} from "@/lib/maintenance/calendar-rescheduling";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

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
  unscheduled: CalendarWorkOrder[];
};

function statusLabel(value: string) {
  return value.toLowerCase().replaceAll("_", " ");
}

function localTime(value: string | null, timeZone: string) {
  if (!value) return null;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}

function WorkOrderCard({
  workOrder,
  planned,
  due,
  plannedTime,
  dueTime,
  timeZone,
  busy,
  selectedDate,
  onSelectedDate,
  onMove,
  onDragStart,
}: {
  workOrder: CalendarWorkOrder;
  planned: boolean;
  due: boolean;
  plannedTime: string | null;
  dueTime: string | null;
  timeZone: string;
  busy: boolean;
  selectedDate: string;
  onSelectedDate: (value: string) => void;
  onMove: () => void;
  onDragStart: (workOrderId: string, event: React.DragEvent<HTMLElement>) => void;
}) {
  const canReschedule = planned || workOrder.plannedStart === null;
  const displayedPlannedTime = plannedTime ?? localTime(workOrder.plannedStart, timeZone);
  const displayedDueTime = dueTime ?? localTime(workOrder.dueAt, timeZone);

  return (
    <article
      draggable={canReschedule && !busy}
      onDragStart={(event) => {
        if (canReschedule) onDragStart(workOrder.id, event);
      }}
      aria-label={`${workOrder.number} ${workOrder.title}`}
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
        <Link className="table-link" href={`/maintenance/${workOrder.id}`}>
          <strong>{workOrder.number}</strong>
        </Link>
        <span className="badge">{workOrder.priority}</span>
      </div>
      <div style={{ fontSize: 13, fontWeight: 650 }}>{workOrder.title}</div>
      <div className="muted" style={{ fontSize: 12 }}>
        {workOrder.assetCode ?? "No asset"} · {workOrder.assigneeName ?? workOrder.teamName ?? "Unassigned"}
      </div>
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
        {planned ? <span className="badge">START {displayedPlannedTime ?? "—"}</span> : null}
        {due ? <span className="badge">DUE {displayedDueTime ?? "—"}</span> : null}
        {!planned && workOrder.plannedStart === null ? <span className="badge">UNSCHEDULED</span> : null}
        <span className="badge">{statusLabel(workOrder.status)}</span>
      </div>
      {canReschedule ? (
        <div style={{ display: "flex", gap: 6, alignItems: "end", flexWrap: "wrap" }}>
          <label style={{ display: "grid", gap: 3, fontSize: 12 }}>
            Move to date
            <input
              aria-label={`Move ${workOrder.number} to date`}
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
      ) : null}
      {canReschedule ? (
        <span className="muted" style={{ fontSize: 11 }}>
          Drag this START card to another day, or use the date field for keyboard planning. Times stay in {timeZone}.
        </span>
      ) : null}
    </article>
  );
}

export default function CalendarPlanner({
  organizationId,
  siteId,
  timeZone,
  days,
  unscheduled,
}: Props) {
  const router = useRouter();
  const allWorkOrders = useMemo(() => {
    const map = new Map<string, CalendarWorkOrder>();
    for (const day of days) {
      for (const item of day.items) map.set(item.id, item);
    }
    for (const item of unscheduled) map.set(item.id, item);
    return map;
  }, [days, unscheduled]);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dates, setDates] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      [...allWorkOrders.values()].map((item) => [
        item.id,
        item.plannedStart ? dateKeyInTimeZone(new Date(item.plannedStart), timeZone) : "",
      ]),
    ),
  );

  async function moveWorkOrder(workOrderId: string, targetDateKey: string) {
    const workOrder = allWorkOrders.get(workOrderId);
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
      setDates((current) => ({ ...current, [workOrderId]: targetDateKey }));
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
                aria-label={`${day.dateKey}, ${day.items.length} calendar items`}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const id = event.dataTransfer.getData("text/work-order-id");
                  if (id) void moveWorkOrder(id, day.dateKey);
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
                  {day.items.map((item) => (
                    <WorkOrderCard
                      key={`${day.dateKey}-${item.id}`}
                      workOrder={item}
                      planned={item.planned}
                      due={item.due}
                      plannedTime={item.plannedTime}
                      dueTime={item.dueTime}
                      timeZone={timeZone}
                      busy={busyId === item.id}
                      selectedDate={dates[item.id] ?? ""}
                      onSelectedDate={(value) =>
                        setDates((current) => ({ ...current, [item.id]: value }))
                      }
                      onMove={() => void moveWorkOrder(item.id, dates[item.id] ?? "")}
                      onDragStart={startDrag}
                    />
                  ))}
                  {day.items.length === 0 ? (
                    <div className="muted" style={{ fontSize: 12 }}>Drop planned work here</div>
                  ) : null}
                </div>
              </section>
            ))}
          </div>
        </div>
      </section>

      <section className="section card" aria-labelledby="unscheduled-title">
        <div>
          <h2 id="unscheduled-title" style={{ marginTop: 0 }}>Unscheduled work</h2>
          <p className="muted">
            Drag a work order onto a calendar day or choose a date and press Move. New plans start at 08:00 in {timeZone}.
          </p>
        </div>
        {unscheduled.length ? (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
              gap: 10,
            }}
          >
            {unscheduled.map((workOrder) => (
              <WorkOrderCard
                key={workOrder.id}
                workOrder={workOrder}
                planned={false}
                due={Boolean(workOrder.dueAt)}
                plannedTime={null}
                dueTime={null}
                timeZone={timeZone}
                busy={busyId === workOrder.id}
                selectedDate={dates[workOrder.id] ?? ""}
                onSelectedDate={(value) =>
                  setDates((current) => ({ ...current, [workOrder.id]: value }))
                }
                onMove={() => void moveWorkOrder(workOrder.id, dates[workOrder.id] ?? "")}
                onDragStart={startDrag}
              />
            ))}
          </div>
        ) : (
          <div className="muted">No unscheduled open work orders.</div>
        )}
      </section>
    </>
  );
}
