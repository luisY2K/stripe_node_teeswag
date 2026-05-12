import {
  TEESWAG_KEYS,
  adhocPromotionCustomerMetadata,
  type TeeswagPricingMutation,
} from "./teeswagSubscriptionMetadata.js";
import { stripe } from "./stripe.js";

/**
 * Increment the customer-level ad-hoc promotion counters.
 *
 * Stripe's `customers.update({ metadata })` replaces the whole metadata map,
 * so we must retrieve existing metadata, merge our new keys on top, and write
 * the full result back.
 */
export async function bumpCustomerAdhocPromotion(
  customerId: string,
  kind: TeeswagPricingMutation,
  options: { at?: number } = {},
): Promise<{ count: number }> {
  const existing = await stripe.customers.retrieve(customerId);
  if (existing.deleted === true) {
    throw new Error(`Customer ${customerId} is deleted`);
  }

  const prevRaw = existing.metadata?.[TEESWAG_KEYS.ADHOC_PROMOTION_COUNT] ?? "0";
  const prevParsed = Number.parseInt(prevRaw, 10);
  const previousCount =
    Number.isFinite(prevParsed) && prevParsed >= 0 ? prevParsed : 0;

  const merged: Record<string, string> = {
    ...(existing.metadata ?? {}),
    ...adhocPromotionCustomerMetadata({
      previousCount,
      kind,
      at: options.at,
    }),
  };

  await stripe.customers.update(customerId, { metadata: merged });
  return { count: previousCount + 1 };
}
