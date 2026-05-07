import { afterEach, describe, expect, it } from "vitest";
import { createAwesomeSchedule } from "../../src/lib/awesomeSchedule.js";
import { stripe } from "../../src/lib/stripe.js";
import { createTestClock, deleteTestClock } from "../../src/lib/testClock.js";

const hasStripeKey = Boolean(process.env.STRIPE_SECRET_KEY?.trim());
const TEST_PM = "pm_card_visa";

type CreatedResources = {
  scheduleIds: string[];
  subscriptionIds: string[];
  customerIds: string[];
  clockIds: string[];
  couponIds: string[];
};

function makeResources(): CreatedResources {
  return {
    scheduleIds: [],
    subscriptionIds: [],
    customerIds: [],
    clockIds: [],
    couponIds: [],
  };
}

function addMonthsUnix(baseUnixSec: number, months: number): number {
  const date = new Date(baseUnixSec * 1000);
  date.setUTCMonth(date.getUTCMonth() + months);
  return Math.floor(date.getTime() / 1000);
}

async function cleanupResources(resources: CreatedResources): Promise<void> {
  await Promise.all(
    resources.scheduleIds.map(async (id) => {
      try {
        const schedule = await stripe.subscriptionSchedules.retrieve(id);
        if (schedule.status !== "canceled" && schedule.status !== "released") {
          await stripe.subscriptionSchedules.cancel(id);
        }
      } catch {
        // Best effort cleanup; ignore already removed or immutable resources.
      }
    }),
  );

  await Promise.all(
    resources.subscriptionIds.map(async (id) => {
      try {
        await stripe.subscriptions.cancel(id);
      } catch {
        // Best effort cleanup.
      }
    }),
  );

  await Promise.all(
    resources.customerIds.map(async (id) => {
      try {
        await stripe.customers.del(id);
      } catch {
        // Best effort cleanup.
      }
    }),
  );

  await Promise.all(
    resources.clockIds.map(async (id) => {
      try {
        await deleteTestClock(id);
      } catch {
        // Best effort cleanup.
      }
    }),
  );

  await Promise.all(
    resources.couponIds.map(async (id) => {
      try {
        await stripe.coupons.del(id);
      } catch {
        // Best effort cleanup.
      }
    }),
  );
}

async function createClockedCustomer(resources: CreatedResources): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  const clock = await createTestClock({
    frozenTime: nowSec,
    name: `vitest-subscription-clock-${nowSec}`,
  });
  resources.clockIds.push(clock.id);

  const customer = await stripe.customers.create({
    email: `subscription-setup-${clock.id}@example.com`,
    test_clock: clock.id,
  });
  resources.customerIds.push(customer.id);

  const attachedPm = await stripe.paymentMethods.attach(TEST_PM, {
    customer: customer.id,
  });

  await stripe.customers.update(customer.id, {
    invoice_settings: { default_payment_method: attachedPm.id },
  });

  return customer.id;
}

async function createPercentCoupon(
  resources: CreatedResources,
  percentOff: number,
): Promise<string> {
  const id = `vitest-${percentOff}-off-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 7)}`;
  const coupon = await stripe.coupons.create({
    id,
    percent_off: percentOff,
    duration: "once",
  });
  resources.couponIds.push(coupon.id);
  return coupon.id;
}

