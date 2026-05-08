import { dashboardSubscriptionUrl } from "../lib/dashboardUrl.js";
import { createCombinedDeliveryStreamingSchedule } from "../lib/createCombinedDeliveryStreamingSchedule.js";
import { createExistingDeliveryCustomer } from "../lib/createExistingDeliveryCustomer.js";
import { ensureAwesomeCatalog } from "../lib/ensureAwesomeCatalog.js";
import { parseMonthArg } from "../lib/parseMonthArg.js";
import { stripe } from "../lib/stripe.js";

const COUPON_90 = "awesome-90-off-3m";
const COUPON_50 = "awesome-50-off-3m";

async function main(): Promise<void> {
  await ensureAwesomeCatalog();

  const argvMonths = parseMonthArg(process.argv.slice(2));
  const monthsElapsed = argvMonths > 0 ? argvMonths : 2;

  const { clock, customer, deliverySub } = await createExistingDeliveryCustomer({
    interval: "month",
    monthsElapsed,
    clockNamePrefix: "case4-combined",
    teeswagSource: "bundle_two_lines",
  });

  const freeTrialStreamingMonth =
    process.argv.includes("free-trial") || process.argv.includes("--free-trial");

  await stripe.subscriptions.cancel(deliverySub.id, {
    prorate: true,
    invoice_now: true,
  });

  const promoPhases = freeTrialStreamingMonth
    ? [
        {
          kind: "discount" as const,
          couponId: "awesome-100-off-3m",
          durationMonths: 1,
        },
        { kind: "discount" as const, couponId: COUPON_90, durationMonths: 3 },
        { kind: "discount" as const, couponId: COUPON_50, durationMonths: 3 },
      ]
    : [
        { kind: "discount" as const, couponId: COUPON_90, durationMonths: 3 },
        { kind: "discount" as const, couponId: COUPON_50, durationMonths: 3 },
      ];

  const schedule = await createCombinedDeliveryStreamingSchedule(
    customer.id,
    promoPhases,
    { teeswagSource: "bundle_two_lines" },
  );

  const subId =
    typeof schedule.subscription === "string"
      ? schedule.subscription
      : (schedule.subscription?.id ?? "(pending)");

  const invoices = await stripe.invoices.list({
    customer: customer.id,
    limit: 15,
  });

  console.log(
    freeTrialStreamingMonth
      ? "Case 4: bundle with optional first month 100% off streaming (→ €10), then 90%→50% phases; schedule starts now (no past billing_cycle_anchor)."
      : "Case 4: migrate from delivery-only to one subscription (delivery + Awesome Stream) with 90%→50% streaming coupons; schedule starts now (no past anchor — avoids €24 double-charge first invoice).",
  );
  console.log(`Test clock:     ${clock.id}`);
  console.log(`Customer:       ${customer.id}`);
  console.log(`Canceled sub:   ${deliverySub.id} (credit proration)`);
  console.log(`Schedule:       ${schedule.id}`);
  console.log(`Subscription:   ${subId}`);
  if (subId !== "(pending)") {
    console.log(`Dashboard:      ${dashboardSubscriptionUrl(subId)}`);
  }
  console.log("Recent invoices (cancel credit + new sub first invoice):");
  for (const inv of invoices.data) {
    const cents = inv.amount_due ?? inv.total ?? 0;
    console.log(
      `  ${inv.id}  ${inv.status}  ${cents / 100} ${inv.currency?.toUpperCase() ?? ""}`,
    );
  }
  console.log(
    "Coupons apply only to Awesome Stream (prod_awesome): applies_to.products + item-level discounts on streaming.",
  );
  console.log(
    "Optional: npm run … -- free-trial for cadence €10 (100% off stream), €12×3, €20×3, €30…",
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
