# teeswag-alt

Node v24 + TypeScript scripts with Stripe (test clocks), ESLint, Prettier, and Vitest.

## Setup

```bash
nvm use   # or ensure Node >= 24
cp .env.example .env
# Add STRIPE_SECRET_KEY=sk_test_...
npm install
```

## Scripts

| Command | Description |
| --- | --- |
| `npm run setup:awesome` | Idempotent: Awesome product, 20 EUR/mo price, coupons |
| `npm run create:subscription` | Test clock + faker customer + schedule (90% → 50% → release); `month N` / `m N` advances clock ~N×30d |
| `npm run create:subscription:trial` | Same with trial first; `month` / `m` as above |
| `npm run apply:retention -- sub_...` | Swap current phase coupon (90%→100%, 50%→70%) on active schedule |
| `npm run dev` | Run `src/scripts/example.ts` with `.env` |
| `npm run script -- src/scripts/foo.ts` | Run any script with `.env` |
| `npm run typecheck` | TypeScript check |
| `npm run lint` / `npm run lint:fix` | ESLint |
| `npm run format` / `npm run format:check` | Prettier |
| `npm test` | Unit tests only |
| `npm run test:integration` | Stripe integration tests (requires `.env`) |
| `npm run test:watch` | Vitest watch |

## Stripe test clocks

Helpers live in [`src/lib/testClock.ts`](src/lib/testClock.ts). Integration tests under `tests/integration/` create a test clock, attach a customer, optionally advance time, then clean up.

Use **test mode** keys only. Never commit `.env`.
