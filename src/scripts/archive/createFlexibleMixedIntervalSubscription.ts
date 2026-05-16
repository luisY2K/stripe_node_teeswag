import type Stripe from "stripe";
import { createClockedCustomer } from "../../lib/clockedCustomer.js";
import { dashboardSubscriptionUrl } from "../../lib/dashboardUrl.js";
import { ensureAwesomeCatalog } from "../../lib/ensureAwesomeCatalog.js";
import { getPriceByLookupKey } from "../../lib/getPriceByLookupKey.js";
import { parseMonthArg } from "../../lib/parseMonthArg.js";
import {
  LOOKUP_DELIVERY_YEARLY_EUR,
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
const MONTH_SEC = 30 * 86_400;
const PHASE_MERGE_EPS_SEC = 120;
const PHASE_END_SLACK_SEC = 120;
const SOURCE = "flexible_mixed_interval";

async function main(): Promise<void> {
  const runStartedAt = Math.floor(Date.now() / 1000);
  await ensureAwesomeCatalog();

  const argvMonths = parseMonthArg(process.argv.slice(2));
  const monthsElapsed = argvMonths > 0 ? argvMonths : 2;
  const freeTrialStreamingMonth =
    process.argv.includes("free-trial") || process.argv.includes("--free-trial");

  const yearlyDelivery = await getPriceByLookupKey(LOOKUP_DELIVERY_YEARLY_EUR);
  const monthlyStreaming = await getPriceByLookupKey(LOOKUP_STREAMING_BASE_EUR);

  // --- Existing delivery customer (yearly, flexible billing, advanced N months) ---
  const { clock, customer, paymentMethodId } = await createClockedCustomer({
    clockNamePrefix: "case5-flex",
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

  // --- Cancel old yearly delivery with credit ---
  await stripe.subscriptions.cancel(deliverySub.id, {
    prorate: true,
    invoice_now: true,
  });

  // --- New flexible subscription (yearly delivery + monthly streaming) ---
  const phaseTemplate = freeTrialStreamingMonth
    ? "flex_combined_trial100_90_50"
    : "flex_combined_90_50";

  const subscription = await stripe.subscriptions.create({
    customer: customer.id,
    default_payment_method: paymentMethodId,
    collection_method: "charge_automatically",
    billing_mode: { type: "flexible" },
    metadata: directSubscriptionMetadata({
      source: SOURCE,
      mix: "combined",
      phaseTemplate,
      hasTrial: freeTrialStreamingMonth,
      deliveryCadence: "year",
      streamCadence: "month",
      freeTrialStreaming: freeTrialStreamingMonth,
      couponSnapshot: freeTrialStreamingMonth
        ? `${COUPON_100},${COUPON_90},${COUPON_50}`
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
    from_subscription: subscription.id,
  });
  const retrieved = await stripe.subscriptionSchedules.retrieve(createdSchedule.id);
  const phaseStart = retrieved.phases[0]?.start_date;
  if (phaseStart === undefined) {
    throw new Error("Schedule missing phases[0].start_date after from_subscription");
  }

  const sub = await stripe.subscriptions.retrieve(subscription.id, {
    expand: ["items.data.price"],
  });
  const streamingItem = sub.items.data.find((it) => {
    const pid = typeof it.price === "string" ? it.price : it.price.id;
    return pid === monthlyStreaming.id;
  });
  if (
    streamingItem?.current_period_start === undefined ||
    streamingItem.current_period_end === undefined
  ) {
    throw new Error("Streaming item missing current_period_start/current_period_end");
  }

  const tc = await stripe.testHelpers.testClocks.retrieve(clock.id);
  const billingNow = tc.frozen_time + PHASE_END_SLACK_SEC;
  const defaultStart = Math.max(streamingItem.current_period_start, billingNow);
  const promoStart = Math.max(streamingItem.current_period_start, billingNow);
  const freeTrialStreaming = promoPhases.some((p) => p.couponId === COUPON_100);

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
        price: yearlyDelivery.id,
        quantity: 1,
        metadata: lineItemMetadata("delivery"),
      },
      streamItem,
    ];
  }

  const phases: Stripe.SubscriptionScheduleUpdateParams.Phase[] = [];

  // Stripe requires phases[0].start_date to equal the current phase's start_date
  // (`phaseStart`). When the gap to `defaultStart` is meaningful, insert a bridge
  // phase from phaseStart→defaultStart. Otherwise anchor the first promo phase
  // at phaseStart so the invariant always holds.
  let firstPromoStart = promoStart;
  if (phaseStart < defaultStart - PHASE_MERGE_EPS_SEC) {
    phases.push({
      start_date: phaseStart,
      end_date: defaultStart,
      metadata: schedulePhaseMetadataForSubscription({
        source: SOURCE,
        mix: "combined",
        phaseTemplate,
        hasTrialThisPhase: false,
        deliveryCadence: "year",
        streamCadence: "month",
        freeTrialStreaming,
      }),
      items: itemsWithCoupon(),
    });
  } else {
    firstPromoStart = phaseStart;
  }

  let cursor = firstPromoStart;
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
        deliveryCadence: "year",
        streamCadence: "month",
        freeTrialStreaming,
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
      deliveryCadence: "year",
      streamCadence: "month",
      freeTrialStreaming,
    }),
    items: itemsWithCoupon(),
  });

  const schedule = await stripe.subscriptionSchedules.update(createdSchedule.id, {
    phases,
    end_behavior: "release",
    metadata: subscriptionScheduleObjectMetadata(SOURCE, { freeTrialStreaming }),
    default_settings: {
      collection_method: "charge_automatically",
    },
    expand: ["subscription"],
  });

  const cadenceInvoicesUpdated = await syncInvoiceCadenceMetadataForSubscription({
    subscriptionId: subscription.id,
    createdGte: runStartedAt,
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
  console.log(`Invoices tagged with cadence: ${cadenceInvoicesUpdated}`);

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
  console.log("Optional: npm run … -- free-trial → €10, then €12×2, €20×3, €30…");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
