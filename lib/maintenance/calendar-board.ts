import type { Priority, WorkOrderStatus } from "@prisma/client";

export type MaintenanceCalendarEvent = {
  id: string;
  sourceId: string;
  kind: "WORK_ORDER_START" | "WORK_ORDER_DUE" | "PLAN_DUE";
  date: Date;
  title: string;
  label: string;
  href: string;
  status: WorkOrderStatus | "PLAN_DUE";
  priority: Priority | null;
  assetCode: string | null;
};

export function monthKey(value: Date) {
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function calendarMonthRange(month: string | undefined, now = new Date()) {
  const match = month?.match(/^(\d{4})-(\d{2})$/);
  const parsedYear = match ? Number(match[1]) : now.getUTCFullYear();
  const parsedMonth = match ? Number(match[2]) : now.getUTCMonth() + 1;
  const valid = parsedYear >= 1970 && parsedYear <= 9999 && parsedMonth >= 1 && parsedMonth <= 12;
  const year = valid ? parsedYear : now.getUTCFullYear();
  const monthIndex = valid ? parsedMonth - 1 : now.getUTCMonth();
  const start = new Date(Date.UTC(year, monthIndex, 1));
  const end = new Date(Date.UTC(year, monthIndex + 1, 1));
  return {
    start,
    end,
    key: monthKey(start),
    previousKey: monthKey(new Date(Date.UTC(year, monthIndex - 1, 1))),
    nextKey: monthKey(new Date(Date.UTC(year, monthIndex + 1, 1))),
  };
}

export function dayKey(value: Date) {
  return value.toISOString().slice(0, 10);
}

export function buildMonthGrid(start: Date) {
  const mondayIndex = (start.getUTCDay() + 6) % 7;
  const gridStart = new Date(start);
  gridStart.setUTCDate(gridStart.getUTCDate() - mondayIndex);
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart);
    date.setUTCDate(gridStart.getUTCDate() + index);
    return date;
  });
}

export function groupCalendarEvents(events: MaintenanceCalendarEvent[]) {
  const grouped = new Map<string, MaintenanceCalendarEvent[]>();
  for (const event of events) {
    const key = dayKey(event.date);
    const items = grouped.get(key) ?? [];
    items.push(event);
    grouped.set(key, items);
  }
  const kindRank = { PLAN_DUE: 0, WORK_ORDER_START: 1, WORK_ORDER_DUE: 2 } as const;
  for (const items of grouped.values()) {
    items.sort(
      (left, right) =>
        kindRank[left.kind] - kindRank[right.kind] || left.title.localeCompare(right.title),
    );
  }
  return grouped;
}
