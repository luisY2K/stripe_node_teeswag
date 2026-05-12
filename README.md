# teeswag-alt

Node v24 + TypeScript scripts for prototyping Stripe subscription flows with **test clocks**, ESLint, Prettier, and Vitest.

## Demo scope (for presenters and assisting agents)

For the **live demo**, use **only** these `npm run` scripts (see [`package.json`](package.json) lines 10–15):

- `npm run setup:awesome` — idempotent catalog bootstrap (prerequisite; not a numbered “case”).
- `npm run create:subscription` — phased schedule (90%×3 → 50%×3 → release).
- `npm run create:subscription:trial` — trial + phased discounts.
- `npm run create:subscription:retention` — self-contained retention walkthrough (create → advance clock → swap coupon).
- `npm run create:subscription:ppv` — phased base + metered PPV (default scenario).
- `npm run create:subscription:add-streaming-to-delivery` — add streaming to an existing delivery subscription (delivery + streaming on one subscription).

**Ignore for the demo presentation:** any other `create:subscription:*` commands (e.g. bundle, flexible, aligned two-sub flows), `npm run apply:retention` (superseded for the demo by `create:subscription:retention`), and dev tooling (`dev`, `script`, `typecheck`, `lint*`, `format*`, `test*`). Those remain in the repo for engineering reference only.

Use cases mapped to the partner brief and this repo: [docs/use-cases.md](docs/use-cases.md).

The scaffold ships an end-to-end flow:

1. **Setup** the **Awesome Stream** product (`prod_awesome`, monthly EUR price), discount/retention coupons, **PPV** catalog (separate product, Billing meter, metered price), and **Awesome Delivery** (monthly/yearly prices) via `npm run setup:awesome` (idempotent). The subscription scripts also **auto-provision** the same catalog on startup if needed.
2. **Create** a subscription via a phased schedule (with optional trial), under a fresh test clock and faker-generated customer.
3. **Advance** the clock by N months to simulate billing cycles (or use `create:subscription:retention` for a fixed 4-month advance + coupon swap).
4. **Apply retention** to swap the current phase coupon to a richer offer (`create:subscription:retention` for the demo; `apply:retention` for ad-hoc subs).
5. Every subscription-touching script prints a **Stripe Dashboard URL** for quick navigation.

## Setup

```bash
nvm use                # or ensure Node >= 24
cp .env.example .env   # then add STRIPE_SECRET_KEY=sk_test_...
npm install
```

`.env` must contain a **test mode** secret key:

```env
STRIPE_SECRET_KEY=sk_test_...
```

> The Dashboard URL helper inspects `STRIPE_SECRET_KEY` at print time. Keys starting with `sk_test_` produce `https://dashboard.stripe.com/test/...`; anything else produces live URLs. Default is test mode if the env is missing.

## Scripts

