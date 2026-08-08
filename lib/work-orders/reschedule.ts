import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

const MAX_TRANSACTION_ATTEMPTS = 4;

type LocalDateTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export class WorkOrderRescheduleError extends Error {
  constructor(
    public readonly code:
      | "WORK_ORDER_NOT_FOUND"
      | "WORK_ORDER_NOT_RESCHEDULABLE"
      | "INVALID_TARGET_DATE"
      | "INVALID_PLANNING",
    message: string,
  ) {
    super(message);
    this.name = "WorkOrderRescheduleError";
  }
}

function localParts(date: Date, timeZone: string): LocalDateTime {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

function localDateTimeToUtc(value: LocalDateTime, timeZone: string) {
  const targetAsUtc = Date.UTC(
    value.year,
    value.month - 1,
    value.day,
    value.hour,
    value.minute,
    value.second,
  );
  let candidate = new Date(targetAsUtc);

  for (let iteration = 0; iteration < 6; iteration += 1) {
    const actual = localParts(candidate, timeZone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    const delta = targetAsUtc - actualAsUtc;
    if (delta === 0) return candidate;
    candidate = new Date(candidate.getTime() + delta);
  }

  const resolved = localParts(candidate, timeZone);
  if (
    resolved.year !== value.year ||
    resolved.month !== value.month ||
    resolved.day !== value.day ||
    resolved.hour !== value.hour ||
    resolved.minute !== value.minute
  ) {
    throw new WorkOrderRescheduleError(
      "INVALID_TARGET_DATE",
      "Target date/time does not exist in the organization timezone",
    );
  }
  return candidate;
}

function parseDateKey(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new WorkOrderRescheduleError("INVALID_TARGET_DATE", "Target date must use YYYY-MM-DD");
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    throw new WorkOrderRescheduleError("INVALID_TARGET_DATE", "Target date is not a valid calendar date");
  }
  return { year, month, day };
}

function localDayNumber(value: Pick<LocalDateTime, "year" | "month" | "day">) {
  return Math.floor(Date.UTC(value.year, value.month - 1, value.day) / 86_400_000);
}

function dateFromDayNumber(dayNumber: number) {
  const date = new Date(dayNumber * 86_400_000);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

export function calculateRescheduledDates(input: {
  plannedStart: Date | null;
  dueAt: Date | null;
  targetDateKey: string;
  timeZone: string;
}) {
  const target = parseDateKey(input.targetDateKey);
  const oldStartLocal = input.plannedStart ? localParts(input.plannedStart, input.timeZone) : null;
  const plannedStart = localDateTimeToUtc(
    {
      ...target,
      hour: oldStartLocal?.hour ?? 8,
      minute: oldStartLocal?.minute ?? 0,
      second: oldStartLocal?.second ?? 0,
    },
    input.timeZone,
  );

  let dueAt = input.dueAt;
  if (input.plannedStart && input.dueAt) {
    const oldDueLocal = localParts(input.dueAt, input.timeZone);
    const dayOffset = localDayNumber(oldDueLocal) - localDayNumber(oldStartLocal!);
    const targetDueDate = dateFromDayNumber(localDayNumber(target) + dayOffset);
    dueAt = localDateTimeToUtc(
      {
        ...targetDueDate,
        hour: oldDueLocal.hour,
        minute: oldDueLocal.minute,
        second: oldDueLocal.second,
      },
      input.timeZone,
    );
  }

  if (dueAt && dueAt.getTime() < plannedStart.getTime()) {
    throw new WorkOrderRescheduleError(
      "INVALID_PLANNING",
      "Rescheduling would place plannedStart after dueAt",
    );
  }
  return { plannedStart, dueAt };
}

function retryable(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
}

export async function rescheduleWorkOrder(input: {
  organizationId: string;
  siteId: string;
  workOrderId: string;
  targetDateKey: string;
  timeZone: string;
  actorId: string;
}) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      return await db.$transaction(
        async (tx) => {
          const workOrder = await tx.workOrder.findFirst({
            where: {
              id: input.workOrderId,
              siteId: input.siteId,
              site: { organizationId: input.organizationId, active: true },
            },
          });
          if (!workOrder) {
            throw new WorkOrderRescheduleError(
              "WORK_ORDER_NOT_FOUND",
              "Work order not found in site scope",
            );
          }
          if (workOrder.status === "COMPLETED" || workOrder.status === "CANCELLED") {
            throw new WorkOrderRescheduleError(
              "WORK_ORDER_NOT_RESCHEDULABLE",
              "Completed or cancelled work orders cannot be rescheduled",
            );
          }

          const dates = calculateRescheduledDates({
            plannedStart: workOrder.plannedStart,
            dueAt: workOrder.dueAt,
            targetDateKey: input.targetDateKey,
            timeZone: input.timeZone,
          });

          const updated = await tx.workOrder.update({
            where: { id: workOrder.id },
            data: dates,
          });
          await tx.auditLog.create({
            data: {
              actorId: input.actorId,
              entityType: "WorkOrder",
              entityId: workOrder.id,
              action: "RESCHEDULED",
              beforeJson: JSON.stringify({
                plannedStart: workOrder.plannedStart,
                dueAt: workOrder.dueAt,
              }),
              afterJson: JSON.stringify({
                plannedStart: updated.plannedStart,
                dueAt: updated.dueAt,
                targetDateKey: input.targetDateKey,
                timeZone: input.timeZone,
              }),
            },
          });
          return updated;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      lastError = error;
      if (error instanceof WorkOrderRescheduleError) throw error;
      if (!retryable(error) || attempt === MAX_TRANSACTION_ATTEMPTS) throw error;
    }
  }
  throw lastError;
}
