import { dashboardSubscriptionUrl } from "../lib/dashboardUrl.js";
import { ensureAwesomeCatalog } from "../lib/ensureAwesomeCatalog.js";
import { makeFakeCustomer } from "../lib/fakeCustomer.js";
import { getPriceByLookupKey } from "../lib/getPriceByLookupKey.js";
import { advanceTestClockByMonths, createTestClock } from "../lib/testClock.js";
import { stripe } from "../lib/stripe.js";
import {
  schedulePhaseMetadataForSubscription,
  subscriptionScheduleObjectMetadata,
} from "../lib/teeswagSubscriptionMetadata.js";
import { syncInvoiceCadenceMetadataForSubscription } from "../lib/syncInvoiceCadenceMetadata.js";
import { applyAwesomeRetention } from "../lib/applyRetention.js";

const COUPON_90 = "awesome-90-off-3m";
const COUPON_50 = "awesome-50-off-6m";
const TEST_PM = "pm_card_visa";
const RETENTION_MONTH = 4;
const SOURCE = "create_subscription_retention";

async function main(): Promise<void> {
  const runStartedAt = Math.floor(Date.now() / 1000);
  await ensureAwesomeCatalog();

  const { name, email } = makeFakeCustomer();

  const nowSec = Math.floor(Date.now() / 1000);
  const clock = await createTestClock({
    frozenTime: nowSec,
    name: `sub-retention-clock-${nowSec}`,
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

  const schedule = await stripe.subscriptionSchedules.create({
    customer: customer.id,
    start_date: "now",
    end_behavior: "release",
    metadata: subscriptionScheduleObjectMetadata(SOURCE),
    default_settings: {
      collection_method: "charge_automatically",
    },
    phases: [
      {
        items: [{ price: streamingPrice.id, quantity: 1 }],
        duration: { interval: "month", interval_count: 3 },
        discounts: [{ coupon: COUPON_90 }],
        metadata: schedulePhaseMetadataForSubscription({
          source: SOURCE,
          mix: "streaming_only",
          phaseTemplate: "90_50",
          streamCadence: "month",
          couponSnapshot: COUPON_90,
        }),
      },
      {
        items: [{ price: streamingPrice.id, quantity: 1 }],
        duration: { interval: "month", interval_count: 6 },
        discounts: [{ coupon: COUPON_50 }],
        metadata: schedulePhaseMetadataForSubscription({
          source: SOURCE,
          mix: "streaming_only",
          phaseTemplate: "90_50",
          streamCadence: "month",
          couponSnapshot: COUPON_50,
        }),
      },
    ],
    expand: ["subscription"],
  });

  const subId =
    typeof schedule.subscription === "string"
      ? schedule.subscription
      : (schedule.subscription?.id ?? "(pending)");

  console.log("--- Subscription created ---");
  console.log(`Test clock:    ${clock.id}`);
  console.log(`Customer:      ${customer.id} (${name}, ${email})`);
  console.log(`Schedule:      ${schedule.id}`);
  console.log(`Subscription:  ${subId}`);

  // Advance the clock to the 4th month so the subscription is in the second phase (50% coupon).
  console.log(`\n--- Advancing clock to month ${RETENTION_MONTH} ---`);
  await advanceTestClockByMonths(clock.id, RETENTION_MONTH);
  console.log(`Clock advanced ${RETENTION_MONTH} months (~${RETENTION_MONTH * 30}d).`);

  // Apply retention: swaps the current phase coupon to a stronger one (50% → 70%).
  console.log("\n--- Applying retention ---");
  if (subId === "(pending)") {
    throw new Error(
      "Subscription is still pending after clock advance; cannot apply retention.",
    );
  }

  const { scheduleId, appliedCouponId, customerAdhocCount } =
    await applyAwesomeRetention(subId);

  let cadenceInvoicesUpdated = 0;
  cadenceInvoicesUpdated = await syncInvoiceCadenceMetadataForSubscription({
    subscriptionId: subId,
    createdGte: runStartedAt,
  });

  console.log("\n--- Result ---");
  console.log(`Test clock:    ${clock.id}`);
  console.log(`Customer:      ${customer.id} (${name}, ${email})`);
  console.log(`Schedule:      ${scheduleId}`);
  console.log(`Subscription:  ${subId}`);
  console.log(`Dashboard:     ${dashboardSubscriptionUrl(subId)}`);
  console.log(
    `Advanced:      ${RETENTION_MONTH} month(s) (~${RETENTION_MONTH * 30}d on clock)`,
  );
  console.log(`Retention:     coupon swapped to ${appliedCouponId}`);
  console.log(`Customer ad-hoc count: ${customerAdhocCount}`);
  console.log(`Invoices tagged with cadence: ${cadenceInvoicesUpdated}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