| Command                                                      | Description                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run setup:awesome`                                      | *(In demo scope.)* Idempotent: Awesome Stream + delivery prices, discount coupons, PPV product + meter + **EUR 3 per view** metered price (see [`ensureAwesomeCatalog`](src/lib/ensureAwesomeCatalog.ts), [`setupAwesome.ts`](src/scripts/setupAwesome.ts))                                                                                                                                                                                                                            |
| `npm run create:subscription:add-streaming-to-delivery`      | *(In demo scope.)* **Add streaming to delivery:** monthly Awesome Delivery (~2 months default); add streaming and keep one canonical inline schedule flow. Default ladder: stub price (~10% list) → **90%×3 → 50%×3** → 1-month list tail. `free-trial`: €0 stub → **trial 1 month** → **90%×2 → 50%×3** → 1-month list tail. Positioning: `stub short` (~7d, default) / `stub long` (~18d). Tenure: separate argv tokens `m N` after `--` (not `mN`). |
| `npm run create:subscription:align-delivery-cycle-to-stream` | **Case 7** *(out of demo scope)*: convert yearly delivery to monthly on add-stream (`create_prorations` credit), then run aligned phased ladder. Optional `-- free-trial`; override age with `-- m N`.                                                                                                                                                                                                                                 |
| `npm run create:subscription:bundle-two-lines`               | **Case 4** *(out of demo scope)*: migrate delivery-only → one sub (delivery + stream) + schedule (90%→50% on streaming line). Monthly delivery ~2 months default; `-- m N`.                                                                                                                                                                                                                                                            |
| `npm run create:subscription:flexible-mixed-interval`        | **Case 5** *(out of demo scope)*: cancel yearly delivery with credit → new flexible sub (yearly delivery + monthly stream, 90% on streaming item). ~2 months default; `-- m N`.                                                                                                                                                                                                                                                        |
| `npm run create:subscription:aligned-delivery-streaming`     | **Case 1** *(out of demo scope)*: monthly delivery ~2 months, then Awesome Stream schedule; clock advances +2 months after both subs exist. Two subs, two invoice streams. `-- m N`.                                                                                                                                                                                                                                                   |
| `npm run create:subscription`                                | *(In demo scope.)* Ensures catalog, then test clock + customer + schedule (90% → 50% → release). Optional `month N` / `m N` advances the clock by ~N×30d (chunked, 2 months/step). See [`createSubscription.ts`](src/scripts/createSubscription.ts).                                                                                                                                                                                   |
| `npm run create:subscription:trial`                          | *(In demo scope.)* Same as `create:subscription` but starts with a 1-month trial (trial → 90% → 50% → release). See [`createSubscriptionWithTrial.ts`](src/scripts/createSubscriptionWithTrial.ts).                                                                                                                                                                                                                                                                                                                      |
| `npm run create:subscription:retention`                      | *(In demo scope.)* Self-contained retention demo: ensures catalog, creates phased schedule (90%×3 → 50%×3), advances the test clock **4 months** (lands in the 50% phase), then swaps the **current** phase coupon to **70%** via [`applyAwesomeRetention`](src/lib/applyRetention.ts). Prints dashboard URL + customer ad-hoc promotion count. See [`createSubscriptionWithRetention.ts`](src/scripts/createSubscriptionWithRetention.ts). |
| `npm run create:subscription:ppv`                            | *(In demo scope.)* **Default (no args):** phased schedule **90%×3 → 50%×3**, then after ~**37 days** adds metered PPV mid–phase 1, rewrites schedule phases so PPV survives phase 2, emits **5** view events (**2** days apart). **Legacy:** pass `views K` / `v K` and `month N` / `m N` for the older two-item-from-t0 flow. See [`createSubscriptionWithPpv.ts`](src/scripts/createSubscriptionWithPpv.ts).                                                                                                                                                                                                                                                                                                                  |
| `npm run apply:retention -- sub_...`                         | **Out of demo scope** — use `create:subscription:retention` for the live demo. Ensures catalog, then swaps the current schedule phase coupon (90%→100%, 50%→70%) on the active subscription. See [`applyRetention.ts`](src/scripts/applyRetention.ts) (script).                                                                                                                                                                                                                                                                                                     |
| `npm run dev`                                                | Run `src/scripts/example.ts` with `.env` loaded                                                                                                                                                                                                                                                                                                                                                                  |
| `npm run script -- src/scripts/foo.ts`                       | Run any script with `.env` loaded                                                                                                                                                                                                                                                                                                                                                                                |
| `npm run typecheck`                                          | TypeScript check (`tsc --noEmit`)                                                                                                                                                                                                                                                                                                                                                                                |
| `npm run lint` / `npm run lint:fix`                          | ESLint                                                                                                                                                                                                                                                                                                                                                                                                           |
| `npm run format` / `npm run format:check`                    | Prettier                                                                                                                                                                                                                                                                                                                                                                                                         |
| `npm test`                                                   | Unit tests only                                                                                                                                                                                                                                                                                                                                                                                                  |
| `npm run test:integration`                                   | Stripe integration tests (requires `.env`)                                                                                                                                                                                                                                                                                                                                                                       |
| `npm run test:watch`                                         | Vitest watch                                                                                                                                                                                                                                                                                                                                                                                                     |

### Examples

```bash
npm run setup:awesome

npm run create:subscription           # no advance
npm run create:subscription month 4   # advance ~4 months
npm run create:subscription m 6       # short alias

npm run create:subscription:trial m 2

npm run create:subscription:retention

