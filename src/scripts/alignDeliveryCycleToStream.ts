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

const COUPON_100 = "awesome-100-off-3m";
const COUPON_90 = "awesome-90-off-3m";
const COUPON_50 = "awesome-50-off-3m";

async function main(): Promise<void> {
  await ensureAwesomeCatalog();

  const argvMonths = parseMonthArg(process.argv.slice(2));
  const monthsElapsed = argvMonths > 0 ? argvMonths : 2;
  const freeTrialStreamingMonth =
    process.argv.includes("free-trial") || process.argv.includes("--free-trial");

  const monthlyDelivery = await getPriceByLookupKey(LOOKUP_DELIVERY_MONTHLY_EUR);
  const monthlyStreaming = await getPriceByLookupKey(LOOKUP_STREAMING_BASE_EUR);

  const { clock, customer, deliverySub, paymentMethodId } =
    await createExistingDeliveryCustomer({
      interval: "year",
      monthsElapsed,
      clockNamePrefix: "case7-align-cycle",
      teeswagSource: "align_delivery_cycle_to_stream",
    });

  const deliveryItem = deliverySub.items.data[0];
  if (deliveryItem === undefined) {
    throw new Error("Expected delivery subscription item");
  }

  const phaseTemplate = freeTrialStreamingMonth
    ? "aligned_cycle_trial100_90_50"
    : "aligned_cycle_90_50";

  const subAfter = await stripe.subscriptions.update(deliverySub.id, {
    default_payment_method: paymentMethodId,
    metadata: directSubscriptionMetadata({
      source: "align_delivery_cycle_to_stream",
      mix: "combined",
      phaseTemplate,
      hasTrial: freeTrialStreamingMonth,
      deliveryCadence: "month",
      streamCadence: "month",
      freeTrialStreaming: freeTrialStreamingMonth,
      couponSnapshot: freeTrialStreamingMonth
        ? `${COUPON_100},${COUPON_90},${COUPON_50}`
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

  const streamingItem = subAfter.items.data.find((it) => {
    const pid = typeof it.price === "string" ? it.price : it.price?.id;
    return pid === monthlyStreaming.id;
  });
  if (streamingItem?.current_period_end === undefined) {
    throw new Error(
      "Expected streaming item current_period_end after cycle alignment update",
    );
  }

  const promoPhases = freeTrialStreamingMonth
    ? [
        { kind: "discount" as const, couponId: COUPON_100, durationMonths: 1 },
        { kind: "discount" as const, couponId: COUPON_90, durationMonths: 2 },
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
    teeswagSource: "align_delivery_cycle_to_stream",
    phaseTemplate,
    deliveryCadence: "month",
    streamCadence: "month",
    promoStartAt: streamingItem.current_period_end,
    testClockId: clock.id,
  });

  const invoices = await stripe.invoices.list({
    customer: customer.id,
    limit: 15,
  });

  console.log(
    "Case 7: yearly delivery converted to monthly at add-stream time (create_prorations), then anchor-aligned phased discounts on streaming.",
  );
  console.log(`Test clock:     ${clock.id}`);
  console.log(`Customer:       ${customer.id}`);
  console.log(`Subscription:   ${subAfter.id}`);
  console.log(`Schedule:       ${schedule.id}`);
  console.log(`Dashboard:      ${dashboardSubscriptionUrl(subAfter.id)}`);
  console.log(
    `Delivery age:   ${monthsElapsed} month(s) (override with: npm run ... -- m N)`,
  );
  console.log(
    freeTrialStreamingMonth
      ? "Expected ladder: 100%×1 -> 90%×2 -> 50%×3 (delivery+stream aligned monthly)."
      : "Expected ladder: 90%×3 -> 50%×3 (delivery+stream aligned monthly).",
  );
  console.log("Recent invoices (look for yearly->monthly proration credit):");
  for (const inv of invoices.data) {
    const cents = inv.amount_due ?? inv.total ?? 0;
    console.log(
      `  ${inv.id}  ${inv.status}  ${cents / 100} ${inv.currency?.toUpperCase() ?? ""}`,
    );
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
