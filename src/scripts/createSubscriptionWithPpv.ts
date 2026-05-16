import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { dashboardSubscriptionUrl } from "../lib/dashboardUrl.js";
import { ensureAwesomeCatalog } from "../lib/ensureAwesomeCatalog.js";
import { makeFakeCustomer } from "../lib/fakeCustomer.js";
import { getPriceByLookupKey } from "../lib/getPriceByLookupKey.js";
import { parseMonthArg } from "../lib/parseMonthArg.js";
import { parseViewsArg } from "../lib/parseViewsArg.js";
import { PPV_METER_EVENT_NAME, PPV_PRICE_LOOKUP_KEY } from "../lib/ppvConstants.js";
import {
  advanceTestClock,
  advanceTestClockByDays,
  createTestClock,
  waitTestClockReady,
} from "../lib/testClock.js";
import { stripe } from "../lib/stripe.js";
import {
  directSubscriptionMetadata,
  lineItemMetadata,
  schedulePhaseMetadataForSubscription,
  subscriptionScheduleObjectMetadata,
} from "../lib/teeswagSubscriptionMetadata.js";
import { syncInvoiceCadenceMetadataForSubscription } from "../lib/syncInvoiceCadenceMetadata.js";

const TEST_PM = "pm_card_visa";
const DAY = 86_400;
const SOURCE = "create_subscription_ppv";
const COUPON_90 = "awesome-90-off-3m";
const COUPON_50 = "awesome-50-off-6m";
const DEFAULT_ADD_PPV_AFTER_DAYS = 37;
const DEFAULT_VIEW_COUNT = 5;
const DEFAULT_VIEW_SPACING_DAYS = 2;

