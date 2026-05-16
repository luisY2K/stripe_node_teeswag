/** Returns a Unix timestamp (seconds) that is `months` calendar months after `baseUnixSec` (UTC). */
export function addMonthsUnix(baseUnixSec: number, months: number): number {
  const date = new Date(baseUnixSec * 1000);
  date.setUTCMonth(date.getUTCMonth() + months);
  return Math.floor(date.getTime() / 1000);
}
