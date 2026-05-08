import type Stripe from "stripe";
import { getPriceByLookupKey } from "./getPriceByLookupKey.js";
import {
  schedulePhaseMetadataForSubscription,
  subscriptionScheduleObjectMetadata,
} from "./teeswagSubscriptionMetadata.js";
import { stripe } from "./stripe.js";

export type AwesomePhase =
  | { kind: "trial"; durationMonths: number }
  | { kind: "discount"; couponId: string; durationMonths: number };

const PRICE_LOOKUP_KEY = "awesome_monthly_eur";

export type AwesomeScheduleReporting = {
  source: string;
  phaseTemplate: string;
};

export async function createAwesomeSchedule(
  customerId: string,
  phases: AwesomePhase[],
  options: {
    startAt?: number | "now";
    reporting: AwesomeScheduleReporting;
  },
): Promise<Stripe.SubscriptionSchedule> {
  const price = await getPriceByLookupKey(PRICE_LOOKUP_KEY);

  const stripePhases: Stripe.SubscriptionScheduleCreateParams.Phase[] = phases.map(
    (p) => {
      const phaseMeta = schedulePhaseMetadataForSubscription({
        source: options.reporting.source,
        mix: "streaming_only",
        phaseTemplate: options.reporting.phaseTemplate,
        hasTrialThisPhase: p.kind === "trial",
        couponSnapshot: p.kind === "discount" ? p.couponId : undefined,
      });

      const base: Stripe.SubscriptionScheduleCreateParams.Phase = {
        items: [{ price: price.id, quantity: 1 }],
        duration: { interval: "month", interval_count: p.durationMonths },
        metadata: phaseMeta,
      };
      if (p.kind === "trial") {
        return { ...base, trial: true };
      }
      return {
        ...base,
        discounts: [{ coupon: p.couponId }],
      };
    },
  );

  const startDate = options.startAt ?? "now";

  return stripe.subscriptionSchedules.create({
    customer: customerId,
    start_date: startDate,
    end_behavior: "release",
    metadata: subscriptionScheduleObjectMetadata(options.reporting.source),
    default_settings: {
      collection_method: "charge_automatically",
    },
    phases: stripePhases,
    expand: ["subscription"],
  });
}