async function runDefaultScenario(): Promise<void> {
  const runStartedAt = Math.floor(Date.now() / 1000);

  console.log("--- Ensuring catalog ---");
  await ensureAwesomeCatalog();

  console.log("\n--- Creating customer + phased subscription ---");
  const { name, email } = makeFakeCustomer();

  const nowSec = Math.floor(Date.now() / 1000);
  const clock = await createTestClock({
    frozenTime: nowSec,
    name: `sub-ppv-default-clock-${nowSec}`,
  });

  const customer = await stripe.customers.create({
    name,
    email,
    test_clock: clock.id,
  });

  const attachedPm = await stripe.paymentMethods.attach(TEST_PM, {
    customer: customer.id,
  });

  await stripe.customers.update(customer.id, {
    invoice_settings: { default_payment_method: attachedPm.id },
  });

  const basePrice = await getPriceByLookupKey("awesome_monthly_eur");
  const ppvPrice = await getPriceByLookupKey(PPV_PRICE_LOOKUP_KEY);

  const createdSchedule = await stripe.subscriptionSchedules.create({
    customer: customer.id,
    start_date: "now",
    end_behavior: "release",
    metadata: subscriptionScheduleObjectMetadata(SOURCE),
    default_settings: { collection_method: "charge_automatically" },
    phases: [
      {
        items: [
          {
            price: basePrice.id,
            quantity: 1,
            metadata: lineItemMetadata("streaming"),
          },
        ],
        duration: { interval: "month", interval_count: 3 },
        discounts: [{ coupon: COUPON_90 }],
        metadata: schedulePhaseMetadataForSubscription({
          source: SOURCE,
          mix: "base_plus_ppv",
          phaseTemplate: "90_50_with_ppv",
          streamCadence: "month",
          couponSnapshot: COUPON_90,
        }),
      },
      {
        items: [
          {
            price: basePrice.id,
            quantity: 1,
            metadata: lineItemMetadata("streaming"),
          },
        ],
        duration: { interval: "month", interval_count: 6 },
        discounts: [{ coupon: COUPON_50 }],
        metadata: schedulePhaseMetadataForSubscription({
          source: SOURCE,
          mix: "base_plus_ppv",
          phaseTemplate: "90_50_with_ppv",
          streamCadence: "month",
          couponSnapshot: COUPON_50,
        }),
      },
    ],
    expand: ["subscription"],
  });

  const subId =
    typeof createdSchedule.subscription === "string"
      ? createdSchedule.subscription
      : createdSchedule.subscription?.id;
  if (subId === undefined) {
    throw new Error("Schedule did not produce a subscription id");
  }

  console.log(`Test clock:    ${clock.id}`);
  console.log(`Customer:      ${customer.id} (${name}, ${email})`);
  console.log(`Schedule:      ${createdSchedule.id}`);
  console.log(`Subscription:  ${subId}`);

  console.log(
    `\n--- Advancing clock by 1 month + 1 week (${DEFAULT_ADD_PPV_AFTER_DAYS} days) ---`,
  );
  await advanceTestClockByDays(clock.id, DEFAULT_ADD_PPV_AFTER_DAYS);
  console.log(`Clock advanced to day ~${DEFAULT_ADD_PPV_AFTER_DAYS}.`);

  console.log(
    "\n--- Adding metered PPV item (subscription + schedule phases) ---",
  );
  const subBeforePpv = await stripe.subscriptions.retrieve(subId, {
    expand: ["items"],
  });
  const baseItem = subBeforePpv.items.data[0];
  if (baseItem === undefined) {
    throw new Error("Expected base subscription item before adding PPV");
  }

  await stripe.subscriptions.update(subId, {
    items: [
      {
        id: baseItem.id,
        price: basePrice.id,
        quantity: 1,
        metadata: lineItemMetadata("streaming"),
      },
      {
        price: ppvPrice.id,
        metadata: lineItemMetadata("ppv_metered"),
      },
    ],
    metadata: directSubscriptionMetadata({
      source: SOURCE,
      mix: "base_plus_ppv",
      phaseTemplate: "90_50_with_ppv",
      streamCadence: "month",
      couponSnapshot: COUPON_90,
    }),
    proration_behavior: "create_prorations",
    expand: ["items"],
  });

  const liveSchedule = await stripe.subscriptionSchedules.retrieve(
    createdSchedule.id,
  );
  const phaseA = liveSchedule.phases[0];
  const phaseB = liveSchedule.phases[1];
  if (phaseA === undefined || phaseB === undefined) {
    throw new Error("Expected two existing phases on schedule for rewrite");
  }

  const phasesWithPpv: Stripe.SubscriptionScheduleUpdateParams.Phase[] = [
    {
      start_date: phaseA.start_date,
      end_date: phaseA.end_date,
      items: [
        {
          price: basePrice.id,
          quantity: 1,
          metadata: lineItemMetadata("streaming"),
        },
        {
          price: ppvPrice.id,
          metadata: lineItemMetadata("ppv_metered"),
        },
      ],
      discounts: [{ coupon: COUPON_90 }],
      metadata: schedulePhaseMetadataForSubscription({
        source: SOURCE,
        mix: "base_plus_ppv",
        phaseTemplate: "90_50_with_ppv",
        streamCadence: "month",
        couponSnapshot: COUPON_90,
      }),
    },
    {
      start_date: phaseB.start_date,
      end_date: phaseB.end_date,
      items: [
        {
          price: basePrice.id,
          quantity: 1,
          metadata: lineItemMetadata("streaming"),
        },
        {
          price: ppvPrice.id,
          metadata: lineItemMetadata("ppv_metered"),
        },
      ],
      discounts: [{ coupon: COUPON_50 }],
      metadata: schedulePhaseMetadataForSubscription({
        source: SOURCE,
        mix: "base_plus_ppv",
        phaseTemplate: "90_50_with_ppv",
        streamCadence: "month",
        couponSnapshot: COUPON_50,
      }),
    },
  ];

  await stripe.subscriptionSchedules.update(createdSchedule.id, {
    phases: phasesWithPpv,
    end_behavior: "release",
    metadata: subscriptionScheduleObjectMetadata(SOURCE),
    default_settings: { collection_method: "charge_automatically" },
  });
  console.log(
    "PPV item added; schedule phases rewritten so PPV survives phase 2.",
  );

  console.log(
    `\n--- Emitting ${DEFAULT_VIEW_COUNT} PPV view events (every ${DEFAULT_VIEW_SPACING_DAYS} days) ---`,
  );
  const viewDayOffsets: number[] = [];
  for (let i = 0; i < DEFAULT_VIEW_COUNT; i++) {
    if (i > 0) {
      await advanceTestClockByDays(clock.id, DEFAULT_VIEW_SPACING_DAYS);
    }
    const tick = await stripe.testHelpers.testClocks.retrieve(clock.id);
    await stripe.billing.meterEvents.create({
      event_name: PPV_METER_EVENT_NAME,
      payload: {
        stripe_customer_id: customer.id,
        value: "1",
      },
      identifier: randomUUID(),
      timestamp: tick.frozen_time,
    });
    const dayOffset = Math.round((tick.frozen_time - nowSec) / DAY);
    viewDayOffsets.push(dayOffset);
    console.log(
      `View ${i + 1}/${DEFAULT_VIEW_COUNT}: emitted at day ~${dayOffset}.`,
    );
  }

  console.log("\n--- Syncing invoice cadence metadata ---");
  const cadenceInvoicesUpdated = await syncInvoiceCadenceMetadataForSubscription({
    subscriptionId: subId,
    createdGte: runStartedAt,
  });
  console.log(`Invoices tagged with cadence: ${cadenceInvoicesUpdated}`);

  const finalClock = await stripe.testHelpers.testClocks.retrieve(clock.id);
  const endingDay = Math.round((finalClock.frozen_time - nowSec) / DAY);

  console.log("\n--- Result ---");
  console.log(`Test clock:    ${clock.id}`);
  console.log(`Customer:      ${customer.id} (${name}, ${email})`);
  console.log(`Schedule:      ${createdSchedule.id}`);
  console.log(`Subscription:  ${subId}`);
  console.log(`Dashboard:     ${dashboardSubscriptionUrl(subId)}`);
  console.log(
    "Phases:        90% x 3mo -> 50% x 3mo (PPV added to both phases mid phase 1)",
  );
  console.log(
    `Add-PPV at:    day ~${DEFAULT_ADD_PPV_AFTER_DAYS} (1 month + 1 week after start)`,
  );
  console.log(
    `PPV events:    ${viewDayOffsets.length} view(s) every ${DEFAULT_VIEW_SPACING_DAYS} day(s) at days [${viewDayOffsets.join(", ")}]`,
  );
  console.log(`Ending clock:  day ~${endingDay} after subscription start`);
  console.log(`Invoices tagged with cadence: ${cadenceInvoicesUpdated}`);
}

