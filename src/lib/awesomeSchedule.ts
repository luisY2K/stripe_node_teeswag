import type Stripe from "stripe";
import { getPriceByLookupKey } from "./getPriceByLookupKey.js";
import { stripe } from "./stripe.js";

export type AwesomePhase =
  | { kind: "trial"; durationMonths: number }
  | { kind: "discount"; couponId: string; durationMonths: number };

const PRICE_LOOKUP_KEY = "awesome_monthly_eur";

export async function createAwesomeSchedule(
  customerId: string,
  phases: AwesomePhase[],
): Promise<Stripe.SubscriptionSchedule> {
  const price = await getPriceByLookupKey(PRICE_LOOKUP_KEY);

  const stripePhases: Stripe.SubscriptionScheduleCreateParams.Phase[] = phases.map(
    (p) => {
      const base: Stripe.SubscriptionScheduleCreateParams.Phase = {
        items: [{ price: price.id, quantity: 1 }],
        duration: { interval: "month", interval_count: p.durationMonths },
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

  return stripe.subscriptionSchedules.create({
    customer: customerId,
    start_date: "now",
    end_behavior: "release",
    default_settings: {
      collection_method: "charge_automatically",
    },
    phases: stripePhases,
    expand: ["subscription"],
  });
}
