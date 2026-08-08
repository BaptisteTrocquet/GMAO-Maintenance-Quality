import { describe, expect, it } from "vitest";
import { siteLocalDateTimeToUtc } from "@/lib/maintenance/zoned-date-time";

describe("site-local scheduling conversion", () => {
  it("converts summer and winter Europe/Paris times to the correct UTC instant", () => {
    expect(
      siteLocalDateTimeToUtc({
        localDate: "2026-08-12",
        localTime: "08:00",
        timeZone: "Europe/Paris",
      }).toISOString(),
    ).toBe("2026-08-12T06:00:00.000Z");

    expect(
      siteLocalDateTimeToUtc({
        localDate: "2026-01-12",
        localTime: "08:00",
        timeZone: "Europe/Paris",
      }).toISOString(),
    ).toBe("2026-01-12T07:00:00.000Z");
  });

  it("rejects the nonexistent spring-forward local time", () => {
    expect(() =>
      siteLocalDateTimeToUtc({
        localDate: "2026-03-29",
        localTime: "02:30",
        timeZone: "Europe/Paris",
      }),
    ).toThrowError(expect.objectContaining({ code: "NONEXISTENT_LOCAL_TIME" }));
  });

  it("rejects invalid dates, times and time zones", () => {
    expect(() =>
      siteLocalDateTimeToUtc({
        localDate: "2026-02-31",
        localTime: "08:00",
        timeZone: "Europe/Paris",
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_LOCAL_DATE" }));

    expect(() =>
      siteLocalDateTimeToUtc({
        localDate: "2026-08-12",
        localTime: "25:00",
        timeZone: "Europe/Paris",
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_LOCAL_TIME" }));

    expect(() =>
      siteLocalDateTimeToUtc({
        localDate: "2026-08-12",
        localTime: "08:00",
        timeZone: "Invalid/Zone",
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_TIME_ZONE" }));
  });
});
