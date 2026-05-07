import type Stripe from "stripe";
import { stripe } from "./stripe.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function createTestClock(params: {
  frozenTime: number;
  name?: string;
}): Promise<Stripe.Response<Stripe.TestHelpers.TestClock>> {
  return stripe.testHelpers.testClocks.create({
    frozen_time: params.frozenTime,
    name: params.name,
  });
}

export async function advanceTestClock(
  testClockId: string,
  frozenTime: number,
): Promise<Stripe.Response<Stripe.TestHelpers.TestClock>> {
  return stripe.testHelpers.testClocks.advance(testClockId, {
    frozen_time: frozenTime,
  });
}

export async function retrieveTestClock(
  testClockId: string,
): Promise<Stripe.Response<Stripe.TestHelpers.TestClock>> {
  return stripe.testHelpers.testClocks.retrieve(testClockId);
}

/**
 * Poll until the test clock finishes advancing and is `ready`, or timeout.
 */
export async function waitTestClockReady(
  testClockId: string,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<Stripe.Response<Stripe.TestHelpers.TestClock>> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollMs = options.pollMs ?? 500;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const clock = await retrieveTestClock(testClockId);
    if (clock.status === "ready") {
      return clock;
    }
    if (clock.status === "internal_failure") {
      throw new Error(`Test clock ${testClockId} failed with status internal_failure`);
    }
    await sleep(pollMs);
  }

  throw new Error(
    `Test clock ${testClockId} not ready within ${timeoutMs}ms (last status unknown)`,
  );
}

export async function deleteTestClock(
  testClockId: string,
): Promise<Stripe.Response<{ id: string; deleted: boolean; object: string }>> {
  return stripe.testHelpers.testClocks.del(testClockId);
}
