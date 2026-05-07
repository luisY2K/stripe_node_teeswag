import {
  findOrCreateCoupon,
  findOrCreatePriceByLookupKey,
  findOrCreateProductById,
} from "../lib/stripeIdempotent.js";

const PRODUCT_ID = "prod_awesome";
const PRICE_LOOKUP_KEY = "awesome_monthly_eur";

async function main(): Promise<void> {
  const product = await findOrCreateProductById({
    id: PRODUCT_ID,
    name: "Awesome",
  });
  console.log(`Product: ${product.id} (${product.name})`);

  const price = await findOrCreatePriceByLookupKey({
    lookupKey: PRICE_LOOKUP_KEY,
    product: product.id,
    unitAmount: 2000,
    currency: "eur",
    interval: "month",
  });
  console.log(
    `Price:   ${price.id} (${price.currency} ${price.unit_amount ?? "?"}/month, lookup_key=${price.lookup_key ?? "?"})`,
  );

  const coupon90 = await findOrCreateCoupon({
    id: "awesome-90-off-3m",
    name: "Awesome 90% off (3 months)",
    percent_off: 90,
    duration: "repeating",
    duration_in_months: 3,
    applies_to: { products: [product.id] },
    currency: "eur",
  });
  console.log(`Coupon:  ${coupon90.id} (${coupon90.percent_off}% off, 3 months)`);

  const coupon50 = await findOrCreateCoupon({
    id: "awesome-50-off-3m",
    name: "Awesome 50% off (3 months)",
    percent_off: 50,
    duration: "repeating",
    duration_in_months: 3,
    applies_to: { products: [product.id] },
    currency: "eur",
  });
  console.log(`Coupon:  ${coupon50.id} (${coupon50.percent_off}% off, 3 months)`);

  console.log("Done. Re-run is safe: existing objects are reused.");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
