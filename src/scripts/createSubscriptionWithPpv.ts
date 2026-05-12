import { randomUUID } from "node:crypto";
import { dashboardSubscriptionUrl } from "../lib/dashboardUrl.js";
import { ensureAwesomeCatalog } from "../lib/ensureAwesomeCatalog.js";
import { makeFakeCustomer } from "../lib/fakeCustomer.js";
import { getPriceByLookupKey } from "../lib/getPriceByLookupKey.js";
import { parseMonthArg } from "../lib/parseMonthArg.js";
import { parseViewsArg } from "../lib/parseViewsArg.js";
import { PPV_METER_EVENT_NAME, PPV_PRICE_LOOKUP_KEY } from "../lib/ppvConstants.js";
import {
  advanceTestClock,
  createTestClock,
  waitTestClockReady,
} from "../lib/testClock.js";
import { stripe } from "../lib/stripe.js";
import {
  directSubscriptionMetadata,
  lineItemMetadata,
} from "../lib/teeswagSubscriptionMetadata.js";
import { syncInvoiceCadenceMetadataForSubscription } from "../lib/syncInvoiceCadenceMetadata.js";

const TEST_PM = "pm_card_visa";
const DAY = 86_400;
const SOURCE = "create_subscription_ppv";

async function main(): Promise<void> {
  const runStartedAt = Math.floor(Date.now() / 1000);
  await ensureAwesomeCatalog();
  const argv = process.argv.slice(2);
  const months = parseMonthArg(argv);
  const views = parseViewsArg(argv);
  const { name, email } = makeFakeCustomer();

  const nowSec = Math.floor(Date.now() / 1000);
  const clock = await createTestClock({
    frozenTime: nowSec,
    name: `sub-ppv-clock-${nowSec}`,
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

  const basePrice = await getPriceByLookupKey("awesome_monthly_eur");
  const ppvPrice = await getPriceByLookupKey(PPV_PRICE_LOOKUP_KEY);

  const subscription = await stripe.subscriptions.create({
    customer: customer.id,
    metadata: directSubscriptionMetadata({
      source: SOURCE,
      mix: "base_plus_ppv",
      phaseTemplate: "none",
      hasTrial: false,
      streamCadence: "month",
    }),
    items: [
      {
        price: basePrice.id,
        quantity: 1,
        metadata: lineItemMetadata("streaming"),
      },
      { price: ppvPrice.id, metadata: lineItemMetadata("ppv_metered") },
    ],
    default_payment_method: attachedPm.id,
    collection_method: "charge_automatically",
    expand: ["items"],
  });

  if (views > 0) {
    const clockState = await stripe.testHelpers.testClocks.retrieve(clock.id);
    for (let i = 0; i < views; i++) {
      await stripe.billing.meterEvents.create({
        event_name: PPV_METER_EVENT_NAME,
        payload: {
          stripe_customer_id: customer.id,
          value: "1",
        },
        identifier: randomUUID(),
        timestamp: clockState.frozen_time,
      });
    }
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

  const items = subscription.items.data;
  const cadenceInvoicesUpdated = await syncInvoiceCadenceMetadataForSubscription({
    subscriptionId: subscription.id,
    createdGte: runStartedAt,
  });
  const baseItem = items[0];
  const ppvItem = items[1];

  console.log(`Test clock:    ${clock.id}`);
  console.log(`Customer:      ${customer.id} (${name}, ${email})`);
  console.log(`Subscription:  ${subscription.id}`);
  if (baseItem !== undefined) {
    console.log(`Item (base):   ${baseItem.id} (qty=${baseItem.quantity ?? "?"})`);
  }
  if (ppvItem !== undefined) {
    console.log(`Item (PPV):    ${ppvItem.id} (metered)`);
  }
  console.log(`PPV events:    ${views} view(s) recorded`);
  console.log(`Dashboard:     ${dashboardSubscriptionUrl(subscription.id)}`);
  console.log(`Advanced:      ${months} month(s) (~${months * 30}d on clock)`);
  console.log(`Invoices tagged with cadence: ${cadenceInvoicesUpdated}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
