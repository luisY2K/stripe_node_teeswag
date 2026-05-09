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

/** Billing meter idempotency: list active meters and match on `event_name`. */
export async function findOrCreateMeterByEventName(params: {
  eventName: string;
  displayName: string;
}): Promise<Stripe.Billing.Meter> {
  const list = await stripe.billing.meters.list({
    status: "active",
    limit: 100,
  });

  const found = list.data.find((m) => m.event_name === params.eventName);
  if (found !== undefined) {
    return found;
  }

  return await stripe.billing.meters.create({
    display_name: params.displayName,
    event_name: params.eventName,
    default_aggregation: { formula: "sum" },
    customer_mapping: {
      type: "by_id",
      event_payload_key: "stripe_customer_id",
    },
    value_settings: { event_payload_key: "value" },
  });
}

/** Recurring metered price tied to a Billing Meter (`recurring.meter`). */
export async function findOrCreateMeteredPriceByLookupKey(params: {
  lookupKey: string;
  product: string;
  unitAmount: number;
  currency: string;
  interval: Stripe.PriceCreateParams.Recurring.Interval;
  meter: string;
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
    product: params.product,
    lookup_key: params.lookupKey,
    recurring: {
      interval: params.interval,
      usage_type: "metered",
      meter: params.meter,
    },
  });
}

export async function findOrCreateCoupon(
  params: Stripe.CouponCreateParams & { id: string },
): Promise<Stripe.Coupon> {
  const { id, ...createParams } = params;

  try {
    const existing = await stripe.coupons.retrieve(id);
    const desiredName = createParams.name;
    if (
      typeof desiredName === "string" &&
      desiredName !== "" &&
      existing.name !== desiredName
    ) {
      return await stripe.coupons.update(id, { name: desiredName });
    }
    return existing;
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
