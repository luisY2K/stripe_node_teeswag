/**
 * Migrating an existing subscription uses two calls: subscription_schedules.create({ from_subscription }),
 * then subscription_schedules.update({ phases }).
 *
 * This helper builds explicit timestamped phases from business intent:
 * optional lead -> optional stub-price bridge -> promo coupon ladder -> full-price tail.
 *
 * Unlike the previous implementation, this does not clamp promo phases to the first template
 * phase's end_date; it can extend future phases beyond that boundary.
 */

import type Stripe from "stripe";
import { stripe } from "./stripe.js";
import {
  lineItemMetadata,
  schedulePhaseMetadataForSubscription,
  subscriptionScheduleObjectMetadata,
  type TeeswagCadence,
} from "./teeswagSubscriptionMetadata.js";
import type { CombinedDiscountPhase } from "./createCombinedDeliveryStreamingSchedule.js";

const STREAMING_FULL_DISCOUNT_COUPON = "awesome-100-off-3m";
const MONTH_APPROX_SEC = 30 * 86_400;
const PHASE_START_MERGE_EPSILON_SEC = 120;
const PHASE_END_AFTER_NOW_SLACK_SEC = 120;

export async function migrateCombinedSubscriptionToPhasedDiscountSchedule(params: {
  subscriptionId: string;
  deliveryPriceId: string;
  streamingPriceId: string;
  phases: CombinedDiscountPhase[];
  teeswagSource?: string;
  /** e.g. flex_combined_90_50 for yearly delivery + monthly stream */
  phaseTemplate?: string;
  deliveryCadence?: TeeswagCadence;
  streamCadence?: TeeswagCadence;
  /** Optional explicit stub bridge segment start (defaults to "billing now"). */
  stubStartAt?: number;
  /** Promo ladder start (defaults to streaming item current_period_end). */
  promoStartAt?: number;
  /** Optional bridge streaming price for [stubStartAt -> promoStartAt]. */
  streamingStubPriceId?: string;
  /** Full-price tail phase length after promo ladder, defaults to 1 month. */
  fullPriceTailMonths?: number;
  /** When set, resolves billing \"now\" to test clock frozen_time (not wall clock). */
  testClockId?: string;
  /**
   * When set, tags schedule phases with this flag (e.g. €0 stub without a 100%-coupon promo phase).
   * Defaults to true if any phase uses the full-discount streaming coupon (`awesome-100-off-3m`).
   */
  freeTrialStreaming?: boolean;
  /** Optional Stripe coupon on streaming during [stubStart, promoStart). */
  stubStreamingCouponId?: string;
}): Promise<Stripe.SubscriptionSchedule> {
  const scheduleSource = params.teeswagSource ?? "add_streaming_to_delivery";
  const phaseTemplate = params.phaseTemplate ?? "combined_90_50";
  const deliveryCadence = params.deliveryCadence ?? "month";
  const streamCadence = params.streamCadence ?? "month";
  const fullPriceTailMonths = params.fullPriceTailMonths ?? 1;

  if (params.phases.length < 1) {
    throw new Error(
      "migrateCombinedSubscriptionToPhasedDiscountSchedule requires at least one discount phase.",
    );
  }

  const freeTrialStreaming =
    params.freeTrialStreaming ??
    params.phases.some((p) => p.couponId === STREAMING_FULL_DISCOUNT_COUPON);

  const created = await stripe.subscriptionSchedules.create({
    from_subscription: params.subscriptionId,
  });

  const retrieved = await stripe.subscriptionSchedules.retrieve(created.id);

  const templatePhase = retrieved.phases[0];
  if (templatePhase?.start_date === undefined) {
    throw new Error(
      `Schedule ${retrieved.id} missing phases[0].start_date after from_subscription.`,
    );
  }
  const phaseStart = templatePhase.start_date;

  const sub = await stripe.subscriptions.retrieve(params.subscriptionId, {
    expand: ["items.data.price"],
  });
  const streamingItem = sub.items.data.find((it) => {
    const pid = typeof it.price === "string" ? it.price : it.price.id;
    return pid === params.streamingPriceId;
  });
  if (
    streamingItem?.current_period_start === undefined ||
    streamingItem.current_period_end === undefined
  ) {
    throw new Error(
      `Streaming item for price ${params.streamingPriceId} missing current_period_start/current_period_end.`,
    );
  }
  const streamingPeriodStart = streamingItem.current_period_start;

  let stripeApproxNowSec = Math.floor(Date.now() / 1000);
  if (params.testClockId !== undefined && params.testClockId !== "") {
    const tc = await stripe.testHelpers.testClocks.retrieve(params.testClockId);
    stripeApproxNowSec = tc.frozen_time;
  }

  const billingNow = stripeApproxNowSec + PHASE_END_AFTER_NOW_SLACK_SEC;
  const defaultStubStart = Math.max(streamingPeriodStart, billingNow);
  const defaultPromoStart = Math.max(streamingPeriodStart, billingNow);
  const stubStart = params.stubStartAt ?? defaultStubStart;
  const promoStart = params.promoStartAt ?? defaultPromoStart;

  if (promoStart <= stubStart) {
    throw new Error(
      `Invalid promo window: promoStart (${promoStart}) must be after stubStart (${stubStart}).`,
    );
  }

  function itemsWithStreamingPrice(
    streamingPriceId: string,
    couponId?: string,
  ): Stripe.SubscriptionScheduleUpdateParams.Phase.Item[] {
    const streamItem: Stripe.SubscriptionScheduleUpdateParams.Phase.Item = {
      price: streamingPriceId,
      quantity: 1,
      metadata: lineItemMetadata("streaming"),
    };
    if (couponId !== undefined) {
      streamItem.discounts = [{ coupon: couponId }];
    }
    return [
      {
        price: params.deliveryPriceId,
        quantity: 1,
        metadata: lineItemMetadata("delivery"),
      },
      streamItem,
    ];
  }

  const itemsBaseNoCoupon = itemsWithStreamingPrice(params.streamingPriceId);
  const stubStreamingPriceId =
    params.streamingStubPriceId !== undefined
      ? params.streamingStubPriceId
      : params.streamingPriceId;
  const itemsStubSegment = itemsWithStreamingPrice(
    stubStreamingPriceId,
    params.stubStreamingCouponId,
  );

  const stripePhases: Stripe.SubscriptionScheduleUpdateParams.Phase[] = [];

  if (phaseStart < stubStart - PHASE_START_MERGE_EPSILON_SEC) {
    stripePhases.push({
      start_date: phaseStart,
      end_date: stubStart,
      metadata: schedulePhaseMetadataForSubscription({
        source: scheduleSource,
        mix: "combined",
        phaseTemplate,
        hasTrialThisPhase: false,
        deliveryCadence,
        streamCadence,
        freeTrialStreaming,
      }),
      items: itemsBaseNoCoupon,
    });
  }

  if (stubStart < promoStart - PHASE_START_MERGE_EPSILON_SEC) {
    stripePhases.push({
      start_date: stubStart,
      end_date: promoStart,
      metadata: schedulePhaseMetadataForSubscription({
        source: scheduleSource,
        mix: "combined",
        phaseTemplate,
        hasTrialThisPhase:
          params.stubStreamingCouponId === STREAMING_FULL_DISCOUNT_COUPON,
        deliveryCadence,
        streamCadence,
        freeTrialStreaming,
        couponSnapshot: params.stubStreamingCouponId,
      }),
      items: itemsStubSegment,
    });
  }

  let cursor = promoStart;
  for (const phase of params.phases) {
    const segEnd = cursor + phase.durationMonths * MONTH_APPROX_SEC;
    stripePhases.push({
      start_date: cursor,
      end_date: segEnd,
      metadata: schedulePhaseMetadataForSubscription({
        source: scheduleSource,
        mix: "combined",
        phaseTemplate,
        hasTrialThisPhase: phase.couponId === STREAMING_FULL_DISCOUNT_COUPON,
        deliveryCadence,
        streamCadence,
        freeTrialStreaming,
        couponSnapshot: phase.couponId,
      }),
      items: itemsWithStreamingPrice(params.streamingPriceId, phase.couponId),
    });
    cursor = segEnd;
  }

  const fullPriceTailEnd = cursor + fullPriceTailMonths * MONTH_APPROX_SEC;
  stripePhases.push({
    start_date: cursor,
    end_date: fullPriceTailEnd,
    metadata: schedulePhaseMetadataForSubscription({
      source: scheduleSource,
      mix: "combined",
      phaseTemplate,
      hasTrialThisPhase: false,
      deliveryCadence,
      streamCadence,
      freeTrialStreaming,
    }),
    items: itemsBaseNoCoupon,
  });

  return stripe.subscriptionSchedules.update(created.id, {
    phases: stripePhases,
    end_behavior: "release",
    metadata: subscriptionScheduleObjectMetadata(scheduleSource, {
      freeTrialStreaming,
    }),
    default_settings: {
      collection_method: "charge_automatically",
    },
    expand: ["subscription"],
  });
}
