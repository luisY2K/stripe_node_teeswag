/**
 * Spike: stub bridge uses base streaming price + coupon on the schedule phase,
 * then anchor-aligned ladder.
 *
 * Default: stub `awesome-90-off-3m` → 90%×3 → 50%×3 (same coupons as Case 6 ladder).
 * With `free-trial`: stub `awesome-100-off-3m` → 100%×1 → 90%×2 → 50%×3 on streaming.
 * See docs/subscription-cases.md (Case 6 spike note).
 */
import { dashboardSubscriptionUrl } from "../lib/dashboardUrl.js";
import { createExistingDeliveryCustomer } from "../lib/createExistingDeliveryCustomer.js";
import { ensureAwesomeCatalog } from "../lib/ensureAwesomeCatalog.js";
import { getPriceByLookupKey } from "../lib/getPriceByLookupKey.js";
import { migrateCombinedSubscriptionToPhasedDiscountSchedule } from "../lib/migrateCombinedSubscriptionToPhasedDiscountSchedule.js";
import { parseMonthArg } from "../lib/parseMonthArg.js";
import {
  parseStubDistanceArg,
  type StubDistance,
} from "../lib/parseStubDistanceArg.js";
import {
  LOOKUP_DELIVERY_MONTHLY_EUR,
  LOOKUP_STREAMING_BASE_EUR,
} from "../lib/subscriptionCaseCatalog.js";
import { syncInvoiceCadenceMetadataForSubscription } from "../lib/syncInvoiceCadenceMetadata.js";
import { advanceTestClock, waitTestClockReady } from "../lib/testClock.js";
import { stripe } from "../lib/stripe.js";
import {
  directSubscriptionMetadata,
  lineItemMetadata,
} from "../lib/teeswagSubscriptionMetadata.js";

const COUPON_100 = "awesome-100-off-3m";
const COUPON_90 = "awesome-90-off-3m";
const COUPON_50 = "awesome-50-off-3m";
const DAY = 86_400;

const PROMO_PHASES_NO_TRIAL = [
  { kind: "discount" as const, couponId: COUPON_90, durationMonths: 3 },
  { kind: "discount" as const, couponId: COUPON_50, durationMonths: 3 },
];

const PROMO_PHASES_FREE_TRIAL = [
  { kind: "discount" as const, couponId: COUPON_100, durationMonths: 1 },
  { kind: "discount" as const, couponId: COUPON_90, durationMonths: 2 },
  { kind: "discount" as const, couponId: COUPON_50, durationMonths: 3 },
];

const TEESWAG_SOURCE = "add_streaming_stub_promo";

function subscriptionCouponSnapshot(
  stubCouponId: string,
  phases: readonly { couponId: string }[],
): string {
  return `${stubCouponId}(stub)+${phases.map((p) => p.couponId).join(",")}`;
}

