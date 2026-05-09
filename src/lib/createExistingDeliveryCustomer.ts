import type Stripe from "stripe";
import { createClockedCustomer } from "./clockedCustomer.js";
import { getPriceByLookupKey } from "./getPriceByLookupKey.js";
import {
  LOOKUP_DELIVERY_MONTHLY_EUR,
  LOOKUP_DELIVERY_YEARLY_EUR,
} from "./subscriptionCaseCatalog.js";
import { advanceTestClockByMonths } from "./testClock.js";
import { stripe } from "./stripe.js";
import {
  directSubscriptionMetadata,
  lineItemMetadata,
} from "./teeswagSubscriptionMetadata.js";

/**
 * Test clock + customer + existing Awesome Delivery subscription, optionally advanced
 * by N months (2-month chunks). Yearly delivery uses `billing_mode: flexible` for mixed-interval demos.
 */
export async function createExistingDeliveryCustomer(params: {
  interval: "month" | "year";
  monthsElapsed: number;
  clockNamePrefix: string;
  /** teeswag_source on the delivery subscription (e.g. bundle_two_lines). */
  teeswagSource: string;
}): Promise<{
  clock: Stripe.Response<Stripe.TestHelpers.TestClock>;
  customer: Stripe.Customer;
  deliverySub: Stripe.Subscription;
  paymentMethodId: string;
}> {
  const { clock, customer, paymentMethodId } = await createClockedCustomer({
    clockNamePrefix: params.clockNamePrefix,
  });

  const lookupKey =
    params.interval === "month"
      ? LOOKUP_DELIVERY_MONTHLY_EUR
      : LOOKUP_DELIVERY_YEARLY_EUR;
  const price = await getPriceByLookupKey(lookupKey);

  const createParams: Stripe.SubscriptionCreateParams = {
    customer: customer.id,
    default_payment_method: paymentMethodId,
    collection_method: "charge_automatically",
    metadata: directSubscriptionMetadata({
      source: params.teeswagSource,
      mix: "delivery_only",
      phaseTemplate: "none",
      hasTrial: false,
      deliveryCadence: params.interval,
    }),
    items: [
      {
        price: price.id,
        quantity: 1,
        metadata: lineItemMetadata("delivery"),
      },
    ],
    expand: ["items"],
  };
  if (params.interval === "year") {
    createParams.billing_mode = { type: "flexible" };
  }

  let deliverySub = await stripe.subscriptions.create(createParams);

  if (params.monthsElapsed > 0) {
    await advanceTestClockByMonths(clock.id, params.monthsElapsed);
  }

  deliverySub = await stripe.subscriptions.retrieve(deliverySub.id, {
    expand: ["items"],
  });

  return { clock, customer, deliverySub, paymentMethodId };
}
