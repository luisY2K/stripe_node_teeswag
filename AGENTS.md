# AGENTS.md

## Cursor Cloud specific instructions

### Overview

**teeswag-alt** is a Node.js + TypeScript CLI toolkit for prototyping Stripe subscription billing flows. There is no web server, database, or frontend — all scripts interact with the Stripe API in test mode.

### Prerequisites

- **Node.js >= 24** (pinned in `.nvmrc`; use `nvm use` to activate)
- **`STRIPE_SECRET_KEY`** environment variable set to a Stripe test-mode key (`sk_test_...`). Must be in `.env` at the repo root (see `.env.example`).

### Key commands

All standard commands are in `package.json` scripts; refer to the README for the full table. Quick reference:

| Task               | Command                                                |
| ------------------ | ------------------------------------------------------ |
| Lint               | `npm run lint`                                         |
| Format check       | `npm run format:check`                                 |
| Typecheck          | `npm run typecheck`                                    |
| Unit tests         | `npm test`                                             |
| Integration tests  | `npm run test:integration` (needs `STRIPE_SECRET_KEY`) |
| Run example script | `npm run dev` (needs `STRIPE_SECRET_KEY`)              |

### Gotchas

- The `.env` file is required for any script or integration test that calls the Stripe API. Without a valid `STRIPE_SECRET_KEY`, those scripts will throw `Missing required environment variable: STRIPE_SECRET_KEY`.
- Unit tests (`npm test`) do **not** need a Stripe key and run offline.
- Integration tests have 180-second timeouts because they create and advance Stripe test clocks.
- Vitest shows a deprecation warning about the workspace file format — this is cosmetic and does not affect test execution.
- The `tsx` runner is used for all scripts (via `--env-file=.env`), so `.env` loading happens automatically.
