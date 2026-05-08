import type Stripe from "stripe";

/** Stripe metadata keys for TeeSwag reporting (subscription + subscription items). */
export const TEESWAG_KEYS = {
  APP: "teeswag_app",
  SOURCE: "teeswag_source",
  MIX: "teeswag_mix",
  COUPON_SNAPSHOT: "teeswag_coupon_snapshot",
  PHASE_TEMPLATE: "teeswag_phase_template",
  HAS_TRIAL: "teeswag_has_trial",
  LINE_TYPE: "teeswag_line_type",
} as const;

export type TeeswagMix =
  | "delivery_only"
  | "streaming_only"
  | "combined"
  | "base_plus_ppv";

export type TeeswagLineType = "delivery" | "streaming" | "ppv_metered";

/**
 * Subscription-level metadata on direct `subscriptions.create` / merged on `subscriptions.update`.
 */
export function directSubscriptionMetadata(params: {
  source: string;
  mix: TeeswagMix;
  phaseTemplate: string;
  hasTrial: boolean;
  couponSnapshot?: string;
}): Stripe.MetadataParam {
  const out: Record<string, string> = {
    [TEESWAG_KEYS.APP]: "teeswag_alt",
    [TEESWAG_KEYS.SOURCE]: params.source,
    [TEESWAG_KEYS.MIX]: params.mix,
    [TEESWAG_KEYS.PHASE_TEMPLATE]: params.phaseTemplate,
    [TEESWAG_KEYS.HAS_TRIAL]: params.hasTrial ? "true" : "false",
  };
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
  couponSnapshot?: string;
}): Stripe.MetadataParam {
  return directSubscriptionMetadata({
    source: params.source,
    mix: params.mix,
    phaseTemplate: params.phaseTemplate,
    hasTrial: params.hasTrialThisPhase,
    couponSnapshot: params.couponSnapshot,
  });
}

/** Metadata on a subscription item (delivery / streaming / PPV meter line). */
export function lineItemMetadata(lineType: TeeswagLineType): Stripe.MetadataParam {
  return { [TEESWAG_KEYS.LINE_TYPE]: lineType };
}

/** Optional metadata on the SubscriptionSchedule resource (debugging / joining to subscription). */
export function subscriptionScheduleObjectMetadata(
  source: string,
): Stripe.MetadataParam {
  return {
    [TEESWAG_KEYS.APP]: "teeswag_alt",
    [TEESWAG_KEYS.SOURCE]: source,
  };
}
