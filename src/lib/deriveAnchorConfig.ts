/**
 * Maps a Unix timestamp (UTC) to Stripe `billing_cycle_anchor_config` fields.
 */
export function deriveAnchorConfig(unixSeconds: number): {
  day_of_month: number;
  hour: number;
  minute: number;
  second: number;
} {
  const d = new Date(unixSeconds * 1000);
  return {
    day_of_month: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  };
}
