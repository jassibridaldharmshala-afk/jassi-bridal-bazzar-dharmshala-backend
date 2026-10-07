function money(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function scheduledSaleActive(product = {}, now = new Date()) {
  const salePrice = Number(product.salePrice || 0);
  const regularPrice = Number(product.price || 0);
  if (!(salePrice > 0) || !(regularPrice > 0) || salePrice >= regularPrice) return false;
  const instant = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(instant.getTime())) return false;
  const startsAt = product.saleStartAt ? new Date(product.saleStartAt) : null;
  const endsAt = product.saleEndAt ? new Date(product.saleEndAt) : null;
  if (!startsAt || Number.isNaN(startsAt.getTime()) || instant < startsAt) return false;
  if (endsAt && !Number.isNaN(endsAt.getTime()) && instant >= endsAt) return false;
  return true;
}

function productAvailableForSale(product = {}, now = new Date()) {
  if (!product || product.isActive === false || product.isArchived) return false;
  if (!product.publishAt) return true;
  const publishAt = new Date(product.publishAt);
  return !Number.isNaN(publishAt.getTime()) && publishAt <= now;
}

function regularUnitPrice(product = {}, variant) {
  const variantPrice = Number(variant?.price || 0);
  return variantPrice > 0 ? variantPrice : Number(product.price || 0);
}

function effectiveUnitPrice(product = {}, variant, now = new Date()) {
  const regular = regularUnitPrice(product, variant);
  if (!scheduledSaleActive(product, now)) return money(regular);
  const productRegular = Number(product.price || 0);
  const ratio = productRegular > 0 ? Number(product.salePrice) / productRegular : 1;
  return money(Math.max(0.01, regular * ratio));
}

function applyEffectivePricing(product = {}, now = new Date()) {
  const data = typeof product.toObject === 'function' ? product.toObject() : { ...product };
  const active = scheduledSaleActive(data, now);
  data.basePrice = Number(data.price || 0);
  data.saleActive = active;
  data.effectivePrice = effectiveUnitPrice(data, null, now);
  if (active) {
    const pricingSource = { ...data, price: data.basePrice };
    data.price = data.effectivePrice;
    data.discountPercentage = Number(data.originalPrice || 0) > data.price
      ? Math.round(((Number(data.originalPrice) - data.price) / Number(data.originalPrice)) * 100)
      : 0;
    if (Array.isArray(data.variants)) {
      data.variants = data.variants.map((variant) => ({
        ...(typeof variant.toObject === 'function' ? variant.toObject() : variant),
        basePrice: regularUnitPrice(pricingSource, variant),
        price: effectiveUnitPrice(pricingSource, variant, now),
      }));
    }
  }
  return data;
}

module.exports = { applyEffectivePricing, effectiveUnitPrice, productAvailableForSale, regularUnitPrice, scheduledSaleActive };
