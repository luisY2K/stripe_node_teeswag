/**
 * Minimal demo: every Stripe step visible — bootstrap clock + customer + delivery sub,
 * advance ~2 months, add streaming with 90% coupon + create_prorations, then schedule:
 * optional bridge (schedule phase start → streaming anchor) + 90×3mo → 50×3mo → 1mo list-price tail → release.
 *
 * Stripe forbids changing the current phase's start_date on schedule.update; we read phases[0].start_date
 * after `from_subscription` and prepend a bridge phase when it differs from the streaming anchor.
 */
import type Stripe from "stripe";
import { dashboardSubscriptionUrl } from "../lib/dashboardUrl.js";
import { ensureAwesomeCatalog } from "../lib/ensureAwesomeCatalog.js";
import { makeFakeCustomer } from "../lib/fakeCustomer.js";
import { getPriceByLookupKey } from "../lib/getPriceByLookupKey.js";
import {
  LOOKUP_DELIVERY_MONTHLY_EUR,
  LOOKUP_STREAMING_BASE_EUR,
  LOOKUP_STREAMING_FREE_EUR,
} from "../lib/subscriptionCaseCatalog.js";
import { stripe } from "../lib/stripe.js";
import { advanceTestClock, waitTestClockReady } from "../lib/testClock.js";

const COUPON_90 = "awesome-90-off-3m";
const COUPON_50 = "awesome-50-off-3m";
const MONTH_SEC = 30 * 86_400;
const PHASE_MERGE_EPS_SEC = 120;

