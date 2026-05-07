import { dashboardSubscriptionUrl } from "../lib/dashboardUrl.js";
import { createClockedCustomer } from "../lib/clockedCustomer.js";
import { ensureAwesomeCatalog } from "../lib/ensureAwesomeCatalog.js";
import { getPriceByLookupKey } from "../lib/getPriceByLookupKey.js";
import {
  BUNDLE_PRODUCT_ID,
  LOOKUP_BUNDLE_DELIVERY_MONTHLY_EUR,
  LOOKUP_BUNDLE_STREAMING_MONTHLY_EUR,
} from "../lib/subscriptionCaseCatalog.js";
import { stripe } from "../lib/stripe.js";

async function main(): Promise<void> {
  await ensureAwesomeCatalog();

  const bundleDelivery = await getPriceByLookupKey(LOOKUP_BUNDLE_DELIVERY_MONTHLY_EUR);
  const bundleStreaming = await getPriceByLookupKey(
    LOOKUP_BUNDLE_STREAMING_MONTHLY_EUR,
  );

  const { customer, paymentMethodId } = await createClockedCustomer({
    clockNamePrefix: "bundle-two-lines",
  });

  const subscription = await stripe.subscriptions.create({
    customer: customer.id,
    default_payment_method: paymentMethodId,
    collection_method: "charge_automatically",
    items: [
      { price: bundleDelivery.id, quantity: 1 },
      { price: bundleStreaming.id, quantity: 1 },
    ],
    expand: ["items"],
  });

  const items = subscription.items.data;
  const item0 = items[0];
  const item1 = items[1];

  console.log(
    `One subscription, two prices on Awesome Bundle (${BUNDLE_PRODUCT_ID}; subscription-cases Case 4).`,
  );
  console.log(`Customer:       ${customer.id}`);
  console.log(`Subscription:   ${subscription.id}`);
  if (item0 !== undefined) {
    console.log(`Item 0:         ${item0.id}`);
  }
  if (item1 !== undefined) {
    console.log(`Item 1:         ${item1.id}`);
  }
  console.log(`Dashboard:      ${dashboardSubscriptionUrl(subscription.id)}`);
  console.log(
    `Coupon caveat: applies_to.products=[${BUNDLE_PRODUCT_ID}] hits both bundle prices.`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