async function main(): Promise<void> {
  const runStartedAt = Math.floor(Date.now() / 1000);
  await ensureAwesomeCatalog();

  const argvMonths = parseMonthArg(process.argv.slice(2));
  const monthsElapsed = argvMonths > 0 ? argvMonths : 2;
  const stubDistance: StubDistance =
    parseStubDistanceArg(process.argv.slice(2)) ?? "short";
  const freeTrialStreamingMonth =
    process.argv.includes("free-trial") || process.argv.includes("--free-trial");

  const stubCouponId = freeTrialStreamingMonth ? COUPON_100 : COUPON_90;
  const promoPhases = freeTrialStreamingMonth
    ? PROMO_PHASES_FREE_TRIAL
    : PROMO_PHASES_NO_TRIAL;
  const phaseTemplate = freeTrialStreamingMonth
    ? "combined_stub_promo100_100_90_50"
    : "combined_stub_promo90_90_50";
  const couponSnapshot = subscriptionCouponSnapshot(stubCouponId, promoPhases);

  const monthlyDelivery = await getPriceByLookupKey(LOOKUP_DELIVERY_MONTHLY_EUR);
  const monthlyStreaming = await getPriceByLookupKey(LOOKUP_STREAMING_BASE_EUR);

  const { clock, customer, deliverySub, paymentMethodId } =
    await createExistingDeliveryCustomer({
      interval: "month",
      monthsElapsed,
      clockNamePrefix: "case6-stub-promo-spike",
      teeswagSource: TEESWAG_SOURCE,
    });

  let effectiveDeliverySub = deliverySub;
  const targetStubDays = stubDistance === "long" ? 18 : 7;
  const initialDeliveryItemForStub = deliverySub.items.data[0];
  if (initialDeliveryItemForStub?.current_period_end === undefined) {
    throw new Error("Expected delivery item current_period_end for stub targeting");
  }
  const nextDeliveryBoundary = initialDeliveryItemForStub.current_period_end;
  const clockBeforeStub = await stripe.testHelpers.testClocks.retrieve(clock.id);
  let targetAddStreamAt = nextDeliveryBoundary - targetStubDays * DAY;
  while (targetAddStreamAt <= clockBeforeStub.frozen_time) {
    targetAddStreamAt += 30 * DAY;
  }
  await advanceTestClock(clock.id, targetAddStreamAt);
  await waitTestClockReady(clock.id, { timeoutMs: 180_000 });
  effectiveDeliverySub = await stripe.subscriptions.retrieve(deliverySub.id, {
    expand: ["items"],
  });

  const deliveryItem = effectiveDeliverySub.items.data[0];
  if (deliveryItem === undefined) {
    throw new Error("Expected delivery subscription item");
  }

  const billingNow =
    (await stripe.testHelpers.testClocks.retrieve(clock.id)).frozen_time + 120;
  const subAfter = await stripe.subscriptions.update(deliverySub.id, {
    default_payment_method: paymentMethodId,
    metadata: directSubscriptionMetadata({
      source: TEESWAG_SOURCE,
      mix: "combined",
      phaseTemplate,
      hasTrial: false,
      deliveryCadence: "month",
      streamCadence: "month",
      freeTrialStreaming: freeTrialStreamingMonth || undefined,
      couponSnapshot,
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
        discounts: [{ coupon: COUPON_90 }],
      },
    ],
    proration_behavior: "create_prorations",
    expand: ["items"],
  });

  const streamingItem = subAfter.items.data.find((it) => {
    const pid = typeof it.price === "string" ? it.price : it.price?.id;
    return pid === monthlyStreaming.id;
  });
  if (
    streamingItem?.current_period_start === undefined ||
    streamingItem?.current_period_end === undefined
  ) {
    throw new Error(
      "Expected streaming item with current_period_start/current_period_end",
    );
  }
  const nextAnchor = streamingItem.current_period_end;
  const stubDays = Math.max(0, Math.floor((nextAnchor - billingNow) / DAY));

  await stripe.subscriptions.update(subAfter.id, {
    metadata: directSubscriptionMetadata({
      source: TEESWAG_SOURCE,
      mix: "combined",
      phaseTemplate,
      hasTrial: false,
      deliveryCadence: "month",
      streamCadence: "month",
      freeTrialStreaming: freeTrialStreamingMonth || undefined,
      couponSnapshot,
    }),
  });

  const schedule = await migrateCombinedSubscriptionToPhasedDiscountSchedule({
    subscriptionId: subAfter.id,
    deliveryPriceId: monthlyDelivery.id,
    streamingPriceId: monthlyStreaming.id,
    phases: [...promoPhases],
    teeswagSource: TEESWAG_SOURCE,
    phaseTemplate,
    deliveryCadence: "month",
    streamCadence: "month",
    stubStartAt: billingNow,
    promoStartAt: nextAnchor,
    testClockId: clock.id,
    stubStreamingCouponId: stubCouponId,
    freeTrialStreaming: freeTrialStreamingMonth,
  });

  const cadenceInvoicesUpdated = await syncInvoiceCadenceMetadataForSubscription({
    subscriptionId: subAfter.id,
    createdGte: runStartedAt,
  });

  console.log(
    freeTrialStreamingMonth
      ? "Spike (Case 6 variant, free-trial): stub = list streaming + 100% coupon; ladder 100%×1 → 90%×2 → 50%×3 → regular."
      : "Spike (Case 6 variant): stub = list streaming + 90% coupon; ladder 90%×3 → 50%×3 → regular.",
  );
  console.log(`Test clock:     ${clock.id}`);
  console.log(`Customer:       ${customer.id}`);
  console.log(`Subscription:   ${subAfter.id}`);
  console.log(`Schedule:       ${schedule.id}`);
  console.log(`Dashboard:      ${dashboardSubscriptionUrl(subAfter.id)}`);
  console.log(`Invoices tagged with cadence: ${cadenceInvoicesUpdated}`);
  console.log(
    `Stub positioning: ${stubDistance} (stubDays≈${stubDays} until anchor; default ~7d, stub long ~18d).`,
  );
  if (freeTrialStreamingMonth) {
    console.log(
      `Coupon caveat: stub + first ladder phase both use ${COUPON_100} (repeating / 3mo); Stripe may stack duration oddly — validate Dashboard/invoices or add duration-once sibling if needed.`,
    );
  } else {
    console.log(
      `Coupon caveat: stub + ladder both use ${COUPON_90}; Stripe repeating duration may interact oddly — validate in Dashboard or add a duration-once sibling coupon if needed.`,
    );
  }
  if (argvMonths > 0) {
    console.log(
      `Simulated tenure: ${monthsElapsed} month(s) (parsed from "m ${monthsElapsed}" after --).`,
    );
  } else {
    console.log(
      'Simulated tenure: 2 month(s) default; override with separate tokens e.g. "m 4 stub short".',
    );
  }
  console.log("");
  console.log(
    "Cancel streaming only: subscriptionItems.delete on the streaming item; do not cancel the whole subscription.",
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
