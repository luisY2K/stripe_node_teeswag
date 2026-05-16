import type Stripe from "stripe";
import { createClockedCustomer } from "../../lib/clockedCustomer.js";
import { dashboardSubscriptionUrl } from "../../lib/dashboardUrl.js";
import { ensureAwesomeCatalog } from "../../lib/ensureAwesomeCatalog.js";
import { getPriceByLookupKey } from "../../lib/getPriceByLookupKey.js";
import { parseMonthArg } from "../../lib/parseMonthArg.js";
import {
  LOOKUP_DELIVERY_MONTHLY_EUR,
  LOOKUP_STREAMING_BASE_EUR,
} from "../../lib/subscriptionCaseCatalog.js";
import { syncInvoiceCadenceMetadataForSubscription } from "../../lib/syncInvoiceCadenceMetadata.js";
import { stripe } from "../../lib/stripe.js";
import { advanceTestClockByMonths } from "../../lib/testClock.js";
import {
  directSubscriptionMetadata,
  lineItemMetadata,
  schedulePhaseMetadataForSubscription,
  subscriptionScheduleObjectMetadata,
} from "../../lib/teeswagSubscriptionMetadata.js";

const COUPON_100 = "awesome-100-off-3m";
const COUPON_90 = "awesome-90-off-3m";
const COUPON_50 = "awesome-50-off-6m";
const SOURCE = "bundle_two_lines";

async function main(): Promise<void> {
  const runStartedAt = Math.floor(Date.now() / 1000);
  await ensureAwesomeCatalog();

  const argvMonths = parseMonthArg(process.argv.slice(2));
  const monthsElapsed = argvMonths > 0 ? argvMonths : 2;
  const freeTrialStreamingMonth =
    process.argv.includes("free-trial") || process.argv.includes("--free-trial");

  const deliveryPrice = await getPriceByLookupKey(LOOKUP_DELIVERY_MONTHLY_EUR);
  const streamingPrice = await getPriceByLookupKey(LOOKUP_STREAMING_BASE_EUR);

  // --- Existing delivery customer (monthly, advanced N months) ---
  const { clock, customer, paymentMethodId } = await createClockedCustomer({
    clockNamePrefix: "case4-combined",
  });

  let deliverySub = await stripe.subscriptions.create({
    customer: customer.id,
    default_payment_method: paymentMethodId,
    collection_method: "charge_automatically",
    metadata: directSubscriptionMetadata({
      source: SOURCE,
      mix: "delivery_only",
      phaseTemplate: "none",
      deliveryCadence: "month",
    }),
    items: [
      {
        price: deliveryPrice.id,
        quantity: 1,
        metadata: lineItemMetadata("delivery"),
      },
    ],
    expand: ["items"],
  });

  if (monthsElapsed > 0) {
    await advanceTestClockByMonths(clock.id, monthsElapsed);
  }

  deliverySub = await stripe.subscriptions.retrieve(deliverySub.id, {
    expand: ["items"],
  });

  // --- Cancel old delivery sub with credit ---
  await stripe.subscriptions.cancel(deliverySub.id, {
    prorate: true,
    invoice_now: true,
  });

  // --- Create combined schedule (delivery + streaming, phased discounts on streaming) ---
  const promoPhases: { couponId: string; durationMonths: number }[] =
    freeTrialStreamingMonth
      ?         [
          { couponId: COUPON_100, durationMonths: 1 },
          { couponId: COUPON_90, durationMonths: 2 },
          { couponId: COUPON_50, durationMonths: 6 },
        ]
      : [
          { couponId: COUPON_90, durationMonths: 3 },
          { couponId: COUPON_50, durationMonths: 6 },
        ];

  const freeTrialStreaming = promoPhases.some((p) => p.couponId === COUPON_100);

  const stripePhases: Stripe.SubscriptionScheduleCreateParams.Phase[] = promoPhases.map(
    (p) => ({
      metadata: schedulePhaseMetadataForSubscription({
        source: SOURCE,
        mix: "combined",
        phaseTemplate: "combined_90_50",
        deliveryCadence: "month",
        streamCadence: "month",
        freeTrialStreaming,
        couponSnapshot: p.couponId,
      }),
      items: [
        {
          price: deliveryPrice.id,
          quantity: 1,
          metadata: lineItemMetadata("delivery"),
        },
        {
          price: streamingPrice.id,
          quantity: 1,
          discounts: [{ coupon: p.couponId }],
          metadata: lineItemMetadata("streaming"),
        },
      ],
      duration: { interval: "month" as const, interval_count: p.durationMonths },
    }),
  );

  const schedule = await stripe.subscriptionSchedules.create({
    customer: customer.id,
    start_date: "now",
    end_behavior: "release",
    metadata: subscriptionScheduleObjectMetadata(SOURCE, { freeTrialStreaming }),
    default_settings: {
      collection_method: "charge_automatically",
    },
    phases: stripePhases,
    expand: ["subscription"],
  });

  const subId =
    typeof schedule.subscription === "string"
      ? schedule.subscription
      : (schedule.subscription?.id ?? "(pending)");
  const deliveryTagged = await syncInvoiceCadenceMetadataForSubscription({
    subscriptionId: deliverySub.id,
    createdGte: runStartedAt,
  });
  let combinedTagged = 0;
  if (subId !== "(pending)") {
    combinedTagged = await syncInvoiceCadenceMetadataForSubscription({
      subscriptionId: subId,
      createdGte: runStartedAt,
    });
  }

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
    `Invoices tagged with cadence: delivery=${deliveryTagged}, combined=${combinedTagged}`,
  );
  console.log(
    "Coupons apply only to Awesome Stream (prod_awesome): applies_to.products + item-level discounts on streaming.",
  );
  console.log(
    "Optional: npm run … -- free-trial for cadence €10 (100% off stream), €12×2, €20×3, €30…",
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
