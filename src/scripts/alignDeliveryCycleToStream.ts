import type Stripe from "stripe";
import { createClockedCustomer } from "../lib/clockedCustomer.js";
import { dashboardSubscriptionUrl } from "../lib/dashboardUrl.js";
import { ensureAwesomeCatalog } from "../lib/ensureAwesomeCatalog.js";
import { getPriceByLookupKey } from "../lib/getPriceByLookupKey.js";
import { parseMonthArg } from "../lib/parseMonthArg.js";
import {
  LOOKUP_DELIVERY_MONTHLY_EUR,
  LOOKUP_DELIVERY_YEARLY_EUR,
  LOOKUP_STREAMING_BASE_EUR,
} from "../lib/subscriptionCaseCatalog.js";
import { stripe } from "../lib/stripe.js";
import { syncInvoiceCadenceMetadataForSubscription } from "../lib/syncInvoiceCadenceMetadata.js";
import { advanceTestClockByMonths } from "../lib/testClock.js";
import {
  directSubscriptionMetadata,
  lineItemMetadata,
  schedulePhaseMetadataForSubscription,
  subscriptionScheduleObjectMetadata,
} from "../lib/teeswagSubscriptionMetadata.js";

const COUPON_100 = "awesome-100-off-3m";
const COUPON_90 = "awesome-90-off-3m";
const COUPON_50 = "awesome-50-off-6m";
const MONTH_SEC = 30 * 86_400;
const PHASE_MERGE_EPS_SEC = 120;
const PHASE_END_SLACK_SEC = 120;
const SOURCE = "align_delivery_cycle_to_stream";

async function main(): Promise<void> {
  const runStartedAt = Math.floor(Date.now() / 1000);
  await ensureAwesomeCatalog();

  const argvMonths = parseMonthArg(process.argv.slice(2));
  const monthsElapsed = argvMonths > 0 ? argvMonths : 2;
  const freeTrialStreamingMonth =
    process.argv.includes("free-trial") || process.argv.includes("--free-trial");

  const monthlyDelivery = await getPriceByLookupKey(LOOKUP_DELIVERY_MONTHLY_EUR);
  const yearlyDelivery = await getPriceByLookupKey(LOOKUP_DELIVERY_YEARLY_EUR);
  const monthlyStreaming = await getPriceByLookupKey(LOOKUP_STREAMING_BASE_EUR);

  // --- Existing delivery customer (yearly interval, advanced N months) ---
  const { clock, customer, paymentMethodId } = await createClockedCustomer({
    clockNamePrefix: "case7-align-cycle",
  });

  let deliverySub = await stripe.subscriptions.create({
    customer: customer.id,
    default_payment_method: paymentMethodId,
    collection_method: "charge_automatically",
    billing_mode: { type: "flexible" },
    metadata: directSubscriptionMetadata({
      source: SOURCE,
      mix: "delivery_only",
      phaseTemplate: "none",
      hasTrial: false,
      deliveryCadence: "year",
    }),
    items: [
      {
        price: yearlyDelivery.id,
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

  // --- Add streaming to the delivery subscription ---
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
      source: SOURCE,
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
  const promoStart = streamingItem.current_period_end;

  // --- Migrate to phased discount schedule (from_subscription → update phases) ---
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

  const createdSchedule = await stripe.subscriptionSchedules.create({
    from_subscription: subAfter.id,
  });
  const retrieved = await stripe.subscriptionSchedules.retrieve(createdSchedule.id);
  const phaseStart = retrieved.phases[0]?.start_date;
  if (phaseStart === undefined) {
    throw new Error("Schedule missing phases[0].start_date after from_subscription");
  }

  const tc = await stripe.testHelpers.testClocks.retrieve(clock.id);
  const billingNow = tc.frozen_time + PHASE_END_SLACK_SEC;

  function itemsWithCoupon(
    couponId?: string,
  ): Stripe.SubscriptionScheduleUpdateParams.Phase.Item[] {
    const streamItem: Stripe.SubscriptionScheduleUpdateParams.Phase.Item = {
      price: monthlyStreaming.id,
      quantity: 1,
      metadata: lineItemMetadata("streaming"),
    };
    if (couponId !== undefined) {
      streamItem.discounts = [{ coupon: couponId }];
    }
    return [
      {
        price: monthlyDelivery.id,
        quantity: 1,
        metadata: lineItemMetadata("delivery"),
      },
      streamItem,
    ];
  }

  const phases: Stripe.SubscriptionScheduleUpdateParams.Phase[] = [];

  const stubStart = Math.max(
    streamingItem.current_period_start ?? billingNow,
    billingNow,
  );

  if (phaseStart < stubStart - PHASE_MERGE_EPS_SEC) {
    phases.push({
      start_date: phaseStart,
      end_date: stubStart,
      metadata: schedulePhaseMetadataForSubscription({
        source: SOURCE,
        mix: "combined",
        phaseTemplate,
        hasTrialThisPhase: false,
        deliveryCadence: "month",
        streamCadence: "month",
        freeTrialStreaming: freeTrialStreamingMonth,
      }),
      items: itemsWithCoupon(),
    });
  }

  if (stubStart < promoStart - PHASE_MERGE_EPS_SEC) {
    phases.push({
      start_date: stubStart,
      end_date: promoStart,
      metadata: schedulePhaseMetadataForSubscription({
        source: SOURCE,
        mix: "combined",
        phaseTemplate,
        hasTrialThisPhase: false,
        deliveryCadence: "month",
        streamCadence: "month",
        freeTrialStreaming: freeTrialStreamingMonth,
      }),
      items: itemsWithCoupon(),
    });
  }

  let cursor = promoStart;
  for (const phase of promoPhases) {
    const segEnd = cursor + phase.durationMonths * MONTH_SEC;
    phases.push({
      start_date: cursor,
      end_date: segEnd,
      metadata: schedulePhaseMetadataForSubscription({
        source: SOURCE,
        mix: "combined",
        phaseTemplate,
        hasTrialThisPhase: phase.couponId === COUPON_100,
        deliveryCadence: "month",
        streamCadence: "month",
        freeTrialStreaming: freeTrialStreamingMonth,
        couponSnapshot: phase.couponId,
      }),
      items: itemsWithCoupon(phase.couponId),
    });
    cursor = segEnd;
  }

  phases.push({
    start_date: cursor,
    end_date: cursor + MONTH_SEC,
    metadata: schedulePhaseMetadataForSubscription({
      source: SOURCE,
      mix: "combined",
      phaseTemplate,
      hasTrialThisPhase: false,
      deliveryCadence: "month",
      streamCadence: "month",
      freeTrialStreaming: freeTrialStreamingMonth,
    }),
    items: itemsWithCoupon(),
  });

  const schedule = await stripe.subscriptionSchedules.update(createdSchedule.id, {
    phases,
    end_behavior: "release",
    metadata: subscriptionScheduleObjectMetadata(SOURCE, {
      freeTrialStreaming: freeTrialStreamingMonth,
    }),
    default_settings: {
      collection_method: "charge_automatically",
    },
    expand: ["subscription"],
  });

  const cadenceInvoicesUpdated = await syncInvoiceCadenceMetadataForSubscription({
    subscriptionId: subAfter.id,
    createdGte: runStartedAt,
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
  console.log(`Invoices tagged with cadence: ${cadenceInvoicesUpdated}`);
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