npm run create:subscription:ppv              # default phased + mid-cycle PPV scenario
npm run create:subscription:ppv views 5 month 1   # legacy CLI mode

npm run create:subscription:add-streaming-to-delivery -- m 12

# Out of live demo scope (engineering reference):
# npm run create:subscription:bundle-two-lines -- m 3
# npm run apply:retention -- sub_1ABC...
```

Each subscription script prints the dashboard link, e.g.:

```
Test clock:    clock_1...
Customer:      cus_1... (Jane Doe, jane@example.com)
Schedule:      sub_sched_1...
Subscription:  sub_1...
Dashboard:     https://dashboard.stripe.com/test/subscriptions/sub_1...
Advanced:      4 month(s) (~120d on clock)
```

## Project layout

```
src/
  lib/
    stripe.ts               # Stripe client (uses STRIPE_SECRET_KEY)
    stripeApiVersion.ts     # Pinned API version
    stripeIdempotent.ts     # Idempotent product/price/coupon/meter helpers
    ensureAwesomeCatalog.ts # Full catalog provisioning (shared with setup + scripts)
    subscriptionCaseCatalog.ts # Lookup keys + product ids for subscription-case demos
    clockedCustomer.ts      # Test clock + customer + default PM (subscription-case scripts)
    deriveAnchorConfig.ts   # Unix timestamp → billing_cycle_anchor_config fields
    ppvConstants.ts         # PPV meter event name + metered price lookup key
    recordPpvViews.ts       # Billing Meter Events for pay-per-view
    createBaseWithPpvSubscription.ts  # Base + metered PPV on one subscription
    awesomeSchedule.ts      # Build phased subscription schedules (streaming)
    createCombinedDeliveryStreamingSchedule.ts # Case 4: delivery + stream items, coupons on stream only
    createExistingDeliveryCustomer.ts # Test clock + customer + delivery sub + optional clock advance
    applyRetention.ts       # Swap current phase coupon for retention coupon
    testClock.ts            # createTestClock / advanceTestClock / waitTestClockReady
    fakeCustomer.ts         # Faker-generated customer details
    parseMonthArg.ts        # Parses `month N` / `m N` CLI args
    parseViewsArg.ts        # Parses `views K` / `v K` CLI args
    dashboardUrl.ts         # dashboardSubscriptionUrl(id)
    getPriceByLookupKey.ts
    env.ts
  scripts/
    setupAwesome.ts
    createSubscription.ts
    createSubscriptionWithTrial.ts
    createSubscriptionWithRetention.ts
    createSubscriptionWithPpv.ts
    addStreamingToDeliverySubscription.ts
    createBundleTwoLineSubscription.ts
    createFlexibleMixedIntervalSubscription.ts
    createAlignedDeliveryAndStreamingPair.ts
    applyRetention.ts
    example.ts              # `npm run dev` entry
tests/
  integration/              # Stripe-backed tests (test clocks)
```

## Stripe test clocks

Helpers live in [`src/lib/testClock.ts`](src/lib/testClock.ts). Stripe rejects single advances that span more than two billing intervals while monthly subscriptions exist, so the create scripts advance in **2-month chunks**, awaiting `frozen_time` readiness between steps via `waitTestClockReady`.

Integration tests under `tests/integration/` create a test clock, attach a customer, optionally advance time, then clean up.

## Notes

- **Test mode keys only.** Never commit `.env`.
- The `pm_card_visa` test PaymentMethod is attached to created customers; the **attached PM id** (not the alias) is set as the customer's default for invoices.
- **`create:subscription`**, **`create:subscription:trial`**, **`create:subscription:retention`**, **`create:subscription:ppv`**, and **`apply:retention`** call [`ensureAwesomeCatalog`](src/lib/ensureAwesomeCatalog.ts) first—the same idempotent objects as [`npm run setup:awesome`](src/scripts/setupAwesome.ts). Running setup separately is optional but useful to inspect created IDs.
- Retention coupons (`awesome-100-off-3m`, `awesome-70-off-3m`) use the same **`findOrCreateCoupon`** helpers as setup; [`applyRetention`](src/lib/applyRetention.ts) also ensures them when needed (idempotent).
