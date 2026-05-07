import type Stripe from "stripe";
import { stripe } from "./stripe.js";

/**
 * Returns the first active price for the given lookup key, or throws.
 * Run `npm run setup:awesome` first to create `awesome_monthly_eur`.
 */
export async function getPriceByLookupKey(
  lookupKey: string,
): Promise<Stripe.Price> {
  const list = await stripe.prices.list({
    lookup_keys: [lookupKey],
    active: true,
    limit: 1,
  });

  const price = list.data[0];
  if (price === undefined) {
    throw new Error(
      `No active price found for lookup_key "${lookupKey}". Run: npm run setup:awesome`,
    );
  }

  return price;
}
