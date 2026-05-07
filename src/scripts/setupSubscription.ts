import { makeFakeCustomer } from "../lib/fakeCustomer.js";
import { getPriceByLookupKey } from "../lib/getPriceByLookupKey.js";
import { stripe } from "../lib/stripe.js";

const PRICE_LOOKUP_KEY = "awesome_monthly_eur";
const COUPON_90 = "awesome-90-off-3m";
const COUPON_50 = "awesome-50-off-3m";
const TEST_PM = "pm_card_visa";

async function main(): Promise<void> {
  const { name, email } = makeFakeCustomer();

  const customer = await stripe.customers.create({ name, email });

  const attachedPm = await stripe.paymentMethods.attach(TEST_PM, {
    customer: customer.id,
  });

  await stripe.customers.update(customer.id, {
    invoice_settings: { default_payment_method: attachedPm.id },
  });

  const price = await getPriceByLookupKey(PRICE_LOOKUP_KEY);

  const schedule = await stripe.subscriptionSchedules.create({
    customer: customer.id,
    start_date: "now",
    end_behavior: "release",
    default_settings: {
      collection_method: "charge_automatically",
    },
    phases: [
      {
        items: [{ price: price.id, quantity: 1 }],
        duration: { interval: "month", interval_count: 3 },
        discounts: [{ coupon: COUPON_90 }],
      },
      {
        items: [{ price: price.id, quantity: 1 }],
        duration: { interval: "month", interval_count: 3 },
        discounts: [{ coupon: COUPON_50 }],
      },
    ],
    expand: ["subscription"],
  });

  const subId =
    typeof schedule.subscription === "string"
      ? schedule.subscription
      : schedule.subscription?.id ?? "(pending)";

  console.log(
    `Customer:     ${customer.id} (${name}, ${email})`,
  );
  console.log(`Schedule:     ${schedule.id}`);
  console.log(`Subscription: ${subId}`);
  console.log(
    "Tip: attach a test clock in the dashboard to advance billing and verify phases.",
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
