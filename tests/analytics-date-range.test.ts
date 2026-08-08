import { describe, expect, it } from "vitest";
import {
  AnalyticsDateRangeError,
  localCalendarDate,
  localDateStartUtc,
  resolveAnalyticsDateRange,
  shiftCalendarDate,
} from "@/lib/analytics/date-range";

describe("analytics date range helpers", () => {
  it("resolves Paris summer and winter local midnight to the correct UTC instant", () => {
    expect(localDateStartUtc("2026-08-08", "Europe/Paris").toISOString()).toBe(
      "2026-08-07T22:00:00.000Z",
    );
    expect(localDateStartUtc("2026-01-08", "Europe/Paris").toISOString()).toBe(
      "2026-01-07T23:00:00.000Z",
    );
  });

  it("uses an exclusive next-local-day boundary across the DST spring transition", () => {
    const range = resolveAnalyticsDateRange({
      from: "2026-03-29",
      to: "2026-03-29",
      timeZone: "Europe/Paris",
    });

    expect(range.from?.toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(range.toExclusive?.toISOString()).toBe("2026-03-29T22:00:00.000Z");
    expect((range.toExclusive!.getTime() - range.from!.getTime()) / 3_600_000).toBe(23);
  });

  it("uses a 25-hour local day across the DST autumn transition", () => {
    const range = resolveAnalyticsDateRange({
      from: "2026-10-25",
      to: "2026-10-25",
      timeZone: "Europe/Paris",
    });

    expect(range.from?.toISOString()).toBe("2026-10-24T22:00:00.000Z");
    expect(range.toExclusive?.toISOString()).toBe("2026-10-25T23:00:00.000Z");
    expect((range.toExclusive!.getTime() - range.from!.getTime()) / 3_600_000).toBe(25);
  });

  it("keeps date arithmetic calendar-based rather than fixed-duration based", () => {
    expect(shiftCalendarDate("2026-02-28", 1)).toBe("2026-03-01");
    expect(shiftCalendarDate("2028-02-28", 1)).toBe("2028-02-29");
    expect(localCalendarDate(new Date("2026-08-07T22:30:00.000Z"), "Europe/Paris")).toBe(
      "2026-08-08",
    );
  });

  it("rejects invalid dates, reversed ranges and invalid IANA timezones", () => {
    expect(() => shiftCalendarDate("2026-02-31", 1)).toThrow(AnalyticsDateRangeError);
    expect(() =>
      resolveAnalyticsDateRange({ from: "2026-08-09", to: "2026-08-08", timeZone: "UTC" }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_RANGE" }));
    expect(() => localDateStartUtc("2026-08-08", "Not/A_Timezone")).toThrowError(
      expect.objectContaining({ code: "INVALID_TIMEZONE" }),
    );
  });
});
