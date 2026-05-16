import type Stripe from "stripe";
import { dashboardSubscriptionUrl } from "../lib/dashboardUrl.js";
import { ensureAwesomeCatalog } from "../lib/ensureAwesomeCatalog.js";
import { makeFakeCustomer } from "../lib/fakeCustomer.js";
import { getPriceByLookupKey } from "../lib/getPriceByLookupKey.js";
import { parseMonthArg } from "../lib/parseMonthArg.js";
import {
  parseStubDistanceArg,
  type StubDistance,
} from "../lib/parseStubDistanceArg.js";
import {
  LOOKUP_DELIVERY_MONTHLY_EUR,
  LOOKUP_STREAMING_BASE_EUR,
  LOOKUP_STREAMING_FREE_EUR,
} from "../lib/subscriptionCaseCatalog.js";
import { syncInvoiceCadenceMetadataForSubscription } from "../lib/syncInvoiceCadenceMetadata.js";
import { stripe } from "../lib/stripe.js";
import {
  advanceTestClock,
  advanceTestClockByMonths,
  waitTestClockReady,
} from "../lib/testClock.js";
import {
  directSubscriptionMetadata,
  lineItemMetadata,
  schedulePhaseMetadataForSubscription,
  subscriptionScheduleObjectMetadata,
} from "../lib/teeswagSubscriptionMetadata.js";

const SOURCE = "add_streaming_to_delivery";
const COUPON_90 = "awesome-90-off-3m";
const COUPON_50 = "awesome-50-off-6m";
const DAY = 86_400;
const PHASE_MERGE_EPS_SEC = 120;
const PHASE_TEMPLATE = "combined_stubfree_trial1_90_50";
const COUPON_SNAPSHOT = `free_streaming,${COUPON_90},${COUPON_50}`;

