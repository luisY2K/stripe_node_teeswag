export function dashboardSubscriptionUrl(subscriptionId: string): string {
  const isTest = process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_") ?? true;
  const prefix = isTest
    ? "https://dashboard.stripe.com/test"
    : "https://dashboard.stripe.com";
  return `${prefix}/subscriptions/${subscriptionId}`;
}
