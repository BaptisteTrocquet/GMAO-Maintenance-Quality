import { describe, expect, it } from "vitest";
import { advanceCalendarDue, calendarDueSequence } from "@/lib/maintenance/calendar";

describe("preventive maintenance calendar recurrence", () => {
  it("keeps the same local clock time across Europe/Paris DST start", () => {
    const current = new Date("2026-03-28T07:00:00.000Z"); // 08:00 CET
    const next = advanceCalendarDue({
      currentDueAt: current,
      frequencyValue: 1,
      frequencyUnit: "DAY",
      timeZone: "Europe/Paris",
    });

    expect(next.toISOString()).toBe("2026-03-29T06:00:00.000Z"); // 08:00 CEST
  });

  it("keeps the same local clock time across Europe/Paris DST end", () => {
    const current = new Date("2026-10-24T06:00:00.000Z"); // 08:00 CEST
    const next = advanceCalendarDue({
      currentDueAt: current,
      frequencyValue: 1,
      frequencyUnit: "DAY",
      timeZone: "Europe/Paris",
    });

    expect(next.toISOString()).toBe("2026-10-25T07:00:00.000Z"); // 08:00 CET
  });

  it("clamps monthly recurrence to the last valid day of the target month", () => {
    const current = new Date("2027-01-31T07:00:00.000Z"); // 08:00 CET
    const next = advanceCalendarDue({
      currentDueAt: current,
      frequencyValue: 1,
      frequencyUnit: "MONTH",
      timeZone: "Europe/Paris",
    });

    expect(next.toISOString()).toBe("2027-02-28T07:00:00.000Z");
  });

  it("handles leap-day yearly recurrence without overflowing into March", () => {
    const current = new Date("2028-02-29T07:00:00.000Z"); // 08:00 CET
    const next = advanceCalendarDue({
      currentDueAt: current,
      frequencyValue: 1,
      frequencyUnit: "YEAR",
      timeZone: "Europe/Paris",
    });

    expect(next.toISOString()).toBe("2029-02-28T07:00:00.000Z");
  });

  it("generates a deterministic weekly due-date sequence", () => {
    const sequence = calendarDueSequence({
      firstDueAt: new Date("2026-08-03T06:30:00.000Z"), // 08:30 CEST
      frequencyValue: 2,
      frequencyUnit: "WEEK",
      timeZone: "Europe/Paris",
      count: 3,
    });

    expect(sequence.map((date) => date.toISOString())).toEqual([
      "2026-08-03T06:30:00.000Z",
      "2026-08-17T06:30:00.000Z",
      "2026-08-31T06:30:00.000Z",
    ]);
  });
});
