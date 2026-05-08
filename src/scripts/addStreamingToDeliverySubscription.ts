import { dashboardSubscriptionUrl } from "../lib/dashboardUrl.js";
import { createExistingDeliveryCustomer } from "../lib/createExistingDeliveryCustomer.js";
import { ensureAwesomeCatalog } from "../lib/ensureAwesomeCatalog.js";
import { getPriceByLookupKey } from "../lib/getPriceByLookupKey.js";
import { migrateCombinedSubscriptionToPhasedDiscountSchedule } from "../lib/migrateCombinedSubscriptionToPhasedDiscountSchedule.js";
import { parseMonthArg } from "../lib/parseMonthArg.js";
import {
  LOOKUP_DELIVERY_MONTHLY_EUR,
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

  const monthlyDelivery = await getPriceByLookupKey(LOOKUP_DELIVERY_MONTHLY_EUR);
  const monthlyStreaming = await getPriceByLookupKey(LOOKUP_STREAMING_BASE_EUR);

  const freeTrialStreamingMonth =
    process.argv.includes("free-trial") || process.argv.includes("--free-trial");

  const { clock, customer, deliverySub, paymentMethodId } =
    await createExistingDeliveryCustomer({
      interval: "month",
      monthsElapsed,
      clockNamePrefix: "case6-add-stream",
      teeswagSource: "add_streaming_to_delivery",
    });

  const deliveryItem = deliverySub.items.data[0];
  if (deliveryItem === undefined) {
    throw new Error("Expected delivery subscription item");
  }

  const subAfter = await stripe.subscriptions.update(deliverySub.id, {
    default_payment_method: paymentMethodId,
    metadata: directSubscriptionMetadata({
      source: "add_streaming_to_delivery",
      mix: "combined",
      phaseTemplate: freeTrialStreamingMonth
        ? "combined_trial100_90_50"
        : "flex_combined_90_50",
      hasTrial: false,
      couponSnapshot: freeTrialStreamingMonth
        ? `awesome-100-off-3m,${COUPON_90},${COUPON_50}`
        : `${COUPON_90},${COUPON_50}`,
    }),
    items: [
      {
        id: deliveryItem.id,
        price: monthlyDelivery.id,
        quantity: 1,
        metadata: lineItemMetadata("delivery"),
      },
      {
        price: monthlyStreaming.id,
        quantity: 1,
        metadata: lineItemMetadata("streaming"),
      },
    ],
    proration_behavior: "create_prorations",
    expand: ["items"],
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
    subscriptionId: subAfter.id,
    deliveryPriceId: monthlyDelivery.id,
    streamingPriceId: monthlyStreaming.id,
    phases: promoPhases,
    teeswagSource: "add_streaming_to_delivery",
    phaseTemplate: freeTrialStreamingMonth
      ? "combined_trial100_90_50"
      : "flex_combined_90_50",
    testClockId: clock.id,
  });

  console.log(
    "Case 6: monthly Awesome Delivery; add streaming then phased schedule (90%→50% on streaming by default). Monthly delivery gives enough phase runway for six promo months before renewal.",
  );
  console.log(`Test clock:     ${clock.id}`);
  console.log(`Customer:       ${customer.id}`);
  console.log(`Subscription:   ${subAfter.id}`);
  console.log(`Schedule:       ${schedule.id}`);
  console.log(`Items before:   1 (delivery monthly)`);
  console.log(`Items after:    ${subAfter.items.data.length}`);
  console.log(`Dashboard:      ${dashboardSubscriptionUrl(subAfter.id)}`);
  console.log(
    `Delivery age:   ${monthsElapsed} month(s) (override with: npm run ... -- m N)`,
  );
  console.log("");
  console.log(
    "Expected cadence: €12 × 3, €20 × 3, €30 … (optional: npm run … -- free-trial → €10, €12×3, €20×3, €30…).",
  );
  console.log("");
  console.log(
    "Cancel streaming only: subscriptionItems.delete on the streaming item; do not cancel the whole subscription.",
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
