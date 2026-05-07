function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/** Validated Stripe-related env. Access throws if unset. */
export const env = {
  get STRIPE_SECRET_KEY(): string {
    return readRequiredEnv("STRIPE_SECRET_KEY");
  },
} as const;
