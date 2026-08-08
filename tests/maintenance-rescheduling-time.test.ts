import { describe, expect, it } from "vitest";
import {
  localClockTime,
  ReschedulingTimeError,
  zonedDateTimeToUtc,
} from "@/lib/maintenance/rescheduling";

describe("maintenance rescheduling time conversion", () => {
  it("converts a summer Paris wall clock to UTC", () => {
    expect(zonedDateTimeToUtc("2026-08-08", "09:00", "Europe/Paris").toISOString()).toBe(
      "2026-08-08T07:00:00.000Z",
    );
  });

  it("converts a winter Paris wall clock to UTC", () => {
    expect(zonedDateTimeToUtc("2026-01-08", "09:00", "Europe/Paris").toISOString()).toBe(
      "2026-01-08T08:00:00.000Z",
    );
  });

  it("reads the local clock time in the requested timezone", () => {
    expect(localClockTime(new Date("2026-08-08T12:30:00.000Z"), "Europe/Paris")).toBe("14:30");
  });

  it("rejects invalid calendar dates", () => {
    expect(() => zonedDateTimeToUtc("2026-02-31", "09:00", "Europe/Paris")).toThrow(
      ReschedulingTimeError,
    );
  });

  it("rejects a local wall clock that does not exist during the DST jump", () => {
    expect(() => zonedDateTimeToUtc("2026-03-29", "02:30", "Europe/Paris")).toThrowError(
      expect.objectContaining({ code: "INVALID_LOCAL_TIME" }),
    );
  });
});
