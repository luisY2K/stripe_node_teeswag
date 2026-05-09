import type Stripe from "stripe";
import { getPriceByLookupKey } from "./getPriceByLookupKey.js";
import {
  LOOKUP_DELIVERY_MONTHLY_EUR,
  LOOKUP_STREAMING_BASE_EUR,
} from "./subscriptionCaseCatalog.js";
import { stripe } from "./stripe.js";
import {
  lineItemMetadata,
  schedulePhaseMetadataForSubscription,
  subscriptionScheduleObjectMetadata,
} from "./teeswagSubscriptionMetadata.js";

const STREAMING_FULL_DISCOUNT_COUPON = "awesome-100-off-3m";

/** Discount phases only; delivery line has no coupon; streaming line carries the coupon per phase. */
export type CombinedDiscountPhase = {
  kind: "discount";
  couponId: string;
  durationMonths: number;
};

/**
 * One subscription schedule with two items per phase: Awesome Delivery (monthly, undiscounted)
 * + Awesome Stream (monthly, coupon on the streaming item only).
 */
export async function createCombinedDeliveryStreamingSchedule(
  customerId: string,
  phases: CombinedDiscountPhase[],
  options: { billingCycleAnchor?: number; teeswagSource?: string } = {},
): Promise<Stripe.SubscriptionSchedule> {
  const deliveryPrice = await getPriceByLookupKey(LOOKUP_DELIVERY_MONTHLY_EUR);
  const streamingPrice = await getPriceByLookupKey(LOOKUP_STREAMING_BASE_EUR);
  const scheduleSource = options.teeswagSource ?? "bundle_two_lines";
  const freeTrialStreaming = phases.some(
    (p) => p.couponId === STREAMING_FULL_DISCOUNT_COUPON,
  );

  const stripePhases: Stripe.SubscriptionScheduleCreateParams.Phase[] = phases.map(
    (p) => ({
      metadata: schedulePhaseMetadataForSubscription({
        source: scheduleSource,
        mix: "combined",
        phaseTemplate: "combined_90_50",
        hasTrialThisPhase: p.couponId === STREAMING_FULL_DISCOUNT_COUPON,
        deliveryCadence: "month",
        streamCadence: "month",
        freeTrialStreaming,
        couponSnapshot: p.couponId,
      }),
      items: [
        {
          price: deliveryPrice.id,
          quantity: 1,
          metadata: lineItemMetadata("delivery"),
        },
        {
          price: streamingPrice.id,
          quantity: 1,
          discounts: [{ coupon: p.couponId }],
          metadata: lineItemMetadata("streaming"),
        },
      ],
      duration: { interval: "month", interval_count: p.durationMonths },
    }),
  );

  const startDate =
    options.billingCycleAnchor !== undefined ? options.billingCycleAnchor : "now";

  return stripe.subscriptionSchedules.create({
    customer: customerId,
    start_date: startDate,
    end_behavior: "release",
    metadata: subscriptionScheduleObjectMetadata(scheduleSource, {
      freeTrialStreaming,
    }),
    default_settings: {
      collection_method: "charge_automatically",
    },
    phases: stripePhases,
    expand: ["subscription"],
  });
}
