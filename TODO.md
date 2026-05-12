# Metadata Correctness Fixes

Issues identified during the readability refactor (PR #2). These are separate from the inlining work and should be fixed independently.

## 1. Missing `lineItemMetadata()` on subscription schedule items

Schedule phases create items without `teeswag_line_type` metadata:

```ts
items: [{ price: price.id, quantity: 1 }]
```

Should be:

```ts
items: [{ price: price.id, quantity: 1, metadata: lineItemMetadata("streaming") }]
```

**Affected scripts:** `createSubscription.ts`, `createSubscriptionWithTrial.ts`, `createAlignedDeliveryAndStreamingPair.ts`

## 2. `applyRetention.ts` strips all phase metadata when rebuilding

When retention rebuilds the phases array for `subscriptionSchedules.update()`, the reconstructed phases have no `metadata` property. All `teeswag_*` phase metadata (`source`, `mix`, `phase_template`, `coupon_snapshot`, etc.) is lost after retention is applied.

## 3. `applyRetention.ts` only preserves first item per phase

The phase reconstruction does:

```ts
const firstItem = p.items[0];
items: [{ price: priceId, quantity: firstItem.quantity ?? 1 }]
```

Combined subscriptions with delivery + streaming items would lose the second item. It also applies discounts at the phase level rather than the item level (combined subscriptions put streaming-specific discounts on the streaming item only).

## 4. Hardcoded `phaseTemplate` in `createBundleTwoLineSubscription.ts`

`phaseTemplate` is hardcoded to `"combined_90_50"` regardless of whether a free-trial 100%-off coupon is included, making the template label inaccurate for the trial variant.