async function main(): Promise<void> {
  await ensureAwesomeCatalog();

  const monthlyDelivery = await getPriceByLookupKey(LOOKUP_DELIVERY_MONTHLY_EUR);
  const monthlyStreaming = await getPriceByLookupKey(LOOKUP_STREAMING_BASE_EUR);
  const freeStreaming = await getPriceByLookupKey(LOOKUP_STREAMING_FREE_EUR);
  const freeTrial =
    process.argv.includes("free-trial") || process.argv.includes("--free-trial");

  const nowSec = Math.floor(Date.now() / 1000);
  const { name, email } = makeFakeCustomer();

  // --- Bootstrap test clock + customer + payment method + delivery subscription ---
  const clock = await stripe.testHelpers.testClocks.create({
    frozen_time: nowSec,
    name: `simple-add-stream-${nowSec}`,
  });

  const customer = await stripe.customers.create({
    name,
    email,
    test_clock: clock.id,
  });

  const pm = await stripe.paymentMethods.attach("pm_card_visa", {
    customer: customer.id,
  });

  await stripe.customers.update(customer.id, {
    invoice_settings: { default_payment_method: pm.id },
  });

  const deliverySub = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: monthlyDelivery.id, quantity: 1 }],
    default_payment_method: pm.id,
    collection_method: "charge_automatically",
  });

  await advanceTestClock(clock.id, nowSec + 2 * MONTH_SEC);
  await waitTestClockReady(clock.id, { timeoutMs: 180_000 });

  // --- Add streaming line + prorations ---
  const existing = await stripe.subscriptions.retrieve(deliverySub.id);
  const existingDeliveryItem = existing.items.data[0];
  if (existingDeliveryItem === undefined) {
    throw new Error("Expected at least one subscription item (delivery)");
  }

  const updated = await stripe.subscriptions.update(deliverySub.id, {
    items: [
      { id: existingDeliveryItem.id },
      freeTrial
        ? {
            price: freeStreaming.id,
            quantity: 1,
          }
        : {
            price: monthlyStreaming.id,
            quantity: 1,
            discounts: [{ coupon: COUPON_90 }],
          },
    ],
    proration_behavior: "create_prorations",
    expand: ["items"],
  });

  // --- Subscription schedule: retrieve template start, bridge if needed, ladder, short full-price tail, release ---
  const schedule = await stripe.subscriptionSchedules.create({
    from_subscription: deliverySub.id,
  });

  const streamingItem = updated.items.data.find(
    (it) => it.id !== existingDeliveryItem.id,
  );
  if (streamingItem?.current_period_end === undefined) {
    throw new Error("Streaming item missing current_period_end");
  }

  const promoStart = streamingItem.current_period_end;

  const retrieved = await stripe.subscriptionSchedules.retrieve(schedule.id);
  const phaseStart = retrieved.phases[0]?.start_date;
  if (phaseStart === undefined) {
    throw new Error("Schedule missing phases[0].start_date after from_subscription");
  }
  if (promoStart <= phaseStart) {
    throw new Error(
      `Streaming anchor ${promoStart} must be after schedule phase start ${phaseStart}`,
    );
  }

  const items90: Stripe.SubscriptionScheduleUpdateParams.Phase.Item[] = [
    { price: monthlyDelivery.id, quantity: 1 },
    {
      price: monthlyStreaming.id,
      quantity: 1,
      discounts: [{ coupon: COUPON_90 }],
    },
  ];
  const items50: Stripe.SubscriptionScheduleUpdateParams.Phase.Item[] = [
    { price: monthlyDelivery.id, quantity: 1 },
    {
      price: monthlyStreaming.id,
      quantity: 1,
      discounts: [{ coupon: COUPON_50 }],
    },
  ];
  const itemsList: Stripe.SubscriptionScheduleUpdateParams.Phase.Item[] = [
    { price: monthlyDelivery.id, quantity: 1 },
    { price: monthlyStreaming.id, quantity: 1 },
  ];
  const itemsStubFree: Stripe.SubscriptionScheduleUpdateParams.Phase.Item[] = [
    { price: monthlyDelivery.id, quantity: 1 },
    { price: freeStreaming.id, quantity: 1 },
  ];

  const phases: Stripe.SubscriptionScheduleUpdateParams.Phase[] = [];

  let ladderStart = promoStart;
  if (phaseStart < promoStart - PHASE_MERGE_EPS_SEC) {
    phases.push({
      start_date: phaseStart,
      end_date: promoStart,
      items: freeTrial ? itemsStubFree : items90,
    });
  } else {
    ladderStart = phaseStart;
  }

  let cursor = ladderStart;
  if (freeTrial) {
    phases.push({
      start_date: cursor,
      end_date: cursor + MONTH_SEC,
      trial: true,
      items: itemsList,
    });
    cursor += MONTH_SEC;
    phases.push({
      start_date: cursor,
      end_date: cursor + 2 * MONTH_SEC,
      items: items90,
    });
    cursor += 2 * MONTH_SEC;
    phases.push({
      start_date: cursor,
      end_date: cursor + 3 * MONTH_SEC,
      items: items50,
    });
    cursor += 3 * MONTH_SEC;
  } else {
    phases.push({
      start_date: cursor,
      end_date: cursor + 3 * MONTH_SEC,
      items: items90,
    });
    cursor += 3 * MONTH_SEC;
    phases.push({
      start_date: cursor,
      end_date: cursor + 3 * MONTH_SEC,
      items: items50,
    });
    cursor += 3 * MONTH_SEC;
  }
  phases.push({
    start_date: cursor,
    end_date: cursor + MONTH_SEC,
    items: itemsList,
  });

  const finalSchedule = await stripe.subscriptionSchedules.update(schedule.id, {
    phases,
    end_behavior: "release",
    default_settings: {
      collection_method: "charge_automatically",
    },
    expand: ["subscription"],
  });

  console.log(
    freeTrial
      ? "Simple add-streaming demo (free-trial): stub €0 streaming, then trial 1mo, 90%×2mo, 50%×3mo, tail 1mo."
      : "Simple add-streaming demo (default): stub 90% coupon, then 90%×3mo, 50%×3mo, tail 1mo.",
  );
  console.log(`Test clock:    ${clock.id}`);
  console.log(`Customer:      ${customer.id}`);
  console.log(`Subscription:  ${deliverySub.id}`);
  console.log(`Schedule:      ${finalSchedule.id}`);
  console.log(`Schedule phase[0] start (Stripe): ${phaseStart}`);
  console.log(`Streaming anchor (promoStart):   ${promoStart}`);
  console.log(
    freeTrial
      ? "Phases: bridge (if any, stub €0 streaming) + trial 1mo + 90×2mo + 50×3mo + 1mo list price → release"
      : "Phases: bridge (if any) + 90×3mo + 50×3mo + 1mo list price → release",
  );
  console.log(`Dashboard:     ${dashboardSubscriptionUrl(deliverySub.id)}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
