import { dashboardSubscriptionUrl } from "../lib/dashboardUrl.js";
import { createClockedCustomer } from "../lib/clockedCustomer.js";
import { ensureAwesomeCatalog } from "../lib/ensureAwesomeCatalog.js";
import { getPriceByLookupKey } from "../lib/getPriceByLookupKey.js";
import { parseMonthArg } from "../lib/parseMonthArg.js";
import { advanceTestClock, waitTestClockReady } from "../lib/testClock.js";
import {
  LOOKUP_DELIVERY_YEARLY_EUR,
  LOOKUP_STREAMING_BASE_EUR,
} from "../lib/subscriptionCaseCatalog.js";
import { stripe } from "../lib/stripe.js";

const DAY = 86_400;

async function main(): Promise<void> {
  await ensureAwesomeCatalog();

  const months = parseMonthArg(process.argv.slice(2));
  const yearlyDelivery = await getPriceByLookupKey(LOOKUP_DELIVERY_YEARLY_EUR);
  const monthlyStreaming = await getPriceByLookupKey(LOOKUP_STREAMING_BASE_EUR);

  const { clock, customer, paymentMethodId } = await createClockedCustomer({
    clockNamePrefix: "add-streaming",
  });

  const subBefore = await stripe.subscriptions.create({
    customer: customer.id,
    default_payment_method: paymentMethodId,
    collection_method: "charge_automatically",
    billing_mode: { type: "flexible" },
    items: [{ price: yearlyDelivery.id, quantity: 1 }],
    expand: ["items"],
  });

  const deliveryItem = subBefore.items.data[0];
  if (deliveryItem === undefined) {
    throw new Error("Expected delivery subscription item");
  }

  if (months > 0) {
    const beforeClock = await stripe.testHelpers.testClocks.retrieve(clock.id);
    let currentFrozen = beforeClock.frozen_time;
    let remainingMonths = months;
    while (remainingMonths > 0) {
      const stepMonths = Math.min(2, remainingMonths);
      const stepTarget = currentFrozen + stepMonths * 30 * DAY;
      await advanceTestClock(clock.id, stepTarget);
      const ready = await waitTestClockReady(clock.id, { timeoutMs: 180_000 });
      currentFrozen = ready.frozen_time;
      remainingMonths -= stepMonths;
    }
  }

  const subAfter = await stripe.subscriptions.update(subBefore.id, {
    items: [
      {
        id: deliveryItem.id,
        price: yearlyDelivery.id,
        quantity: 1,
      },
      {
        price: monthlyStreaming.id,
        quantity: 1,
      },
    ],
    proration_behavior: "create_prorations",
    expand: ["items"],
  });

  console.log(
    "Add streaming to existing delivery: yearly delivery, then monthly streaming via subscriptions.update (see subscription-cases Case 6).",
  );
  console.log(`Test clock:     ${clock.id}`);
  console.log(`Customer:       ${customer.id}`);
  console.log(`Subscription:   ${subAfter.id}`);
  console.log(`Items before:   1 (delivery yearly)`);
  console.log(`Items after:    ${subAfter.items.data.length}`);
  console.log(`Dashboard:      ${dashboardSubscriptionUrl(subAfter.id)}`);
  console.log(`Advanced clock: ${months} month(s)`);
  console.log(
    "Cancel streaming only: subscriptionItems.delete on the streaming item; do not cancel the whole subscription.",
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