describe.skipIf(!hasStripeKey)("Subscription setup schedules (integration)", () => {
  const resourcesByTest = new Map<string, CreatedResources>();

  afterEach(async (ctx) => {
    const key = ctx.task.id;
    const resources = resourcesByTest.get(key);
    if (resources) {
      await cleanupResources(resources);
      resourcesByTest.delete(key);
    }
  });

  it(
    "creates case A schedule with 90% then 50% discounts and release",
    async (ctx) => {
      const resources = makeResources();
      resourcesByTest.set(ctx.task.id, resources);

      const coupon90 = await createPercentCoupon(resources, 90);
      const coupon50 = await createPercentCoupon(resources, 50);
      const customerId = await createClockedCustomer(resources);

      const schedule = await createAwesomeSchedule(customerId, [
        { kind: "discount", couponId: coupon90, durationMonths: 3 },
        { kind: "discount", couponId: coupon50, durationMonths: 3 },
      ]);
      resources.scheduleIds.push(schedule.id);
      if (typeof schedule.subscription === "string") {
        resources.subscriptionIds.push(schedule.subscription);
      } else if (schedule.subscription?.id) {
        resources.subscriptionIds.push(schedule.subscription.id);
      }

      expect(schedule.end_behavior).toBe("release");
      expect(schedule.subscription).toBeTruthy();

      const phases = schedule.phases;
      expect(phases).toHaveLength(2);

      const phase0Start = phases[0]?.start_date;
      const phase0End = phases[0]?.end_date;
      const phase1Start = phases[1]?.start_date;
      const phase1End = phases[1]?.end_date;
      expect(typeof phase0Start).toBe("number");
      expect(typeof phase0End).toBe("number");
      expect(typeof phase1Start).toBe("number");
      expect(typeof phase1End).toBe("number");
      expect(phase0End).toBe(addMonthsUnix(phase0Start as number, 3));
      expect(phase1Start).toBe(phase0End);
      expect(phase1End).toBe(addMonthsUnix(phase1Start as number, 3));

      expect(phases[0]?.trial_end).toBeNull();
      expect(phases[0]?.discounts?.[0]?.coupon).toBe(coupon90);

      expect(phases[1]?.trial_end).toBeNull();
      expect(phases[1]?.discounts?.[0]?.coupon).toBe(coupon50);
    },
    120_000,
  );

  it(
    "creates case B schedule with 1mo trial, 90% then 50%, and release",
    async (ctx) => {
      const resources = makeResources();
      resourcesByTest.set(ctx.task.id, resources);

      const coupon90 = await createPercentCoupon(resources, 90);
      const coupon50 = await createPercentCoupon(resources, 50);
      const customerId = await createClockedCustomer(resources);

      const schedule = await createAwesomeSchedule(customerId, [
        { kind: "trial", durationMonths: 1 },
        { kind: "discount", couponId: coupon90, durationMonths: 2 },
        { kind: "discount", couponId: coupon50, durationMonths: 3 },
      ]);
      resources.scheduleIds.push(schedule.id);
      if (typeof schedule.subscription === "string") {
        resources.subscriptionIds.push(schedule.subscription);
      } else if (schedule.subscription?.id) {
        resources.subscriptionIds.push(schedule.subscription.id);
      }

      expect(schedule.end_behavior).toBe("release");
      expect(schedule.subscription).toBeTruthy();

      const phases = schedule.phases;
      expect(phases).toHaveLength(3);

      const phase0Start = phases[0]?.start_date;
      const phase0End = phases[0]?.end_date;
      const phase1Start = phases[1]?.start_date;
      const phase1End = phases[1]?.end_date;
      const phase2Start = phases[2]?.start_date;
      const phase2End = phases[2]?.end_date;
      expect(typeof phase0Start).toBe("number");
      expect(typeof phase0End).toBe("number");
      expect(typeof phase1Start).toBe("number");
      expect(typeof phase1End).toBe("number");
      expect(typeof phase2Start).toBe("number");
      expect(typeof phase2End).toBe("number");
      expect(phase0End).toBe(addMonthsUnix(phase0Start as number, 1));
      expect(phase1Start).toBe(phase0End);
      expect(phase1End).toBe(addMonthsUnix(phase1Start as number, 2));
      expect(phase2Start).toBe(phase1End);
      expect(phase2End).toBe(addMonthsUnix(phase2Start as number, 3));

      expect(phases[0]?.trial_end).toBeTruthy();
      expect(phases[0]?.discounts).toHaveLength(0);

      expect(phases[1]?.trial_end).toBeNull();
      expect(phases[1]?.discounts?.[0]?.coupon).toBe(coupon90);

      expect(phases[2]?.trial_end).toBeNull();
      expect(phases[2]?.discounts?.[0]?.coupon).toBe(coupon50);
    },
    120_000,
  );
});
