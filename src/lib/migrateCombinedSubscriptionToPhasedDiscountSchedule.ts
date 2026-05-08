/**
 * Migrating an existing subscription uses two calls: subscription_schedules.create({ from_subscription }),
 * then subscription_schedules.update({ phases }) — see Stripe subscription_schedules API.
 *
 * Phased item-level coupons use phases.items[].discounts on the streaming line only.
 *
 * Stripe rejects changing the **current phase start_date** after migration. We keep the migrated phase's
 * **start_date** (billing anchor S), split with explicit **end_date**s, and anchor promo windows at the
 * streaming line's **current_period_start** (~ add-stream time).
 *
 * `params.phases` is an ordered list of promo segments (e.g. 90%×3mo, 50%×3mo, or optional leading 100%×1mo).
 */

import type Stripe from "stripe";
import { stripe } from "./stripe.js";
import {
  lineItemMetadata,
  schedulePhaseMetadataForSubscription,
  subscriptionScheduleObjectMetadata,
} from "./teeswagSubscriptionMetadata.js";
import type { CombinedDiscountPhase } from "./createCombinedDeliveryStreamingSchedule.js";

const MONTH_APPROX_SEC = 30 * 86_400;
/** Treat streaming period aligned with billing phase start as single segment (skip zero-length lead). */
const PHASE_START_MERGE_EPSILON_SEC = 120;
/** First phase end_date must be strictly after Stripe billing time; streaming current_period_start often equals clock exactly. */
const PHASE_END_AFTER_NOW_SLACK_SEC = 120;

export async function migrateCombinedSubscriptionToPhasedDiscountSchedule(params: {
  subscriptionId: string;
  deliveryPriceId: string;
  streamingPriceId: string;
  phases: CombinedDiscountPhase[];
  teeswagSource?: string;
  /** e.g. flex_combined_90_50 for yearly delivery + monthly stream */
  phaseTemplate?: string;
  /** When set, resolves billing \"now\" to test clock frozen_time (not wall clock). */
  testClockId?: string;
}): Promise<Stripe.SubscriptionSchedule> {
  const scheduleSource = params.teeswagSource ?? "add_streaming_to_delivery";
  const phaseTemplate = params.phaseTemplate ?? "combined_90_50";

  if (params.phases.length < 1) {
    throw new Error(
      "migrateCombinedSubscriptionToPhasedDiscountSchedule requires at least one discount phase.",
    );
  }

  const created = await stripe.subscriptionSchedules.create({
    from_subscription: params.subscriptionId,
  });

  const retrieved = await stripe.subscriptionSchedules.retrieve(created.id);

  const templatePhase = retrieved.phases[0];
  if (
    templatePhase?.start_date === undefined ||
    templatePhase?.end_date === undefined
  ) {
    throw new Error(
      `Schedule ${retrieved.id} missing phases[0].start_date/end_date after from_subscription.`,
    );
  }
  const phaseStart = templatePhase.start_date;
  const phaseEnd = templatePhase.end_date;

  const sub = await stripe.subscriptions.retrieve(params.subscriptionId, {
    expand: ["items.data.price"],
  });
  const streamingItem = sub.items.data.find((it) => {
    const pid = typeof it.price === "string" ? it.price : it.price.id;
    return pid === params.streamingPriceId;
  });
  if (streamingItem?.current_period_start === undefined) {
    throw new Error(
      `Streaming item for price ${params.streamingPriceId} missing current_period_start.`,
    );
  }
  const promoWindowStart = streamingItem.current_period_start;

  let stripeApproxNowSec = Math.floor(Date.now() / 1000);
  if (params.testClockId !== undefined && params.testClockId !== "") {
    const tc = await stripe.testHelpers.testClocks.retrieve(params.testClockId);
    stripeApproxNowSec = tc.frozen_time;
  }

  const promoKickoff = Math.max(
    promoWindowStart,
    stripeApproxNowSec + PHASE_END_AFTER_NOW_SLACK_SEC,
  );

  const itemsNoStreamCoupon: Stripe.SubscriptionScheduleUpdateParams.Phase.Item[] = [
    {
      price: params.deliveryPriceId,
      quantity: 1,
      metadata: lineItemMetadata("delivery"),
    },
    {
      price: params.streamingPriceId,
      quantity: 1,
      metadata: lineItemMetadata("streaming"),
    },
  ];

  function itemsWithStreamCoupon(
    couponId: string,
  ): Stripe.SubscriptionScheduleUpdateParams.Phase.Item[] {
    return [
      {
        price: params.deliveryPriceId,
        quantity: 1,
        metadata: lineItemMetadata("delivery"),
      },
      {
        price: params.streamingPriceId,
        quantity: 1,
        discounts: [{ coupon: couponId }],
        metadata: lineItemMetadata("streaming"),
      },
    ];
  }

  const hasLeadSegment = promoKickoff > phaseStart + PHASE_START_MERGE_EPSILON_SEC;
  const windowStart = hasLeadSegment ? promoKickoff : phaseStart;

  if (windowStart >= phaseEnd) {
    throw new Error(
      `Promo kickoff (${windowStart}) does not fall before schedule phase end (${phaseEnd}); try advancing test clock or use shorter elapsed delivery.`,
    );
  }

  const remainingBudgetSec = phaseEnd - windowStart;
  if (remainingBudgetSec <= 0) {
    throw new Error(
      `No time left in schedule phase for promos (phaseEnd ${phaseEnd} <= windowStart ${windowStart}).`,
    );
  }

  let budget = remainingBudgetSec;
  const allocated = params.phases.map((p) => {
    const wantSec = p.durationMonths * MONTH_APPROX_SEC;
    const allocSec = Math.min(wantSec, budget);
    budget -= allocSec;
    return { phase: p, allocSec };
  });

  const stripePhases: Stripe.SubscriptionScheduleUpdateParams.Phase[] = [];

  if (hasLeadSegment) {
    stripePhases.push({
      start_date: phaseStart,
      end_date: promoKickoff,
      metadata: schedulePhaseMetadataForSubscription({
        source: scheduleSource,
        mix: "combined",
        phaseTemplate,
        hasTrialThisPhase: false,
      }),
      items: itemsNoStreamCoupon,
    });
  }

  let cursor = windowStart;
  for (const { phase, allocSec } of allocated) {
    if (allocSec <= 0) {
      continue;
    }
    const segEnd = cursor + allocSec;
    stripePhases.push({
      start_date: cursor,
      end_date: segEnd,
      metadata: schedulePhaseMetadataForSubscription({
        source: scheduleSource,
        mix: "combined",
        phaseTemplate,
        hasTrialThisPhase: false,
        couponSnapshot: phase.couponId,
      }),
      items: itemsWithStreamCoupon(phase.couponId),
    });
    cursor = segEnd;
  }

  if (cursor < phaseEnd) {
    stripePhases.push({
      start_date: cursor,
      end_date: phaseEnd,
      metadata: schedulePhaseMetadataForSubscription({
        source: scheduleSource,
        mix: "combined",
        phaseTemplate,
        hasTrialThisPhase: false,
      }),
      items: itemsNoStreamCoupon,
    });
  }

  return stripe.subscriptionSchedules.update(created.id, {
    phases: stripePhases,
    end_behavior: "release",
    metadata: subscriptionScheduleObjectMetadata(scheduleSource),
    default_settings: {
      collection_method: "charge_automatically",
    },
    expand: ["subscription"],
  });
}
