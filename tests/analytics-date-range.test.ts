import { describe, expect, it } from "vitest";
import {
  AnalyticsDateRangeError,
  localCalendarDate,
  localDateStartUtc,
  resolveAnalyticsDateRange,
  shiftCalendarDate,
} from "@/lib/analytics/date-range";

describe("analytics date ranges", () => {
  it("resolves calendar dates in the configured IANA timezone", () => {
    expect(localCalendarDate(new Date("2026-08-08T22:30:00.000Z"), "Europe/Paris")).toBe(
      "2026-08-09",
    );
    expect(localDateStartUtc("2026-08-09", "Europe/Paris").toISOString()).toBe(
      "2026-08-08T22:00:00.000Z",
    );
  });

  it("uses an exclusive next-local-midnight boundary across DST", () => {
    const range = resolveAnalyticsDateRange({
      from: "2026-03-29",
      to: "2026-03-29",
      timeZone: "Europe/Paris",
    });

    expect(range.from?.toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(range.toExclusive?.toISOString()).toBe("2026-03-29T22:00:00.000Z");
    expect(range.toExclusive!.getTime() - range.from!.getTime()).toBe(23 * 60 * 60 * 1000);
  });

  it("shifts calendar days without depending on runtime timezone", () => {
    expect(shiftCalendarDate("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftCalendarDate("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("rejects invalid calendar inputs, ranges and timezones", () => {
    expect(() => resolveAnalyticsDateRange({ from: "2026-02-30", timeZone: "UTC" })).toThrow(
      AnalyticsDateRangeError,
    );
    expect(() =>
      resolveAnalyticsDateRange({ from: "2026-08-09", to: "2026-08-08", timeZone: "UTC" }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_RANGE" }));
    expect(() => localDateStartUtc("2026-08-08", "Not/A_Timezone")).toThrowError(
      expect.objectContaining({ code: "INVALID_TIMEZONE" }),
    );
  });
});
