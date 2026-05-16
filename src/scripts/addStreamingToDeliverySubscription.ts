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
const MONTH_SEC = 30 * DAY;
const PHASE_MERGE_EPS_SEC = 120;

function trialCouponSnapshot(freeTrial: boolean): string {
  return freeTrial
    ? `free_streaming,${COUPON_90},${COUPON_50}`
    : `${COUPON_90},${COUPON_50}`;
}

async function main(): Promise<void> {
  const runStartedAt = Math.floor(Date.now() / 1000);
  await ensureAwesomeCatalog();

  const argv = process.argv.slice(2);
  const argvMonths = parseMonthArg(argv);
  const monthsElapsed = argvMonths > 0 ? argvMonths : 1;
  const stubDistance: StubDistance = parseStubDistanceArg(argv) ?? "short";
  const stubTargetDays = stubDistance === "long" ? 18 : 7;
  const freeTrial =
    process.argv.includes("free-trial") || process.argv.includes("--free-trial");

  const monthlyDelivery = await getPriceByLookupKey(LOOKUP_DELIVERY_MONTHLY_EUR);
  const monthlyStreaming = await getPriceByLookupKey(LOOKUP_STREAMING_BASE_EUR);
  const freeStreaming = await getPriceByLookupKey(LOOKUP_STREAMING_FREE_EUR);
  const phaseTemplate = freeTrial
    ? "combined_stubfree_trial1_90_50"
    : "combined_stub90_90_50";
  const couponSnapshot = trialCouponSnapshot(freeTrial);

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
      phaseTemplate,
      deliveryCadence: "month",
      streamCadence: "month",
      freeTrialStreaming: freeTrial,
      couponSnapshot,
    }),
    items: [
      {
        id: deliveryItem.id,
        price: monthlyDelivery.id,
        quantity: 1,
        metadata: lineItemMetadata("delivery"),
      },
      freeTrial
        ? {
            price: freeStreaming.id,
            quantity: 1,
            metadata: lineItemMetadata("streaming"),
          }
        : {
            price: monthlyStreaming.id,
            quantity: 1,
            metadata: lineItemMetadata("streaming"),
            discounts: [{ coupon: COUPON_90 }],
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

  const itemsList: Stripe.SubscriptionScheduleUpdateParams.Phase.Item[] = [
    {
      price: monthlyDelivery.id,
      quantity: 1,
      metadata: lineItemMetadata("delivery"),
    },
    {
      price: monthlyStreaming.id,
      quantity: 1,
      metadata: lineItemMetadata("streaming"),
    },
  ];
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
  const itemsStub: Stripe.SubscriptionScheduleUpdateParams.Phase.Item[] = freeTrial
    ? [
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
      ]
    : items90;

  const phases: Stripe.SubscriptionScheduleUpdateParams.Phase[] = [];
  let cursor = phaseStart;

  if (phaseStart < promoStart - PHASE_MERGE_EPS_SEC) {
    phases.push({
      start_date: phaseStart,
      end_date: promoStart,
      metadata: schedulePhaseMetadataForSubscription({
        source: SOURCE,
        mix: "combined",
        phaseTemplate,
        deliveryCadence: "month",
        streamCadence: "month",
        freeTrialStreaming: freeTrial,
        couponSnapshot: freeTrial ? "stub_free_streaming" : COUPON_90,
      }),
      items: itemsStub,
    });
    cursor = promoStart;
  }

  if (freeTrial) {
    phases.push({
      start_date: cursor,
      end_date: cursor + MONTH_SEC,
      metadata: schedulePhaseMetadataForSubscription({
        source: SOURCE,
        mix: "combined",
        phaseTemplate,
        deliveryCadence: "month",
        streamCadence: "month",
        freeTrialStreaming: true,
        couponSnapshot: "free_streaming_only",
      }),
      items: itemsStub,
    });
    cursor += MONTH_SEC;
    phases.push({
      start_date: cursor,
      end_date: cursor + 2 * MONTH_SEC,
      metadata: schedulePhaseMetadataForSubscription({
        source: SOURCE,
        mix: "combined",
        phaseTemplate,
        deliveryCadence: "month",
        streamCadence: "month",
        freeTrialStreaming: true,
        couponSnapshot: COUPON_90,
      }),
      items: items90,
    });
    cursor += 2 * MONTH_SEC;
    phases.push({
      start_date: cursor,
      end_date: cursor + 6 * MONTH_SEC,
      metadata: schedulePhaseMetadataForSubscription({
        source: SOURCE,
        mix: "combined",
        phaseTemplate,
        deliveryCadence: "month",
        streamCadence: "month",
        freeTrialStreaming: true,
        couponSnapshot: COUPON_50,
      }),
      items: items50,
    });
    cursor += 6 * MONTH_SEC;
  } else {
    phases.push({
      start_date: cursor,
      end_date: cursor + 3 * MONTH_SEC,
      metadata: schedulePhaseMetadataForSubscription({
        source: SOURCE,
        mix: "combined",
        phaseTemplate,
        deliveryCadence: "month",
        streamCadence: "month",
        freeTrialStreaming: false,
        couponSnapshot: COUPON_90,
      }),
      items: items90,
    });
    cursor += 3 * MONTH_SEC;
    phases.push({
      start_date: cursor,
      end_date: cursor + 6 * MONTH_SEC,
      metadata: schedulePhaseMetadataForSubscription({
        source: SOURCE,
        mix: "combined",
        phaseTemplate,
        deliveryCadence: "month",
        streamCadence: "month",
        freeTrialStreaming: false,
        couponSnapshot: COUPON_50,
      }),
      items: items50,
    });
    cursor += 6 * MONTH_SEC;
  }

  phases.push({
    start_date: cursor,
    end_date: cursor + MONTH_SEC,
    metadata: schedulePhaseMetadataForSubscription({
      source: SOURCE,
      mix: "combined",
      phaseTemplate,
      deliveryCadence: "month",
      streamCadence: "month",
      freeTrialStreaming: freeTrial,
      couponSnapshot: "none",
    }),
    items: itemsList,
  });

  const finalSchedule = await stripe.subscriptionSchedules.update(createdSchedule.id, {
    phases,
    end_behavior: "release",
    metadata: subscriptionScheduleObjectMetadata(SOURCE, {
      freeTrialStreaming: freeTrial,
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
    freeTrial
      ? "Add-streaming-to-delivery consolidated (free-trial): delivery charged throughout; streaming €0 for bridge + 1mo, then 90%×2, 50%×6, tail 1mo."
      : "Add-streaming-to-delivery consolidated: bridge monthly streaming + 90% coupon, then 90%×3, 50%×6, tail 1mo.",
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
