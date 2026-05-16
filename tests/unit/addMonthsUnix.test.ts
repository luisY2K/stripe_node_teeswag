import { describe, expect, it } from "vitest";
import { addMonthsUnix } from "../../src/lib/addMonthsUnix.js";

function utc(
  year: number,
  monthIndex: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): number {
  return Math.floor(Date.UTC(year, monthIndex, day, hour, minute, second) / 1000);
}

describe("addMonthsUnix", () => {
  it("does not clamp mid-month inputs", () => {
    expect(addMonthsUnix(utc(2025, 2, 15, 12), 1)).toBe(utc(2025, 3, 15, 12));
  });

  it("preserves time-of-day", () => {
    expect(addMonthsUnix(utc(2025, 0, 15, 13, 34, 56), 1)).toBe(
      utc(2025, 1, 15, 13, 34, 56),
    );
  });

  it("returns the same instant when months is zero", () => {
    expect(addMonthsUnix(utc(2025, 0, 31), 0)).toBe(utc(2025, 0, 31));
  });

  it("clamps Mar 31 + 1 month to Apr 30", () => {
    expect(addMonthsUnix(utc(2025, 2, 31), 1)).toBe(utc(2025, 3, 30));
  });

  it("clamps Jan 31 + 1 month to Feb 28 in a non-leap year", () => {
    expect(addMonthsUnix(utc(2025, 0, 31), 1)).toBe(utc(2025, 1, 28));
  });

  it("clamps Jan 31 + 1 month to Feb 29 in a leap year", () => {
    expect(addMonthsUnix(utc(2024, 0, 31), 1)).toBe(utc(2024, 1, 29));
  });

  it("clamps Jan 29 + 1 month to Feb 28 in a non-leap year", () => {
    expect(addMonthsUnix(utc(2025, 0, 29), 1)).toBe(utc(2025, 1, 28));
  });

  it("rolls over the year on Dec 31 + 1 month", () => {
    expect(addMonthsUnix(utc(2024, 11, 31), 1)).toBe(utc(2025, 0, 31));
  });

  it("clamps multi-month spans (Jan 31 + 3 -> Apr 30)", () => {
    expect(addMonthsUnix(utc(2025, 0, 31), 3)).toBe(utc(2025, 3, 30));
  });

  it("clamps multi-year spans that land on non-leap Feb", () => {
    expect(addMonthsUnix(utc(2024, 0, 31), 13)).toBe(utc(2025, 1, 28));
  });
});
