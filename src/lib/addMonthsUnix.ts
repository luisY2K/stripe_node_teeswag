/**
 * Returns a Unix timestamp (seconds) that is `months` calendar months after
 * `baseUnixSec` (UTC), with end-of-month clamping. Time-of-day is preserved.
 *
 * Examples:
 *   - Jan 31, 2025 + 1 month  -> Feb 28, 2025 (non-leap year clamp)
 *   - Jan 31, 2024 + 1 month  -> Feb 29, 2024 (leap year clamp)
 *   - Mar 31, 2025 + 1 month  -> Apr 30, 2025 (31 -> 30 clamp)
 *   - Mar 15, 2025 + 1 month  -> Apr 15, 2025 (no clamp needed)
 */
export function addMonthsUnix(baseUnixSec: number, months: number): number {
  const d = new Date(baseUnixSec * 1000);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDayOfTargetMonth = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();
  d.setUTCDate(Math.min(day, lastDayOfTargetMonth));
  return Math.floor(d.getTime() / 1000);
}