async function runLegacyScenario(argv: readonly string[]): Promise<void> {
  const runStartedAt = Math.floor(Date.now() / 1000);
  await ensureAwesomeCatalog();
  const months = parseMonthArg(argv);
  const views = parseViewsArg(argv);
  const { name, email } = makeFakeCustomer();

  const nowSec = Math.floor(Date.now() / 1000);
  const clock = await createTestClock({
    frozenTime: nowSec,
    name: `sub-ppv-clock-${nowSec}`,
  });

  const customer = await stripe.customers.create({
    name,
    email,
    test_clock: clock.id,
  });

  const attachedPm = await stripe.paymentMethods.attach(TEST_PM, {
    customer: customer.id,
  });

  await stripe.customers.update(customer.id, {
    invoice_settings: { default_payment_method: attachedPm.id },
  });

  const basePrice = await getPriceByLookupKey("awesome_monthly_eur");
  const ppvPrice = await getPriceByLookupKey(PPV_PRICE_LOOKUP_KEY);

  console.log("--- Creating subscription with PPV from t=0 ---");
  const subscription = await stripe.subscriptions.create({
    customer: customer.id,
    metadata: directSubscriptionMetadata({
      source: SOURCE,
      mix: "base_plus_ppv",
      phaseTemplate: "none",
      streamCadence: "month",
    }),
    items: [
      {
        price: basePrice.id,
        quantity: 1,
        metadata: lineItemMetadata("streaming"),
      },
      { price: ppvPrice.id, metadata: lineItemMetadata("ppv_metered") },
    ],
    default_payment_method: attachedPm.id,
    collection_method: "charge_automatically",
    expand: ["items"],
  });

  if (views > 0) {
    console.log(`\n--- Emitting ${views} burst view events at t=0 ---`);
    const clockState = await stripe.testHelpers.testClocks.retrieve(clock.id);
    for (let i = 0; i < views; i++) {
      await stripe.billing.meterEvents.create({
        event_name: PPV_METER_EVENT_NAME,
        payload: {
          stripe_customer_id: customer.id,
          value: "1",
        },
        identifier: randomUUID(),
        timestamp: clockState.frozen_time,
      });
    }
  }

  if (months > 0) {
    console.log(`\n--- Advancing clock by ${months} month(s) ---`);
    const beforeClock = await stripe.testHelpers.testClocks.retrieve(clock.id);
    let currentFrozen = beforeClock.frozen_time;
    let remainingMonths = months;
    while (remainingMonths > 0) {
      const stepMonths = Math.min(2, remainingMonths);
      const stepTarget = currentFrozen + stepMonths * 30 * DAY;
      await advanceTestClock(clock.id, stepTarget);
      const ready = await waitTestClockReady(clock.id, { timeoutMs: 180_000 });
      currentFrozen = ready.frozen_time;
      remainingMonths -= stepMonths;
    }
    console.log(`Clock advanced ${months} month(s) (~${months * 30}d).`);
  }

  const items = subscription.items.data;
  const cadenceInvoicesUpdated = await syncInvoiceCadenceMetadataForSubscription({
    subscriptionId: subscription.id,
    createdGte: runStartedAt,
  });
  const baseItem = items[0];
  const ppvItem = items[1];

  console.log("\n--- Result ---");
  console.log(`Test clock:    ${clock.id}`);
  console.log(`Customer:      ${customer.id} (${name}, ${email})`);
  console.log(`Subscription:  ${subscription.id}`);
  if (baseItem !== undefined) {
    console.log(`Item (base):   ${baseItem.id} (qty=${baseItem.quantity ?? "?"})`);
  }
  if (ppvItem !== undefined) {
    console.log(`Item (PPV):    ${ppvItem.id} (metered)`);
  }
  console.log(`PPV events:    ${views} view(s) recorded`);
  console.log(`Dashboard:     ${dashboardSubscriptionUrl(subscription.id)}`);
  console.log(`Advanced:      ${months} month(s) (~${months * 30}d on clock)`);
  console.log(`Invoices tagged with cadence: ${cadenceInvoicesUpdated}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    await runDefaultScenario();
    return;
  }
  await runLegacyScenario(argv);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
