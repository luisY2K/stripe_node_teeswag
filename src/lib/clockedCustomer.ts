import type Stripe from "stripe";
import { makeFakeCustomer } from "./fakeCustomer.js";
import { createTestClock } from "./testClock.js";
import { stripe } from "./stripe.js";

const TEST_PM = "pm_card_visa";

export async function createClockedCustomer(params: {
  clockNamePrefix: string;
}): Promise<{
  clock: Stripe.Response<Stripe.TestHelpers.TestClock>;
  customer: Stripe.Customer;
  paymentMethodId: string;
}> {
  const { name, email } = makeFakeCustomer();
  const nowSec = Math.floor(Date.now() / 1000);
  const clock = await createTestClock({
    frozenTime: nowSec,
    name: `${params.clockNamePrefix}-${nowSec}`,
  });

  const customer = await stripe.customers.create({
    name,
    email,
    test_clock: clock.id,
  });

  const attachedPm = await stripe.paymentMethods.attach(TEST_PM, {
    customer: customer.id,
  });

  await stripe.customers.update(customer.id, {
    invoice_settings: { default_payment_method: attachedPm.id },
  });

  return {
    clock,
    customer,
    paymentMethodId: attachedPm.id,
  };
}
