import Stripe from "stripe";
import { stripe } from "./stripe.js";

function isResourceMissing(error: unknown): boolean {
  return (
    error instanceof Stripe.errors.StripeInvalidRequestError &&
    error.code === "resource_missing"
  );
}

export async function findOrCreateProductById(params: {
  id: string;
  name: string;
}): Promise<Stripe.Response<Stripe.Product>> {
  try {
    return await stripe.products.retrieve(params.id);
  } catch (error: unknown) {
    if (!isResourceMissing(error)) {
      throw error;
    }
    return stripe.products.create({
      id: params.id,
      name: params.name,
    });
  }
}

export async function findOrCreatePriceByLookupKey(params: {
  lookupKey: string;
  product: string;
  unitAmount: number;
  currency: string;
  interval: Stripe.PriceCreateParams.Recurring.Interval;
}): Promise<Stripe.Price> {
  const existing = await stripe.prices.list({
    lookup_keys: [params.lookupKey],
    active: true,
    limit: 1,
  });

  const first = existing.data[0];
  if (first !== undefined) {
    return first;
  }

  return await stripe.prices.create({
    currency: params.currency,
    unit_amount: params.unitAmount,
    recurring: { interval: params.interval },
    product: params.product,
    lookup_key: params.lookupKey,
  });
}

export async function findOrCreateCoupon(
  params: Stripe.CouponCreateParams & { id: string },
): Promise<Stripe.Coupon> {
  const { id, ...createParams } = params;

  try {
    return await stripe.coupons.retrieve(id);
  } catch (error: unknown) {
    if (!isResourceMissing(error)) {
      throw error;
    }
    return await stripe.coupons.create({
      id,
      ...createParams,
    });
  }
}
