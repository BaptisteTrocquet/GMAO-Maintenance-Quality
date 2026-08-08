import { describe, expect, it } from "vitest";
import {
  AnalyticsDateRangeError,
  localCalendarDate,
  localDateStartUtc,
  resolveAnalyticsDateRange,
  shiftCalendarDate,
} from "@/lib/analytics/date-range";

describe("analytics date ranges", () => {
  it("resolves the local calendar date independently from the server timezone", () => {
    expect(
      localCalendarDate(new Date("2026-08-08T22:30:00.000Z"), "Europe/Paris"),
    ).toBe("2026-08-09");
  });

  it("resolves local midnight with the correct summer and winter offsets", () => {
    expect(localDateStartUtc("2026-01-15", "Europe/Paris").toISOString()).toBe(
      "2026-01-14T23:00:00.000Z",
    );
    expect(localDateStartUtc("2026-07-15", "Europe/Paris").toISOString()).toBe(
      "2026-07-14T22:00:00.000Z",
    );
  });

  it("keeps an inclusive local-day range correct across the spring DST transition", () => {
    const range = resolveAnalyticsDateRange({
      from: "2026-03-29",
      to: "2026-03-29",
      timeZone: "Europe/Paris",
    });

    expect(range.from?.toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(range.toExclusive?.toISOString()).toBe("2026-03-29T22:00:00.000Z");
    expect((range.toExclusive!.getTime() - range.from!.getTime()) / 3_600_000).toBe(23);
  });

  it("keeps an inclusive local-day range correct across the autumn DST transition", () => {
    const range = resolveAnalyticsDateRange({
      from: "2026-10-25",
      to: "2026-10-25",
      timeZone: "Europe/Paris",
    });

    expect(range.from?.toISOString()).toBe("2026-10-24T22:00:00.000Z");
    expect(range.toExclusive?.toISOString()).toBe("2026-10-25T23:00:00.000Z");
    expect((range.toExclusive!.getTime() - range.from!.getTime()) / 3_600_000).toBe(25);
  });

  it("shifts calendar dates without relying on elapsed 24-hour durations", () => {
    expect(shiftCalendarDate("2026-03-29", -1)).toBe("2026-03-28");
    expect(shiftCalendarDate("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("rejects invalid calendar dates, ranges and timezones explicitly", () => {
    expect(() =>
      resolveAnalyticsDateRange({ from: "2026-08-10", to: "2026-08-09", timeZone: "UTC" }),
    ).toThrowError(AnalyticsDateRangeError);
    expect(() => localDateStartUtc("2026-02-30", "UTC")).toThrowError(AnalyticsDateRangeError);
    expect(() => localDateStartUtc("2026-08-08", "Invalid/Timezone")).toThrowError(
      AnalyticsDateRangeError,
    );
  });
});
