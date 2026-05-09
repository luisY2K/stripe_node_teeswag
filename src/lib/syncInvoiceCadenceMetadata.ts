import { stripe } from "./stripe.js";
import { TEESWAG_KEYS } from "./teeswagSubscriptionMetadata.js";

function readCadenceFromSubscriptionMetadata(
  metadata: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  const delivery = metadata[TEESWAG_KEYS.DELIVERY_CADENCE];
  const stream = metadata[TEESWAG_KEYS.STREAM_CADENCE];
  if (delivery === "month" || delivery === "year") {
    out[TEESWAG_KEYS.DELIVERY_CADENCE] = delivery;
  }
  if (stream === "month" || stream === "year") {
    out[TEESWAG_KEYS.STREAM_CADENCE] = stream;
  }
  return out;
}

export async function syncInvoiceCadenceMetadataForSubscription(params: {
  subscriptionId: string;
  createdGte: number;
}): Promise<number> {
  const subscription = await stripe.subscriptions.retrieve(params.subscriptionId);
  const cadenceMeta = readCadenceFromSubscriptionMetadata(subscription.metadata);
  if (Object.keys(cadenceMeta).length === 0) {
    return 0;
  }

  const invoices = await stripe.invoices.list({
    subscription: params.subscriptionId,
    created: { gte: params.createdGte },
    limit: 100,
  });

  let updated = 0;
  for (const invoice of invoices.data) {
    const nextMeta: Record<string, string> = { ...(invoice.metadata ?? {}) };
    let changed = false;
    for (const [key, value] of Object.entries(cadenceMeta)) {
      if (nextMeta[key] !== value) {
        nextMeta[key] = value;
        changed = true;
      }
    }
    if (!changed) {
      continue;
    }
    await stripe.invoices.update(invoice.id, { metadata: nextMeta });
    updated += 1;
  }

  return updated;
}
