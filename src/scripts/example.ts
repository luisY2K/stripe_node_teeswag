import { stripe } from "../lib/stripe.js";

async function main(): Promise<void> {
  const balance = await stripe.balance.retrieve();
  console.log(
    "Stripe connected. Available balance object keys:",
    Object.keys(balance),
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
