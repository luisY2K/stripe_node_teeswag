import { dashboardSubscriptionUrl } from "../lib/dashboardUrl.js";
import { createAwesomeSchedule } from "../lib/awesomeSchedule.js";
import { createExistingDeliveryCustomer } from "../lib/createExistingDeliveryCustomer.js";
import { ensureAwesomeCatalog } from "../lib/ensureAwesomeCatalog.js";
import { parseMonthArg } from "../lib/parseMonthArg.js";
import { stripe } from "../lib/stripe.js";
import { syncInvoiceCadenceMetadataForSubscription } from "../lib/syncInvoiceCadenceMetadata.js";
import { advanceTestClockByMonths } from "../lib/testClock.js";

const COUPON_90 = "awesome-90-off-3m";
const COUPON_50 = "awesome-50-off-3m";

async function main(): Promise<void> {
  const runStartedAt = Math.floor(Date.now() / 1000);
  await ensureAwesomeCatalog();

  const argvMonths = parseMonthArg(process.argv.slice(2));
  const monthsElapsed = argvMonths > 0 ? argvMonths : 2;

  const { clock, customer, deliverySub } = await createExistingDeliveryCustomer({
    interval: "month",
    monthsElapsed,
    clockNamePrefix: "case1-aligned",
    teeswagSource: "aligned_delivery_streaming",
  });

  const schedule = await createAwesomeSchedule(
    customer.id,
    [
      { kind: "discount", couponId: COUPON_90, durationMonths: 3 },
      { kind: "discount", couponId: COUPON_50, durationMonths: 3 },
    ],
    {
      reporting: {
        source: "aligned_delivery_streaming",
        phaseTemplate: "90_50",
      },
    },
  );

  await advanceTestClockByMonths(clock.id, 2);

  const streamSubId =
    typeof schedule.subscription === "string"
      ? schedule.subscription
      : (schedule.subscription?.id ?? "(pending)");

  let streamAnchor = "(pending)";
  if (streamSubId !== "(pending)") {
    const streamSub = await stripe.subscriptions.retrieve(streamSubId);
    streamAnchor = String(streamSub.billing_cycle_anchor);
  }
  const deliveryTagged = await syncInvoiceCadenceMetadataForSubscription({
    subscriptionId: deliverySub.id,
    createdGte: runStartedAt,
  });
  let streamingTagged = 0;
  if (streamSubId !== "(pending)") {
    streamingTagged = await syncInvoiceCadenceMetadataForSubscription({
      subscriptionId: streamSubId,
      createdGte: runStartedAt,
    });
  }

  console.log(
    "Case 1: existing monthly Awesome Delivery, then Awesome Stream schedule starting now (streaming-only sub; delivery anchor unchanged on delivery sub).",
  );
  console.log(
    "Clock advanced +2 month(s) after delivery + streaming subscriptions exist.",
  );
  console.log(`Test clock:        ${clock.id}`);
  console.log(`Customer:          ${customer.id}`);
  console.log(
    `Delivery sub:      ${deliverySub.id} anchor=${deliverySub.billing_cycle_anchor}`,
  );
  console.log(`Streaming schedule:${schedule.id}`);
  console.log(`Streaming sub:     ${streamSubId} anchor=${streamAnchor}`);
  if (streamSubId !== "(pending)") {
    console.log(`Dashboard stream: ${dashboardSubscriptionUrl(streamSubId)}`);
  }
  console.log(`Dashboard delivery:${dashboardSubscriptionUrl(deliverySub.id)}`);
  console.log(
    `Invoices tagged with cadence: delivery=${deliveryTagged}, streaming=${streamingTagged}`,
  );
  console.log(
    "Two subscriptions → two invoice streams; streaming schedule uses start_date now (no past-anchor double bill on first streaming invoice).",
  );
  console.log(
    "Tip: npm run apply:retention -- <streaming_subscription_id> once subscription exists.",
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
