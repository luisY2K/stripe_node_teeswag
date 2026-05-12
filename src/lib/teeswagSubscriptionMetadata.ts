import type Stripe from "stripe";

/** Stripe metadata keys for TeeSwag reporting (subscription + subscription items). */
export const TEESWAG_KEYS = {
  APP: "teeswag_app",
  SOURCE: "teeswag_source",
  MIX: "teeswag_mix",
  COUPON_SNAPSHOT: "teeswag_coupon_snapshot",
  PHASE_TEMPLATE: "teeswag_phase_template",
  HAS_TRIAL: "teeswag_has_trial",
  DELIVERY_CADENCE: "delivery_cadence",
  STREAM_CADENCE: "stream_cadence",
  /** Set when subscription used CLI `free-trial` / first-month 100% off streaming; repeated on phases so it survives phase changes. */
  FREE_TRIAL_STREAMING: "teeswag_free_trial_streaming",
  LINE_TYPE: "teeswag_line_type",
  /** Kind of out-of-template pricing mutation applied to the phase/schedule. */
  PRICING_MUTATION: "teeswag_pricing_mutation",
  /** Unix seconds (string) when the pricing mutation was applied. */
  PRICING_MUTATION_AT: "teeswag_pricing_mutation_at",
  /** Where the mutation originated (script name, helper name, dashboard, ...). */
  PRICING_MUTATION_SOURCE: "teeswag_pricing_mutation_source",
  /** Compact before/after coupon diff, e.g. `awesome-50-off-6m>awesome-70-off-6m`. */
  COUPON_BEFORE_AFTER: "teeswag_coupon_before_after",
  /** Customer-level: total ad-hoc promotions ever applied (integer string). */
  ADHOC_PROMOTION_COUNT: "teeswag_adhoc_promotion_count",
  /** Customer-level: Unix seconds (string) of the most recent ad-hoc promotion. */
  ADHOC_PROMOTION_LAST_AT: "teeswag_adhoc_promotion_last_at",
  /** Customer-level: kind of the most recent ad-hoc promotion. */
  ADHOC_PROMOTION_LAST_KIND: "teeswag_adhoc_promotion_last_kind",
} as const;

/** Kinds of out-of-template pricing mutations we tag with `teeswag_pricing_mutation`. */
export type TeeswagPricingMutation = "retention_coupon_swap";

export type TeeswagMix =
  | "delivery_only"
  | "streaming_only"
  | "combined"
  | "base_plus_ppv";

export type TeeswagLineType = "delivery" | "streaming" | "ppv_metered";
export type TeeswagCadence = "month" | "year";

/**
 * Subscription-level metadata on direct `subscriptions.create` / merged on `subscriptions.update`.
 */
export function directSubscriptionMetadata(params: {
  source: string;
  mix: TeeswagMix;
  phaseTemplate: string;
  hasTrial: boolean;
  deliveryCadence?: TeeswagCadence;
  streamCadence?: TeeswagCadence;
  couponSnapshot?: string;
  /** First-month streaming free-trial (`free-trial` CLI); sticky reporting flag. */
  freeTrialStreaming?: boolean;
}): Stripe.MetadataParam {
  const out: Record<string, string> = {
    [TEESWAG_KEYS.APP]: "teeswag_alt",
    [TEESWAG_KEYS.SOURCE]: params.source,
    [TEESWAG_KEYS.MIX]: params.mix,
    [TEESWAG_KEYS.PHASE_TEMPLATE]: params.phaseTemplate,
    [TEESWAG_KEYS.HAS_TRIAL]: params.hasTrial ? "true" : "false",
  };
  if (params.freeTrialStreaming === true) {
    out[TEESWAG_KEYS.FREE_TRIAL_STREAMING] = "true";
  }
  if (params.deliveryCadence !== undefined) {
    out[TEESWAG_KEYS.DELIVERY_CADENCE] = params.deliveryCadence;
  }
  if (params.streamCadence !== undefined) {
    out[TEESWAG_KEYS.STREAM_CADENCE] = params.streamCadence;
  }
  if (
    params.couponSnapshot !== undefined &&
    params.couponSnapshot !== "" &&
    params.couponSnapshot !== "none"
  ) {
    out[TEESWAG_KEYS.COUPON_SNAPSHOT] = params.couponSnapshot;
  }
  return out;
}

/**
 * Metadata on each subscription schedule phase — Stripe copies onto the Subscription when the phase is entered.
 */
export function schedulePhaseMetadataForSubscription(params: {
  source: string;
  mix: TeeswagMix;
  phaseTemplate: string;
  hasTrialThisPhase: boolean;
  deliveryCadence?: TeeswagCadence;
  streamCadence?: TeeswagCadence;
  couponSnapshot?: string;
  freeTrialStreaming?: boolean;
}): Stripe.MetadataParam {
  return directSubscriptionMetadata({
    source: params.source,
    mix: params.mix,
    phaseTemplate: params.phaseTemplate,
    hasTrial: params.hasTrialThisPhase,
    deliveryCadence: params.deliveryCadence,
    streamCadence: params.streamCadence,
    couponSnapshot: params.couponSnapshot,
    freeTrialStreaming: params.freeTrialStreaming,
  });
}

/** Metadata on a subscription item (delivery / streaming / PPV meter line). */
export function lineItemMetadata(lineType: TeeswagLineType): Stripe.MetadataParam {
  return { [TEESWAG_KEYS.LINE_TYPE]: lineType };
}

/** Optional metadata on the SubscriptionSchedule resource (debugging / joining to subscription). */
export function subscriptionScheduleObjectMetadata(
  source: string,
  options: { freeTrialStreaming?: boolean } = {},
): Stripe.MetadataParam {
  const out: Record<string, string> = {
    [TEESWAG_KEYS.APP]: "teeswag_alt",
    [TEESWAG_KEYS.SOURCE]: source,
  };
  if (options.freeTrialStreaming === true) {
    out[TEESWAG_KEYS.FREE_TRIAL_STREAMING] = "true";
  }
  return out;
}

/**
 * Metadata keys describing a single out-of-template pricing mutation event.
 *
 * Returned as a flat record so it can be **spread** onto an existing phase or
 * schedule metadata object, preserving the original template tags.
 */
export function pricingMutationMetadata(params: {
  mutation: TeeswagPricingMutation;
  source: string;
  couponBefore: string;
  couponAfter: string;
  at?: number;
}): Record<string, string> {
  const at = params.at ?? Math.floor(Date.now() / 1000);
  return {
    [TEESWAG_KEYS.PRICING_MUTATION]: params.mutation,
    [TEESWAG_KEYS.PRICING_MUTATION_AT]: String(at),
    [TEESWAG_KEYS.PRICING_MUTATION_SOURCE]: params.source,
    [TEESWAG_KEYS.COUPON_BEFORE_AFTER]: `${params.couponBefore}>${params.couponAfter}`,
  };
}

/**
 * Customer-level lifetime ad-hoc promotion counters. Caller is responsible for
 * passing the current count from the customer's existing metadata; this
 * function returns the new state to merge back.
 */
export function adhocPromotionCustomerMetadata(params: {
  previousCount: number;
  kind: TeeswagPricingMutation;
  at?: number;
}): Record<string, string> {
  const at = params.at ?? Math.floor(Date.now() / 1000);
  return {
    [TEESWAG_KEYS.ADHOC_PROMOTION_COUNT]: String(params.previousCount + 1),
    [TEESWAG_KEYS.ADHOC_PROMOTION_LAST_AT]: String(at),
    [TEESWAG_KEYS.ADHOC_PROMOTION_LAST_KIND]: params.kind,
  };
}
