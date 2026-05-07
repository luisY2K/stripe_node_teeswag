import { describe, expect, it } from "vitest";
import { STRIPE_API_VERSION } from "../../src/lib/stripeApiVersion.js";

describe("Stripe scaffold", () => {
  it("pins API version constant", () => {
    expect(STRIPE_API_VERSION).toBe("2026-04-22.dahlia");
  });
});
