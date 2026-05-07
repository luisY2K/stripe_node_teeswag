import { dashboardSubscriptionUrl } from "../lib/dashboardUrl.js";
import { createClockedCustomer } from "../lib/clockedCustomer.js";
import { ensureAwesomeCatalog } from "../lib/ensureAwesomeCatalog.js";
import { getPriceByLookupKey } from "../lib/getPriceByLookupKey.js";
import {
  LOOKUP_DELIVERY_YEARLY_EUR,
  LOOKUP_STREAMING_BASE_EUR,
} from "../lib/subscriptionCaseCatalog.js";
import { stripe } from "../lib/stripe.js";

async function main(): Promise<void> {
  await ensureAwesomeCatalog();

  const yearlyDelivery = await getPriceByLookupKey(LOOKUP_DELIVERY_YEARLY_EUR);
  const monthlyStreaming = await getPriceByLookupKey(LOOKUP_STREAMING_BASE_EUR);

  const { customer, paymentMethodId } = await createClockedCustomer({
    clockNamePrefix: "flex-mixed",
  });

  const subscription = await stripe.subscriptions.create({
    customer: customer.id,
    default_payment_method: paymentMethodId,
    collection_method: "charge_automatically",
    billing_mode: { type: "flexible" },
    items: [
      { price: yearlyDelivery.id, quantity: 1 },
      { price: monthlyStreaming.id, quantity: 1 },
    ],
    expand: ["items.data.price"],
  });

  console.log(
    "Flexible mixed-interval: yearly delivery + monthly streaming on one subscription (subscription-cases Case 5). Combined invoice when periods align.",
  );
  console.log(`Customer:       ${customer.id}`);
  console.log(`Subscription:   ${subscription.id}`);
  console.log(`Dashboard:      ${dashboardSubscriptionUrl(subscription.id)}`);

  for (const it of subscription.items.data) {
    const price =
      typeof it.price === "string" ? it.price : (it.price?.lookup_key ?? it.price?.id);
    console.log(
      `Item ${it.id}: period ${it.current_period_start} → ${it.current_period_end} price=${price}`,
    );
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
