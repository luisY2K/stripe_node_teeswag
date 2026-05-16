import { addMonthsUnix } from "../lib/addMonthsUnix.js";
import { dashboardSubscriptionUrl } from "../lib/dashboardUrl.js";
import { ensureAwesomeCatalog } from "../lib/ensureAwesomeCatalog.js";
import { makeFakeCustomer } from "../lib/fakeCustomer.js";
import { getPriceByLookupKey } from "../lib/getPriceByLookupKey.js";
import { parseMonthArg } from "../lib/parseMonthArg.js";
import {
  advanceTestClock,
  createTestClock,
  waitTestClockReady,
} from "../lib/testClock.js";
import { stripe } from "../lib/stripe.js";
import {
  schedulePhaseMetadataForSubscription,
  subscriptionScheduleObjectMetadata,
} from "../lib/teeswagSubscriptionMetadata.js";
import { syncInvoiceCadenceMetadataForSubscription } from "../lib/syncInvoiceCadenceMetadata.js";

const COUPON_90 = "awesome-90-off-3m";
const COUPON_50 = "awesome-50-off-6m";
const TEST_PM = "pm_card_visa";
const DAY = 86_400;
const SOURCE = "create_subscription_trial";

async function main(): Promise<void> {
  const runStartedAt = Math.floor(Date.now() / 1000);
  await ensureAwesomeCatalog();
  const months = parseMonthArg(process.argv.slice(2));
  const { name, email } = makeFakeCustomer();

  const nowSec = Math.floor(Date.now() / 1000);
  const clock = await createTestClock({
    frozenTime: nowSec,
    name: `sub-trial-clock-${nowSec}`,
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

  const streamingPrice = await getPriceByLookupKey("awesome_monthly_eur");

  // Phase 1 lasts 3 months: first month is free via trial_end, then 90% off
  // for the remaining 2 months. trial_end must be <= phase end_date per the
  // Stripe API, so both timestamps are computed client-side off nowSec (which
  // also anchors the schedule start) to avoid any server-side "now" drift.
  const trialEnd = addMonthsUnix(nowSec, 1);

  const schedule = await stripe.subscriptionSchedules.create({
    customer: customer.id,
    start_date: nowSec,
    end_behavior: "release",
    metadata: subscriptionScheduleObjectMetadata(SOURCE),
    default_settings: {
      collection_method: "charge_automatically",
    },
    phases: [
      {
        items: [{ price: streamingPrice.id, quantity: 1 }],
        duration: { interval: "month", interval_count: 3 },
        trial_end: trialEnd,
        discounts: [{ coupon: COUPON_90 }],
        metadata: schedulePhaseMetadataForSubscription({
          source: SOURCE,
          mix: "streaming_only",
          phaseTemplate: "trial_90_50",
          streamCadence: "month",
          couponSnapshot: COUPON_90,
        }),
      },
      {
        items: [{ price: streamingPrice.id, quantity: 1 }],
        duration: { interval: "month", interval_count: 6 },
        discounts: [{ coupon: COUPON_50 }],
        metadata: schedulePhaseMetadataForSubscription({
          couponSnapshot: COUPON_50,
        }),
      },
    ],
    expand: ["subscription"],
  });

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

  const subId =
    typeof schedule.subscription === "string"
      ? schedule.subscription
      : (schedule.subscription?.id ?? "(pending)");
  let cadenceInvoicesUpdated = 0;
  if (subId !== "(pending)") {
    cadenceInvoicesUpdated = await syncInvoiceCadenceMetadataForSubscription({
      subscriptionId: subId,
      createdGte: runStartedAt,
    });
  }

  console.log(`Test clock:    ${clock.id}`);
  console.log(`Customer:      ${customer.id} (${name}, ${email})`);
  console.log(`Schedule:      ${schedule.id}`);
  console.log(`Subscription:  ${subId}`);
  if (subId !== "(pending)") {
    console.log(`Dashboard:     ${dashboardSubscriptionUrl(subId)}`);
  }
  console.log(`Advanced:      ${months} month(s) (~${months * 30}d on clock)`);
  console.log(`Invoices tagged with cadence: ${cadenceInvoicesUpdated}`);
  console.log(
    "Phases: P1 3mo (1mo trial via trial_end + 2mo 90%) -> P2 6mo 50% -> release. Then apply:retention if needed.",
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
