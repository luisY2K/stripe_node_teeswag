import { applyAwesomeRetention } from "../lib/applyRetention.js";

async function main(): Promise<void> {
  const subscriptionId = process.argv[2];
  if (subscriptionId === undefined || subscriptionId.trim() === "") {
    console.error("Usage: npm run apply:retention -- <subscription_id>");
    process.exitCode = 1;
    return;
  }

  const { scheduleId, appliedCouponId } =
    await applyAwesomeRetention(subscriptionId);
  console.log(`Schedule:        ${scheduleId}`);
  console.log(`Applied coupon:  ${appliedCouponId}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
