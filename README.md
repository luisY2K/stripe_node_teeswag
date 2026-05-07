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
| `npm run setup:subscription` | New faker customer + subscription schedule (90% → 50% → release) |
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
