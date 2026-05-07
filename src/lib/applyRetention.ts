import type Stripe from "stripe";
import { stripe } from "./stripe.js";

const COUPON_90 = "awesome-90-off-3m";
const COUPON_50 = "awesome-50-off-3m";
const COUPON_100 = "awesome-100-off-3m";
const COUPON_70 = "awesome-70-off-3m";

const RETENTION_MAP: Record<string, string> = {
  [COUPON_90]: COUPON_100,
  [COUPON_50]: COUPON_70,
};

function resolveCouponId(
  c: string | Stripe.Coupon | null | undefined,
): string | undefined {
  if (c === null || c === undefined) {
    return undefined;
  }
  if (typeof c === "string") {
    return c;
  }
  return c.id;
}

function firstCouponFromPhase(
  phase: Stripe.SubscriptionSchedule.Phase,
): string | undefined {
  const first = phase.discounts[0];
  if (first === undefined) {
    return undefined;
  }
  return resolveCouponId(first.coupon);
}

export async function applyAwesomeRetention(
  subscriptionId: string,
): Promise<{ scheduleId: string; appliedCouponId: string }> {
  const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ["schedule"],
  });

  const scheduleRef = subscription.schedule;
  const scheduleId =
    typeof scheduleRef === "string"
      ? scheduleRef
      : scheduleRef !== null && scheduleRef !== undefined
        ? scheduleRef.id
        : null;

  if (scheduleId === null) {
    throw new Error(
      `Subscription ${subscriptionId} has no active schedule (already released?).`,
    );
  }

  const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId);

  const current = schedule.current_phase;
  if (current === null) {
    throw new Error(`Schedule ${schedule.id} has no current_phase.`);
  }

  const idx = schedule.phases.findIndex(
    (p) =>
      p.start_date === current.start_date && p.end_date === current.end_date,
  );
  if (idx < 0) {
    throw new Error(
      `Could not match current_phase to phases[] on ${schedule.id}.`,
    );
  }

  const currentPhase = schedule.phases[idx];
  if (currentPhase === undefined) {
    throw new Error(`Schedule ${schedule.id} has no phase at index ${idx}.`);
  }

  if (currentPhase.discounts.length === 0) {
    throw new Error(
      "Customer is in a phase with no subscription-level coupon (e.g. trial); no retention offer applicable yet.",
    );
  }

  const existingCouponId = firstCouponFromPhase(currentPhase);
  if (
    existingCouponId === undefined ||
    !(existingCouponId in RETENTION_MAP)
  ) {
    throw new Error(
      `No retention mapping for current coupon ${existingCouponId ?? "<none>"}.`,
    );
  }
  const replacementCouponId = RETENTION_MAP[existingCouponId];
  if (replacementCouponId === undefined) {
    throw new Error(
      `Internal: missing retention coupon for ${existingCouponId}.`,
    );
  }

  const phases: Stripe.SubscriptionScheduleUpdateParams.Phase[] =
    schedule.phases.map((p, i) => {
      const firstItem = p.items[0];
      if (firstItem === undefined) {
        throw new Error(`Phase on ${schedule.id} has no items`);
      }
      const priceId =
        typeof firstItem.price === "string"
          ? firstItem.price
          : firstItem.price.id;

      const base: Stripe.SubscriptionScheduleUpdateParams.Phase = {
        items: [{ price: priceId, quantity: firstItem.quantity ?? 1 }],
        start_date: p.start_date,
        end_date: p.end_date,
      };

      if (p.trial_end !== null) {
        base.trial_end = p.trial_end;
      }

      if (i === idx) {
        base.discounts = [{ coupon: replacementCouponId }];
      } else if (p.discounts.length > 0) {
        const mapped = p.discounts
          .map((d) => {
            const cid = resolveCouponId(d.coupon);
            return cid !== undefined ? { coupon: cid } : null;
          })
          .filter(
            (x): x is { coupon: string } => x !== null,
          );
        if (mapped.length > 0) {
          base.discounts = mapped;
        }
      }

      return base;
    });

  const updated = await stripe.subscriptionSchedules.update(schedule.id, {
    phases,
    proration_behavior: "none",
  });

  return { scheduleId: updated.id, appliedCouponId: replacementCouponId };
}
