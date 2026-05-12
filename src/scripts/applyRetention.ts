import type Stripe from "stripe";
import { dashboardSubscriptionUrl } from "../lib/dashboardUrl.js";
import { ensureAwesomeCatalog } from "../lib/ensureAwesomeCatalog.js";
import { findOrCreateCoupon } from "../lib/stripeIdempotent.js";
import { stripe } from "../lib/stripe.js";

const COUPON_90 = "awesome-90-off-3m";
const COUPON_50 = "awesome-50-off-3m";
const COUPON_100 = "awesome-100-off-3m";
const COUPON_70 = "awesome-70-off-3m";
const PRODUCT_ID = "prod_awesome";

const RETENTION_MAP: Record<string, string> = {
  [COUPON_90]: COUPON_100,
  [COUPON_50]: COUPON_70,
};

function resolveCouponId(
  c: string | Stripe.Coupon | null | undefined,
): string | undefined {
  if (c === null || c === undefined) return undefined;
  if (typeof c === "string") return c;
  return c.id;
}

async function main(): Promise<void> {
  const subscriptionId = process.argv[2];
  if (subscriptionId === undefined || subscriptionId.trim() === "") {
    console.error("Usage: npm run apply:retention -- <subscription_id>");
    process.exitCode = 1;
    return;
  }

  await ensureAwesomeCatalog();

  // --- Retrieve subscription and its schedule ---
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

  // --- Find the current phase ---
  const current = schedule.current_phase;
  if (current === null) {
    throw new Error(`Schedule ${schedule.id} has no current_phase.`);
  }

  const idx = schedule.phases.findIndex(
    (p) => p.start_date === current.start_date && p.end_date === current.end_date,
  );
  if (idx < 0) {
    throw new Error(`Could not match current_phase to phases[] on ${schedule.id}.`);
  }

  const currentPhase = schedule.phases[idx];
  if (currentPhase === undefined) {
    throw new Error(`Schedule ${schedule.id} has no phase at index ${idx}.`);
  }

  // --- Determine the retention coupon swap ---
  if (currentPhase.discounts.length === 0) {
    throw new Error(
      "Customer is in a phase with no subscription-level coupon (e.g. trial); no retention offer applicable yet.",
    );
  }

  const firstDiscount = currentPhase.discounts[0];
  const existingCouponId =
    firstDiscount !== undefined ? resolveCouponId(firstDiscount.coupon) : undefined;

  if (existingCouponId === undefined || !(existingCouponId in RETENTION_MAP)) {
    throw new Error(
      `No retention mapping for current coupon ${existingCouponId ?? "<none>"}.`,
    );
  }
  const replacementCouponId = RETENTION_MAP[existingCouponId];
  if (replacementCouponId === undefined) {
    throw new Error(`Internal: missing retention coupon for ${existingCouponId}.`);
  }

  // --- Ensure the retention coupon exists ---
  if (replacementCouponId === COUPON_100) {
    await findOrCreateCoupon({
      id: COUPON_100,
      name: "Awesome 100%",
      percent_off: 100,
      duration: "repeating",
      duration_in_months: 3,
      applies_to: { products: [PRODUCT_ID] },
      currency: "eur",
    });
  } else if (replacementCouponId === COUPON_70) {
    await findOrCreateCoupon({
      id: COUPON_70,
      name: "Awesome 70%",
      percent_off: 70,
      duration: "repeating",
      duration_in_months: 3,
      applies_to: { products: [PRODUCT_ID] },
      currency: "eur",
    });
  } else {
    throw new Error(`Unsupported retention coupon id: ${replacementCouponId}`);
  }

  // --- Rebuild all phases, swapping the coupon on the current phase ---
  const phases: Stripe.SubscriptionScheduleUpdateParams.Phase[] = schedule.phases.map(
    (p, i) => {
      if (p.items.length === 0) {
        throw new Error(`Phase on ${schedule.id} has no items`);
      }

      const items: Stripe.SubscriptionScheduleUpdateParams.Phase.Item[] = p.items.map(
        (it) => {
          const priceId = typeof it.price === "string" ? it.price : it.price.id;
          const item: Stripe.SubscriptionScheduleUpdateParams.Phase.Item = {
            price: priceId,
            quantity: it.quantity ?? 1,
          };
          if (
            it.metadata !== undefined &&
            it.metadata !== null &&
            Object.keys(it.metadata).length > 0
          ) {
            item.metadata = it.metadata;
          }
          if (it.discounts !== undefined && it.discounts.length > 0) {
            const mapped = it.discounts
              .map((d) => {
                const cid = resolveCouponId(d.coupon);
                return cid !== undefined ? { coupon: cid } : null;
              })
              .filter((x): x is { coupon: string } => x !== null);
            if (mapped.length > 0) {
              item.discounts = mapped;
            }
          }
          return item;
        },
      );

      const base: Stripe.SubscriptionScheduleUpdateParams.Phase = {
        items,
        start_date: p.start_date,
        end_date: p.end_date,
      };

      if (
        p.metadata !== undefined &&
        p.metadata !== null &&
        Object.keys(p.metadata).length > 0
      ) {
        base.metadata = p.metadata;
      }

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
          .filter((x): x is { coupon: string } => x !== null);
        if (mapped.length > 0) {
          base.discounts = mapped;
        }
      }

      return base;
    },
  );

  // Stripe rejects schedule updates that include phases whose end_date is in
  // the past ("You can not update a phase that has already ended."). Past
  // phases are preserved server-side, so we only send current + future phases.
  const updated = await stripe.subscriptionSchedules.update(schedule.id, {
    phases: phases.slice(idx),
    proration_behavior: "none",
  });

  console.log(`Schedule:        ${updated.id}`);
  console.log(`Applied coupon:  ${replacementCouponId}`);
  console.log(`Swapped from:    ${existingCouponId} → ${replacementCouponId}`);
  console.log(`Dashboard:       ${dashboardSubscriptionUrl(subscriptionId)}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
