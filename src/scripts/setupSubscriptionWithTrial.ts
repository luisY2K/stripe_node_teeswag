import { createAwesomeSchedule } from "../lib/awesomeSchedule.js";
import { makeFakeCustomer } from "../lib/fakeCustomer.js";
import { stripe } from "../lib/stripe.js";

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

  const schedule = await createAwesomeSchedule(customer.id, [
    { kind: "trial", durationMonths: 1 },
    { kind: "discount", couponId: COUPON_90, durationMonths: 2 },
    { kind: "discount", couponId: COUPON_50, durationMonths: 3 },
  ]);

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
    "Phases: 1mo trial -> 2mo 90% -> 3mo 50% -> release. Use a test clock in the dashboard to advance.",
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
