import Stripe from "stripe";
import { env } from "./env.js";
import { STRIPE_API_VERSION } from "./stripeApiVersion.js";

export { STRIPE_API_VERSION } from "./stripeApiVersion.js";

export const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
  apiVersion: STRIPE_API_VERSION,
  typescript: true,
});
