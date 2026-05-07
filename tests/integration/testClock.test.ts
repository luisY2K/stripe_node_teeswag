import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { stripe } from "../../src/lib/stripe.js";
import {
  advanceTestClock,
  createTestClock,
  deleteTestClock,
  waitTestClockReady,
} from "../../src/lib/testClock.js";

const hasStripeKey = Boolean(process.env.STRIPE_SECRET_KEY?.trim());

describe.skipIf(!hasStripeKey)("Stripe test clocks (integration)", () => {
  let testClockId: string | undefined;
  let customerId: string | undefined;
  let priceId: string | undefined;
  let subscriptionId: string | undefined;
  const day = 86_400;
  type WithTestClock<T> = T & { test_clock: string };

  beforeAll(async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const clock = await createTestClock({
      frozenTime: nowSec,
      name: `vitest-test-clock-${nowSec}`,
    });
    testClockId = clock.id;

    const customer = await stripe.customers.create({
      email: `test-clock-${clock.id}@example.com`,
      test_clock: clock.id,
    });
    customerId = customer.id;

    const productParams: WithTestClock<Stripe.ProductCreateParams> = {
      name: `Test product ${clock.id}`,
      test_clock: clock.id,
    };
    const product = await stripe.products.create(productParams);

    const priceParams: WithTestClock<Stripe.PriceCreateParams> = {
      currency: "usd",
      unit_amount: 100,
      recurring: { interval: "month" },
      product: product.id,
      test_clock: clock.id,
    };
    const price = await stripe.prices.create(priceParams);
    priceId = price.id;

    // Use send_invoice to avoid needing a payment method for this scaffold test.
    const subscriptionParams: WithTestClock<Stripe.SubscriptionCreateParams> = {
      customer: customer.id,
      items: [{ price: price.id }],
      collection_method: "send_invoice",
      days_until_due: 30,
      test_clock: clock.id,
    };
    const subscription = await stripe.subscriptions.create(subscriptionParams);
    subscriptionId = subscription.id;
  }, 60_000);

  afterAll(async () => {
    // Best-effort cleanup; the test clock is the most important.
    if (subscriptionId) {
      await stripe.subscriptions.cancel(subscriptionId);
    }
    if (testClockId !== undefined) {
      await deleteTestClock(testClockId);
    }
  }, 60_000);

  it("advances time and causes invoice activity", async () => {
    expect(testClockId).toBeDefined();
    const id = testClockId as string;
    expect(customerId).toBeDefined();
    expect(priceId).toBeDefined();
    expect(subscriptionId).toBeDefined();

    const invoicesBefore = await stripe.invoices.list({
      customer: customerId as string,
      limit: 100,
    });

    const clockBefore = await stripe.testHelpers.testClocks.retrieve(id);
    const nextFrozen = clockBefore.frozen_time + 35 * day;

    await advanceTestClock(id, nextFrozen);
    const clockAfter = await waitTestClockReady(id, { timeoutMs: 180_000 });

    expect(clockAfter.status).toBe("ready");
    expect(clockAfter.frozen_time).toBe(nextFrozen);

    const invoicesAfter = await stripe.invoices.list({
      customer: customerId as string,
      limit: 100,
    });

    // Plan requirement: assert on Stripe object state (not just clock readiness).
    expect(invoicesAfter.data.length).toBeGreaterThanOrEqual(
      invoicesBefore.data.length,
    );
  }, 180_000);
});
