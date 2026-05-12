import { createClockedCustomer } from "../lib/clockedCustomer.js";
import { dashboardSubscriptionUrl } from "../lib/dashboardUrl.js";
import { ensureAwesomeCatalog } from "../lib/ensureAwesomeCatalog.js";
import { getPriceByLookupKey } from "../lib/getPriceByLookupKey.js";
import { parseMonthArg } from "../lib/parseMonthArg.js";
import { LOOKUP_DELIVERY_MONTHLY_EUR } from "../lib/subscriptionCaseCatalog.js";
import { stripe } from "../lib/stripe.js";
import { syncInvoiceCadenceMetadataForSubscription } from "../lib/syncInvoiceCadenceMetadata.js";
import { advanceTestClockByMonths } from "../lib/testClock.js";
import {
  directSubscriptionMetadata,
  lineItemMetadata,
  schedulePhaseMetadataForSubscription,
  subscriptionScheduleObjectMetadata,
} from "../lib/teeswagSubscriptionMetadata.js";

const COUPON_90 = "awesome-90-off-3m";
const COUPON_50 = "awesome-50-off-3m";
const SOURCE = "aligned_delivery_streaming";

async function main(): Promise<void> {
  const runStartedAt = Math.floor(Date.now() / 1000);
  await ensureAwesomeCatalog();

  const argvMonths = parseMonthArg(process.argv.slice(2));
  const monthsElapsed = argvMonths > 0 ? argvMonths : 2;

  const deliveryPrice = await getPriceByLookupKey(LOOKUP_DELIVERY_MONTHLY_EUR);
  const streamingPrice = await getPriceByLookupKey("awesome_monthly_eur");

  // --- Existing delivery customer (monthly, advanced N months) ---
  const { clock, customer, paymentMethodId } = await createClockedCustomer({
    clockNamePrefix: "case1-aligned",
  });

  let deliverySub = await stripe.subscriptions.create({
    customer: customer.id,
    default_payment_method: paymentMethodId,
    collection_method: "charge_automatically",
    metadata: directSubscriptionMetadata({
      source: SOURCE,
      mix: "delivery_only",
      phaseTemplate: "none",
      hasTrial: false,
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

  // --- Streaming schedule (separate subscription, phased discounts) ---
  const schedule = await stripe.subscriptionSchedules.create({
    customer: customer.id,
    start_date: "now",
    end_behavior: "release",
    metadata: subscriptionScheduleObjectMetadata(SOURCE),
    default_settings: {
      collection_method: "charge_automatically",
    },
    phases: [
      {
        items: [{ price: streamingPrice.id, quantity: 1 }],
        duration: { interval: "month", interval_count: 3 },
        discounts: [{ coupon: COUPON_90 }],
        metadata: schedulePhaseMetadataForSubscription({
          source: SOURCE,
          mix: "streaming_only",
          phaseTemplate: "90_50",
          hasTrialThisPhase: false,
          streamCadence: "month",
          couponSnapshot: COUPON_90,
        }),
      },
      {
        items: [{ price: streamingPrice.id, quantity: 1 }],
        duration: { interval: "month", interval_count: 3 },
        discounts: [{ coupon: COUPON_50 }],
        metadata: schedulePhaseMetadataForSubscription({
          source: SOURCE,
          mix: "streaming_only",
          phaseTemplate: "90_50",
          hasTrialThisPhase: false,
          streamCadence: "month",
          couponSnapshot: COUPON_50,
        }),
      },
    ],
    expand: ["subscription"],
  });

  await advanceTestClockByMonths(clock.id, 2);

  const streamSubId =
    typeof schedule.subscription === "string"
      ? schedule.subscription
      : (schedule.subscription?.id ?? "(pending)");

  let streamAnchor = "(pending)";
  if (streamSubId !== "(pending)") {
    const streamSub = await stripe.subscriptions.retrieve(streamSubId);
    streamAnchor = String(streamSub.billing_cycle_anchor);
  }
  const deliveryTagged = await syncInvoiceCadenceMetadataForSubscription({
    subscriptionId: deliverySub.id,
    createdGte: runStartedAt,
  });
  let streamingTagged = 0;
  if (streamSubId !== "(pending)") {
    streamingTagged = await syncInvoiceCadenceMetadataForSubscription({
      subscriptionId: streamSubId,
      createdGte: runStartedAt,
    });
  }

  console.log(
    "Case 1: existing monthly Awesome Delivery, then Awesome Stream schedule starting now (streaming-only sub; delivery anchor unchanged on delivery sub).",
  );
  console.log(
    "Clock advanced +2 month(s) after delivery + streaming subscriptions exist.",
  );
  console.log(`Test clock:        ${clock.id}`);
  console.log(`Customer:          ${customer.id}`);
  console.log(
    `Delivery sub:      ${deliverySub.id} anchor=${deliverySub.billing_cycle_anchor}`,
  );
  console.log(`Streaming schedule:${schedule.id}`);
  console.log(`Streaming sub:     ${streamSubId} anchor=${streamAnchor}`);
  if (streamSubId !== "(pending)") {
    console.log(`Dashboard stream: ${dashboardSubscriptionUrl(streamSubId)}`);
  }
  console.log(`Dashboard delivery:${dashboardSubscriptionUrl(deliverySub.id)}`);
  console.log(
    `Invoices tagged with cadence: delivery=${deliveryTagged}, streaming=${streamingTagged}`,
  );
  console.log(
    "Two subscriptions → two invoice streams; streaming schedule uses start_date now (no past-anchor double bill on first streaming invoice).",
  );
  console.log(
    "Tip: npm run apply:retention -- <streaming_subscription_id> once subscription exists.",
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
