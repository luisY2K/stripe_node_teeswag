import { dashboardSubscriptionUrl } from "../lib/dashboardUrl.js";
import { createExistingDeliveryCustomer } from "../lib/createExistingDeliveryCustomer.js";
import { ensureAwesomeCatalog } from "../lib/ensureAwesomeCatalog.js";
import { getPriceByLookupKey } from "../lib/getPriceByLookupKey.js";
import { migrateCombinedSubscriptionToPhasedDiscountSchedule } from "../lib/migrateCombinedSubscriptionToPhasedDiscountSchedule.js";
import { parseMonthArg } from "../lib/parseMonthArg.js";
import {
  LOOKUP_DELIVERY_YEARLY_EUR,
  LOOKUP_STREAMING_BASE_EUR,
} from "../lib/subscriptionCaseCatalog.js";
import { stripe } from "../lib/stripe.js";
import {
  directSubscriptionMetadata,
  lineItemMetadata,
} from "../lib/teeswagSubscriptionMetadata.js";

const COUPON_90 = "awesome-90-off-3m";
const COUPON_50 = "awesome-50-off-3m";

async function main(): Promise<void> {
  await ensureAwesomeCatalog();

  const argvMonths = parseMonthArg(process.argv.slice(2));
  const monthsElapsed = argvMonths > 0 ? argvMonths : 5;

  const yearlyDelivery = await getPriceByLookupKey(LOOKUP_DELIVERY_YEARLY_EUR);
  const monthlyStreaming = await getPriceByLookupKey(LOOKUP_STREAMING_BASE_EUR);

  const { clock, customer, deliverySub, paymentMethodId } =
    await createExistingDeliveryCustomer({
      interval: "year",
      monthsElapsed,
      clockNamePrefix: "case5-flex",
      teeswagSource: "flexible_mixed_interval",
    });

  await stripe.subscriptions.cancel(deliverySub.id, {
    prorate: true,
    invoice_now: true,
  });

  const freeTrialStreamingMonth =
    process.argv.includes("free-trial") || process.argv.includes("--free-trial");

  const subscription = await stripe.subscriptions.create({
    customer: customer.id,
    default_payment_method: paymentMethodId,
    collection_method: "charge_automatically",
    billing_mode: { type: "flexible" },
    metadata: directSubscriptionMetadata({
      source: "flexible_mixed_interval",
      mix: "combined",
      phaseTemplate: freeTrialStreamingMonth
        ? "flex_combined_trial100_90_50"
        : "flex_combined_90_50",
      hasTrial: false,
      couponSnapshot: freeTrialStreamingMonth
        ? `awesome-100-off-3m,${COUPON_90},${COUPON_50}`
        : `${COUPON_90},${COUPON_50}`,
    }),
    items: [
      {
        price: yearlyDelivery.id,
        quantity: 1,
        metadata: lineItemMetadata("delivery"),
      },
      {
        price: monthlyStreaming.id,
        quantity: 1,
        metadata: lineItemMetadata("streaming"),
      },
    ],
    expand: ["items.data.price"],
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

  const schedule = await migrateCombinedSubscriptionToPhasedDiscountSchedule({
    subscriptionId: subscription.id,
    deliveryPriceId: yearlyDelivery.id,
    streamingPriceId: monthlyStreaming.id,
    phases: promoPhases,
    teeswagSource: "flexible_mixed_interval",
    phaseTemplate: freeTrialStreamingMonth
      ? "flex_combined_trial100_90_50"
      : "flex_combined_90_50",
    testClockId: clock.id,
  });

  const invoices = await stripe.invoices.list({
    customer: customer.id,
    limit: 15,
  });

  console.log(
    "Case 5: yearly flexible delivery-only → cancel with credit → new flexible sub (yearly delivery + monthly stream). Anchor is **now** (no past anchor double-charge). Phased 90%→50% on streaming via subscription_schedule migration.",
  );
  console.log(`Test clock:     ${clock.id}`);
  console.log(`Customer:       ${customer.id}`);
  console.log(`Canceled sub:   ${deliverySub.id}`);
  console.log(`New sub:        ${subscription.id}`);
  console.log(`Schedule:       ${schedule.id}`);
  console.log(`Dashboard:      ${dashboardSubscriptionUrl(subscription.id)}`);

  for (const it of subscription.items.data) {
    const price =
      typeof it.price === "string" ? it.price : (it.price?.lookup_key ?? it.price?.id);
    console.log(
      `Item ${it.id}: period ${it.current_period_start} → ${it.current_period_end} price=${price}`,
    );
  }

  console.log("Recent invoices:");
  for (const inv of invoices.data) {
    const cents = inv.amount_due ?? inv.total ?? 0;
    console.log(
      `  ${inv.id}  ${inv.status}  ${cents / 100} ${inv.currency?.toUpperCase() ?? ""}`,
    );
  }
  console.log(
    "Expected cadence (no trial flag): €12 × 3 (90%), €20 × 3 (50%), €30 … — first invoice single period (anchor now).",
  );
  console.log("Optional: npm run … -- free-trial → €10, then €12×3, €20×3, €30…");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