async function main(): Promise<void> {
  const runStartedAt = Math.floor(Date.now() / 1000);
  await ensureAwesomeCatalog();

  const argv = process.argv.slice(2);
  const argvMonths = parseMonthArg(argv);
  const monthsElapsed = argvMonths > 0 ? argvMonths : 1;
  const stubDistance: StubDistance = parseStubDistanceArg(argv) ?? "short";
  const stubTargetDays = stubDistance === "long" ? 18 : 7;

  const monthlyDelivery = await getPriceByLookupKey(LOOKUP_DELIVERY_MONTHLY_EUR);
  const monthlyStreaming = await getPriceByLookupKey(LOOKUP_STREAMING_BASE_EUR);
  const freeStreaming = await getPriceByLookupKey(LOOKUP_STREAMING_FREE_EUR);

  const nowSec = Math.floor(Date.now() / 1000);
  const { name, email } = makeFakeCustomer();
  const clock = await stripe.testHelpers.testClocks.create({
    frozen_time: nowSec,
    name: `add-stream-to-delivery-${nowSec}`,
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

  let deliverySub = await stripe.subscriptions.create({
    customer: customer.id,
    items: [
      {
        price: monthlyDelivery.id,
        quantity: 1,
        metadata: lineItemMetadata("delivery"),
      },
    ],
    default_payment_method: pm.id,
    collection_method: "charge_automatically",
    metadata: directSubscriptionMetadata({
      source: SOURCE,
      mix: "delivery_only",
      phaseTemplate: "none",
      deliveryCadence: "month",
    }),
    expand: ["items"],
  });

  await advanceTestClockByMonths(clock.id, monthsElapsed);
  deliverySub = await stripe.subscriptions.retrieve(deliverySub.id, {
    expand: ["items"],
  });

  const initialDeliveryItem = deliverySub.items.data[0];
  if (initialDeliveryItem?.current_period_end === undefined) {
    throw new Error("Expected delivery item current_period_end for stub targeting");
  }
  const nextDeliveryBoundary = initialDeliveryItem.current_period_end;
  const clockBeforeStub = await stripe.testHelpers.testClocks.retrieve(clock.id);
  let targetAddStreamAt = nextDeliveryBoundary - stubTargetDays * DAY;
  while (targetAddStreamAt <= clockBeforeStub.frozen_time) {
    targetAddStreamAt += 30 * DAY;
  }
  await advanceTestClock(clock.id, targetAddStreamAt);
  await waitTestClockReady(clock.id, { timeoutMs: 180_000 });

  const effectiveDeliverySub = await stripe.subscriptions.retrieve(deliverySub.id, {
    expand: ["items"],
  });
  const deliveryItem = effectiveDeliverySub.items.data[0];
  if (deliveryItem === undefined) {
    throw new Error("Expected delivery subscription item");
  }

  const billingNow =
    (await stripe.testHelpers.testClocks.retrieve(clock.id)).frozen_time + 120;
  const updated = await stripe.subscriptions.update(deliverySub.id, {
    default_payment_method: pm.id,
    metadata: directSubscriptionMetadata({
      source: SOURCE,
      mix: "combined",
      phaseTemplate: PHASE_TEMPLATE,
      deliveryCadence: "month",
      streamCadence: "month",
      freeTrialStreaming: true,
      couponSnapshot: COUPON_SNAPSHOT,
    }),
    items: [
      {
        id: deliveryItem.id,
        price: monthlyDelivery.id,
        quantity: 1,
        metadata: lineItemMetadata("delivery"),
      },
      {
        price: freeStreaming.id,
        quantity: 1,
        metadata: lineItemMetadata("streaming"),
      },
    ],
    proration_behavior: "create_prorations",
    expand: ["items"],
  });

  const streamingItem = updated.items.data.find((it) => it.id !== deliveryItem.id);
  if (streamingItem?.current_period_end === undefined) {
    throw new Error("Expected streaming item current_period_end after add-stream step");
  }
  const promoStart = streamingItem.current_period_end;
  const stubDays = Math.max(0, Math.floor((promoStart - billingNow) / DAY));

  const createdSchedule = await stripe.subscriptionSchedules.create({
    from_subscription: updated.id,
  });
  const retrievedSchedule = await stripe.subscriptionSchedules.retrieve(
    createdSchedule.id,
  );
  const phaseStart = retrievedSchedule.phases[0]?.start_date;
  if (phaseStart === undefined) {
    throw new Error("Schedule missing phases[0].start_date after from_subscription");
  }
  if (promoStart < phaseStart) {
    throw new Error(
      `Streaming anchor ${promoStart} cannot be before schedule phase start ${phaseStart}`,
    );
  }

  const items90: Stripe.SubscriptionScheduleUpdateParams.Phase.Item[] = [
    {
      price: monthlyDelivery.id,
      quantity: 1,
      metadata: lineItemMetadata("delivery"),
    },
    {
      price: monthlyStreaming.id,
      quantity: 1,
      metadata: lineItemMetadata("streaming"),
      discounts: [{ coupon: COUPON_90 }],
    },
  ];
  const items50: Stripe.SubscriptionScheduleUpdateParams.Phase.Item[] = [
    {
      price: monthlyDelivery.id,
      quantity: 1,
      metadata: lineItemMetadata("delivery"),
    },
    {
      price: monthlyStreaming.id,
      quantity: 1,
      metadata: lineItemMetadata("streaming"),
      discounts: [{ coupon: COUPON_50 }],
    },
  ];
  const itemsStub: Stripe.SubscriptionScheduleUpdateParams.Phase.Item[] = [
    {
      price: monthlyDelivery.id,
      quantity: 1,
      metadata: lineItemMetadata("delivery"),
    },
    {
      price: freeStreaming.id,
      quantity: 1,
      metadata: lineItemMetadata("streaming"),
    },
  ];

  const phases: Stripe.SubscriptionScheduleUpdateParams.Phase[] = [];
  let cursor = phaseStart;

  const metadataBase = schedulePhaseMetadataForSubscription({
    source: SOURCE,
    mix: "combined",
    phaseTemplate: PHASE_TEMPLATE,
    deliveryCadence: "month",
    streamCadence: "month",
  });

  // When streaming was added mid-cycle (the normal case), this bridge phase
  // consumes the already-elapsed portion of the in-flight delivery cycle and
  // pushes the cursor forward to promoStart, so the 1-month free-trial phase
  // below anchors on the next billing boundary (where the next invoice lands).
  // The guard skips it only in the degenerate case where phaseStart and
  // promoStart are already at the same boundary - no elapsed time to bridge,
  // and Stripe would reject a near-zero-length phase anyway.
  if (phaseStart < promoStart - PHASE_MERGE_EPS_SEC) {
    phases.push({
      items: itemsStub,
      start_date: phaseStart,
      end_date: promoStart,
      metadata: schedulePhaseMetadataForSubscription({
        ...metadataBase,
      }),
    });
    cursor = promoStart;
  }

  phases.push({
    items: itemsStub,
    start_date: promoStart,
    duration: { interval: "month", interval_count: 1 },
    metadata: schedulePhaseMetadataForSubscription({
      ...metadataBase,
    }),
  });

  phases.push({
    items: items90,
    duration: { interval: "month", interval_count: 2 },
    metadata: schedulePhaseMetadataForSubscription({
      couponSnapshot: COUPON_90,
    }),
  });

  phases.push({
    items: items50,
    duration: { interval: "month", interval_count: 6 },
    metadata: schedulePhaseMetadataForSubscription({
      couponSnapshot: COUPON_50,
    }),
  });

  const finalSchedule = await stripe.subscriptionSchedules.update(createdSchedule.id, {
    phases,
    end_behavior: "release",
    metadata: subscriptionScheduleObjectMetadata(SOURCE, {
      freeTrialStreaming: true,
    }),
    default_settings: {
      collection_method: "charge_automatically",
    },
    expand: ["subscription"],
  });

  const cadenceInvoicesUpdated = await syncInvoiceCadenceMetadataForSubscription({
    subscriptionId: updated.id,
    createdGte: runStartedAt,
  });

  console.log(
    "Add-streaming-to-delivery (free-trial): delivery charged throughout; streaming €0 for bridge + 1mo, then 90%×2, 50%×6, tail 1mo.",
  );
  console.log(`Test clock:     ${clock.id}`);
  console.log(`Customer:       ${customer.id}`);
  console.log(`Subscription:   ${updated.id}`);
  console.log(`Schedule:       ${finalSchedule.id}`);
  console.log(`Dashboard:      ${dashboardSubscriptionUrl(updated.id)}`);
  console.log(`Invoices tagged with cadence: ${cadenceInvoicesUpdated}`);
  console.log(
    `Stub positioning: ${stubDistance} (stubDays≈${stubDays} until next anchor; default ~7d, stub long ~18d).`,
  );
  if (argvMonths > 0) {
    console.log(
      `Simulated tenure: ${monthsElapsed} month(s) after delivery create (parsed from separate CLI tokens "m ${monthsElapsed}" after --).`,
    );
  } else {
    console.log(
      'Simulated tenure: 1 month(s) after delivery create (default → ~2 delivery invoices). Override with two tokens after --, e.g. "m 4 stub long" (not "m4").',
    );
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
