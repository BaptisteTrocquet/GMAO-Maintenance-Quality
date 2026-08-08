import { describe, expect, it } from "vitest";
import {
  localDateStartUtc,
  resolveAnalyticsDateRange,
} from "@/lib/analytics/date-range";

describe("analytics date ranges", () => {
  it("resolves local midnights across the Europe/Paris DST transition", () => {
    expect(localDateStartUtc("2026-03-29", "Europe/Paris").toISOString()).toBe(
      "2026-03-28T23:00:00.000Z",
    );
    expect(localDateStartUtc("2026-03-30", "Europe/Paris").toISOString()).toBe(
      "2026-03-29T22:00:00.000Z",
    );
  });

  it("treats the selected to date as inclusive using the next local midnight", () => {
    const range = resolveAnalyticsDateRange({
      from: "2026-03-29",
      to: "2026-03-30",
      timeZone: "Europe/Paris",
    });

    expect(range.from?.toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(range.toExclusive?.toISOString()).toBe("2026-03-30T22:00:00.000Z");
    expect(range.input).toEqual({ from: "2026-03-29", to: "2026-03-30" });
  });

  it("rejects malformed, impossible and reversed date ranges", () => {
    expect(() =>
      resolveAnalyticsDateRange({ from: "29/03/2026", timeZone: "Europe/Paris" }),
    ).toThrow("YYYY-MM-DD");
    expect(() =>
      resolveAnalyticsDateRange({ from: "2026-02-30", timeZone: "Europe/Paris" }),
    ).toThrow("Invalid calendar date");
    expect(() =>
      resolveAnalyticsDateRange({
        from: "2026-04-02",
        to: "2026-04-01",
        timeZone: "Europe/Paris",
      }),
    ).toThrow("from must be on or before to");
  });

  it("fails explicitly for an invalid IANA timezone", () => {
    expect(() => localDateStartUtc("2026-08-08", "Not/A_Timezone")).toThrow(
      "Invalid IANA timezone",
    );
  });
});
