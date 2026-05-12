import { PPV_METER_EVENT_NAME, PPV_PRICE_LOOKUP_KEY } from "./ppvConstants.js";
import {
  DELIVERY_PRODUCT_ID,
  LOOKUP_DELIVERY_MONTHLY_EUR,
  LOOKUP_DELIVERY_YEARLY_EUR,
  LOOKUP_STREAMING_FREE_EUR,
  LOOKUP_STREAMING_STUB_EUR,
} from "./subscriptionCaseCatalog.js";
import {
  findOrCreateCoupon,
  findOrCreateMeterByEventName,
  findOrCreateMeteredPriceByLookupKey,
  findOrCreatePriceByLookupKey,
  findOrCreateProductById,
} from "./stripeIdempotent.js";
import { stripe } from "./stripe.js";

const PRODUCT_ID = "prod_awesome";
const PPV_PRODUCT_ID = "prod_awesome_ppv";
const PRICE_LOOKUP_KEY = "awesome_monthly_eur";

export type EnsureAwesomeCatalogOptions = {
  /** When true, print each provisioned object (for `npm run setup:awesome`). */
  verbose?: boolean;
};

/**
 * Idempotently creates the full TeeSwag / "Awesome" Stripe catalog: base product
 * and price, schedule coupons, PPV product, Billing meter, metered PPV price,
 * delivery products/prices, and subscription-case demo prices.
 * Safe to call from every subscription script so runs succeed without a prior setup.
 */
export async function ensureAwesomeCatalog(
  options: EnsureAwesomeCatalogOptions = {},
): Promise<void> {
  const { verbose = false } = options;
  const log = (line: string): void => {
    if (verbose) {
      console.log(line);
    }
  };

  const product = await findOrCreateProductById({
    id: PRODUCT_ID,
    name: "Awesome Stream",
  });
  if (product.name !== "Awesome Stream") {
    await stripe.products.update(product.id, { name: "Awesome Stream" });
  }
  log(`Product: ${product.id} (Awesome Stream)`);

  const price = await findOrCreatePriceByLookupKey({
    lookupKey: PRICE_LOOKUP_KEY,
    product: product.id,
    unitAmount: 2000,
    currency: "eur",
    interval: "month",
  });
  log(
    `Price:   ${price.id} (${price.currency} ${price.unit_amount ?? "?"}/month, lookup_key=${price.lookup_key ?? "?"})`,
  );

  const stubPrice = await findOrCreatePriceByLookupKey({
    lookupKey: LOOKUP_STREAMING_STUB_EUR,
    product: product.id,
    unitAmount: 200,
    currency: "eur",
    interval: "month",
  });
  log(
    `Price:   ${stubPrice.id} (${stubPrice.currency} ${stubPrice.unit_amount ?? "?"}/month stub, lookup_key=${stubPrice.lookup_key ?? "?"})`,
  );

  const freeStubPrice = await findOrCreatePriceByLookupKey({
    lookupKey: LOOKUP_STREAMING_FREE_EUR,
    product: product.id,
    unitAmount: 0,
    currency: "eur",
    interval: "month",
  });
  log(
    `Price:   ${freeStubPrice.id} (${freeStubPrice.currency} ${freeStubPrice.unit_amount ?? "?"}/month free-stub, lookup_key=${freeStubPrice.lookup_key ?? "?"})`,
  );

  const coupon90 = await findOrCreateCoupon({
    id: "awesome-90-off-3m",
    name: "Awesome 90%",
    percent_off: 90,
    duration: "repeating",
    duration_in_months: 3,
    applies_to: { products: [product.id] },
    currency: "eur",
  });
  log(`Coupon:  ${coupon90.id} (${coupon90.percent_off}% off, 3 months)`);

  const coupon50 = await findOrCreateCoupon({
    id: "awesome-50-off-6m",
    name: "Awesome 50%",
    percent_off: 50,
    duration: "repeating",
    duration_in_months: 6,
    applies_to: { products: [product.id] },
    currency: "eur",
  });
  log(`Coupon:  ${coupon50.id} (${coupon50.percent_off}% off, 6 months)`);

  const coupon100 = await findOrCreateCoupon({
    id: "awesome-100-off-3m",
    name: "Awesome 100%",
    percent_off: 100,
    duration: "repeating",
    duration_in_months: 3,
    applies_to: { products: [product.id] },
    currency: "eur",
  });
  log(`Coupon:  ${coupon100.id} (${coupon100.percent_off}% off, 3 months)`);

  const coupon70 = await findOrCreateCoupon({
    id: "awesome-70-off-6m",
    name: "Awesome 70%",
    percent_off: 70,
    duration: "repeating",
    duration_in_months: 6,
    applies_to: { products: [product.id] },
    currency: "eur",
  });
  log(`Coupon:  ${coupon70.id} (${coupon70.percent_off}% off, 6 months)`);

  const ppvProduct = await findOrCreateProductById({
    id: PPV_PRODUCT_ID,
    name: "Awesome PPV",
  });
  log(`Product: ${ppvProduct.id} (${ppvProduct.name})`);

  const meter = await findOrCreateMeterByEventName({
    eventName: PPV_METER_EVENT_NAME,
    displayName: "Awesome PPV views",
  });
  log(`Meter:   ${meter.id} (event_name=${meter.event_name})`);

  const ppvPrice = await findOrCreateMeteredPriceByLookupKey({
    lookupKey: PPV_PRICE_LOOKUP_KEY,
    product: ppvProduct.id,
    unitAmount: 300,
    currency: "eur",
    interval: "month",
    meter: meter.id,
  });
  log(
    `Price:   ${ppvPrice.id} (${ppvPrice.currency} ${ppvPrice.unit_amount ?? "?"}/view/month metered, lookup_key=${ppvPrice.lookup_key ?? "?"})`,
  );

  const deliveryProduct = await findOrCreateProductById({
    id: DELIVERY_PRODUCT_ID,
    name: "Awesome Delivery",
  });
  log(`Product: ${deliveryProduct.id} (${deliveryProduct.name})`);

  const deliveryMonthly = await findOrCreatePriceByLookupKey({
    lookupKey: LOOKUP_DELIVERY_MONTHLY_EUR,
    product: deliveryProduct.id,
    unitAmount: 1000,
    currency: "eur",
    interval: "month",
  });
  log(
    `Price:   ${deliveryMonthly.id} (${deliveryMonthly.currency} ${deliveryMonthly.unit_amount ?? "?"}/month delivery, lookup_key=${deliveryMonthly.lookup_key ?? "?"})`,
  );

  const deliveryYearly = await findOrCreatePriceByLookupKey({
    lookupKey: LOOKUP_DELIVERY_YEARLY_EUR,
    product: deliveryProduct.id,
    unitAmount: 10000,
    currency: "eur",
    interval: "year",
  });
  log(
    `Price:   ${deliveryYearly.id} (${deliveryYearly.currency} ${deliveryYearly.unit_amount ?? "?"}/year delivery, lookup_key=${deliveryYearly.lookup_key ?? "?"})`,
  );

  if (verbose) {
    console.log("Done. Re-run is safe: existing objects are reused.");
  }
}
