import { randomUUID } from "node:crypto";
import { PPV_METER_EVENT_NAME } from "./ppvConstants.js";
import { stripe } from "./stripe.js";

/**
 * Records Billing Meter events (one event per view). Payload keys match the meter:
 * `stripe_customer_id` + `value` (sum aggregation).
 */
export async function recordPpvViews(params: {
  customerId: string;
  views: number;
  timestampSec?: number;
}): Promise<void> {
  const ts = params.timestampSec;
  let remaining = params.views;
  while (remaining > 0) {
    remaining -= 1;
    await stripe.billing.meterEvents.create({
      event_name: PPV_METER_EVENT_NAME,
      payload: {
        stripe_customer_id: params.customerId,
        value: "1",
      },
      identifier: randomUUID(),
      ...(ts !== undefined ? { timestamp: ts } : {}),
    });
  }
}
