import type Stripe from "stripe";
import { getPriceByLookupKey } from "./getPriceByLookupKey.js";
import { PPV_PRICE_LOOKUP_KEY } from "./ppvConstants.js";
import { stripe } from "./stripe.js";

const BASE_LOOKUP_KEY = "awesome_monthly_eur";

/**
 * One subscription with a licensed base item and a metered PPV item (same billing cycle / invoice).
 */
export async function createBaseWithPpvSubscription(params: {
  customerId: string;
  defaultPaymentMethodId: string;
}): Promise<Stripe.Subscription> {
  const basePrice = await getPriceByLookupKey(BASE_LOOKUP_KEY);
  const ppvPrice = await getPriceByLookupKey(PPV_PRICE_LOOKUP_KEY);

  return stripe.subscriptions.create({
    customer: params.customerId,
    items: [{ price: basePrice.id, quantity: 1 }, { price: ppvPrice.id }],
    default_payment_method: params.defaultPaymentMethodId,
    collection_method: "charge_automatically",
    expand: ["items"],
  });
}
