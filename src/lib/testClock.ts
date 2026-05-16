import type Stripe from "stripe";
import { addMonthsUnix } from "./addMonthsUnix.js";
import { stripe } from "./stripe.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DAY = 86_400;

/**
 * Advance a test clock forward by N calendar months, chunked to at most 2
 * months per step. Each step uses `addMonthsUnix` (end-of-month clamped),
 * matching Stripe's billing-anchor semantics, so the step always lands on or
 * before Stripe's "two intervals from current frozen time" wall regardless of
 * 28/30/31-day months. Naive 30-day arithmetic overshoots that wall whenever a
 * 31-day month is in the window.
 */
export async function advanceTestClockByMonths(
  testClockId: string,
  months: number,
  options: { waitTimeoutMs?: number } = {},
): Promise<Stripe.Response<Stripe.TestHelpers.TestClock>> {
  const waitTimeoutMs = options.waitTimeoutMs ?? 180_000;
  if (months <= 0) {
    return retrieveTestClock(testClockId);
  }

  let currentFrozen = (await retrieveTestClock(testClockId)).frozen_time;
  let remainingMonths = months;
  let lastReady: Stripe.Response<Stripe.TestHelpers.TestClock> | undefined;
  while (remainingMonths > 0) {
    const stepMonths = Math.min(2, remainingMonths);
    const stepTarget = addMonthsUnix(currentFrozen, stepMonths);
    await advanceTestClock(testClockId, stepTarget);
    lastReady = await waitTestClockReady(testClockId, { timeoutMs: waitTimeoutMs });
    currentFrozen = lastReady.frozen_time;
    remainingMonths -= stepMonths;
  }
  return lastReady ?? retrieveTestClock(testClockId);
}

/**
 * Advance a test clock by N days (single step).
 */
export async function advanceTestClockByDays(
  testClockId: string,
  days: number,
  options: { waitTimeoutMs?: number } = {},
): Promise<Stripe.Response<Stripe.TestHelpers.TestClock>> {
  const waitTimeoutMs = options.waitTimeoutMs ?? 180_000;
  if (days <= 0) {
    return retrieveTestClock(testClockId);
  }
  const current = await retrieveTestClock(testClockId);
  const target = current.frozen_time + days * DAY;
  await advanceTestClock(testClockId, target);
  return waitTestClockReady(testClockId, { timeoutMs: waitTimeoutMs });
}

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
