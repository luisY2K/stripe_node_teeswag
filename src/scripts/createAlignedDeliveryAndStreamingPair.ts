import { dashboardSubscriptionUrl } from "../lib/dashboardUrl.js";
import { createClockedCustomer } from "../lib/clockedCustomer.js";
import { deriveAnchorConfig } from "../lib/deriveAnchorConfig.js";
import { ensureAwesomeCatalog } from "../lib/ensureAwesomeCatalog.js";
import { getPriceByLookupKey } from "../lib/getPriceByLookupKey.js";
import {
  LOOKUP_DELIVERY_MONTHLY_EUR,
  LOOKUP_STREAMING_BASE_EUR,
} from "../lib/subscriptionCaseCatalog.js";
import { stripe } from "../lib/stripe.js";

async function main(): Promise<void> {
  await ensureAwesomeCatalog();

  const deliveryPrice = await getPriceByLookupKey(LOOKUP_DELIVERY_MONTHLY_EUR);
  const streamingPrice = await getPriceByLookupKey(LOOKUP_STREAMING_BASE_EUR);

  const { customer, paymentMethodId } = await createClockedCustomer({
    clockNamePrefix: "aligned-pair",
  });

  const subA = await stripe.subscriptions.create({
    customer: customer.id,
    default_payment_method: paymentMethodId,
    collection_method: "charge_automatically",
    items: [{ price: deliveryPrice.id, quantity: 1 }],
    billing_cycle_anchor_config: {
      day_of_month: 15,
      hour: 12,
      minute: 0,
      second: 0,
    },
    expand: ["items"],
  });

  const anchorSec = subA.billing_cycle_anchor;
  const aligned = deriveAnchorConfig(anchorSec);

  const subB = await stripe.subscriptions.create({
    customer: customer.id,
    default_payment_method: paymentMethodId,
    collection_method: "charge_automatically",
    items: [{ price: streamingPrice.id, quantity: 1 }],
    billing_cycle_anchor_config: aligned,
    expand: ["items"],
  });

  console.log(
    "Two subscriptions (delivery + streaming), billing_cycle_anchor_config matched (subscription-cases Case 1).",
  );
  console.log(`Customer:       ${customer.id}`);
  console.log(`subscription_a: ${subA.id} (delivery) anchor=${anchorSec}`);
  console.log(`Dashboard A:    ${dashboardSubscriptionUrl(subA.id)}`);
  console.log(
    `subscription_b: ${subB.id} (streaming base) anchor=${subB.billing_cycle_anchor}`,
  );
  console.log(`Dashboard B:    ${dashboardSubscriptionUrl(subB.id)}`);
  console.log(
    "Note: Same renewal calendar, but Stripe still produces separate invoices per subscription.",
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
