import type Stripe from "stripe";
import { getPriceByLookupKey } from "./getPriceByLookupKey.js";
import { PPV_PRICE_LOOKUP_KEY } from "./ppvConstants.js";
import { stripe } from "./stripe.js";
import {
  directSubscriptionMetadata,
  lineItemMetadata,
} from "./teeswagSubscriptionMetadata.js";

const BASE_LOOKUP_KEY = "awesome_monthly_eur";

/**
 * One subscription with a licensed base item and a metered PPV item (same billing cycle / invoice).
 */
export async function createBaseWithPpvSubscription(params: {
  customerId: string;
  defaultPaymentMethodId: string;
  teeswagSource?: string;
}): Promise<Stripe.Subscription> {
  const basePrice = await getPriceByLookupKey(BASE_LOOKUP_KEY);
  const ppvPrice = await getPriceByLookupKey(PPV_PRICE_LOOKUP_KEY);
  const source = params.teeswagSource ?? "create_subscription_ppv";

  return stripe.subscriptions.create({
    customer: params.customerId,
    metadata: directSubscriptionMetadata({
      source,
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
    default_payment_method: params.defaultPaymentMethodId,
    collection_method: "charge_automatically",
    expand: ["items"],
  });
}
