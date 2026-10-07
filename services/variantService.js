const mongoose = require('mongoose');
const { ApiError } = require('../utils/apiError');
const { getPrimaryImageUrl } = require('../utils/imageUtils');
const { effectiveUnitPrice } = require('./productPricingService');

function activeVariants(product = {}) {
  return (Array.isArray(product.variants) ? product.variants : []).filter((variant) => variant && variant.isActive !== false);
}

function hasManagedVariants(product = {}) {
  return activeVariants(product).length > 0;
}

function variantKey(size = '', color = '') {
  return `${String(size || '').trim().toLowerCase()}::${String(color || '').trim().toLowerCase()}`;
}

function normalizeOptionValues(value, size = '', color = '') {
  const source = value instanceof Map ? Object.fromEntries(value) : (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
  const entries = Object.entries(source).slice(0, 6).map(([key, option]) => [
    String(key || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 40),
    String(option ?? '').trim().slice(0, 100),
  ]).filter(([key, option]) => key && option);
  const result = Object.fromEntries(entries);
  if (size && !result.size) result.size = size;
  if (color && !result.colour && !result.color) result.colour = color;
  return result;
}

function variantId(variant) {
  return variant?._id ? String(variant._id) : '';
}

function findVariant(product, { variantId: id, size, color } = {}) {
  const variants = activeVariants(product);
  if (!variants.length) return null;

  if (id && mongoose.Types.ObjectId.isValid(id)) {
    const match = variants.find((variant) => String(variant._id) === String(id));
    if (match) return match;
  }

  if (size || color) {
    const exact = variants.find((variant) => variantKey(variant.size, variant.color) === variantKey(size, color));
    if (exact) return exact;
  }

  return null;
}

function requireVariant(product, selection = {}) {
  if (!hasManagedVariants(product)) return null;
  const variant = findVariant(product, selection);
  if (!variant) {
    throw new ApiError('VARIANT_UNAVAILABLE', 'Please choose an available product option');
  }
  return variant;
}

function variantUnitPrice(product, variant) {
  return effectiveUnitPrice(product, variant);
}

function variantUnitMrp(product, variant) {
  const mrp = Number(variant?.originalPrice || 0);
  if (mrp > 0) return mrp;
  return Number(product.originalPrice || variantUnitPrice(product, variant) || 0);
}

function variantImage(product, variant) {
  return getPrimaryImageUrl(variant?.images) || getPrimaryImageUrl(product.images);
}

function variantSku(product, variant) {
  return variant?.sku || product.sku || '';
}

function totalVariantStock(product = {}) {
  return activeVariants(product).reduce((sum, variant) => sum + Math.max(0, Number(variant.stock || 0)), 0);
}

function availableStock(product = {}, selection = {}) {
  if (!hasManagedVariants(product)) {
    return Math.max(0, Number(product.stock || 0));
  }
  const variant = findVariant(product, selection);
  if (!variant) return 0;
  return Math.max(0, Number(variant.stock || 0));
}

function normalizeVariantInput(raw = {}, product = {}) {
  const size = String(raw.size || '').trim();
  const color = String(raw.color || '').trim();
  const stock = Math.max(0, Number(raw.stock || 0));
  const price = Number(raw.price || 0);
  const originalPrice = Number(raw.originalPrice || 0);
  const optionValues = normalizeOptionValues(raw.optionValues, size, color);
  return {
    ...(raw._id && mongoose.Types.ObjectId.isValid(raw._id) ? { _id: raw._id } : {}),
    sku: String(raw.sku || '').trim() || undefined,
    size,
    color,
    optionValues,
    stock,
    price: price > 0 ? price : undefined,
    originalPrice: originalPrice > 0 ? originalPrice : undefined,
    images: Array.isArray(raw.images) ? raw.images : [],
    isActive: raw.isActive !== false,
  };
}

function normalizeVariantsPayload(variants, product = {}) {
  if (!Array.isArray(variants)) return undefined;
  return variants
    .map((variant) => normalizeVariantInput(variant, product))
    .filter((variant) => variant.size || variant.color || Object.keys(variant.optionValues || {}).length);
}

function validateVariantPayload(variants) {
  if (variants === undefined) return '';
  if (!Array.isArray(variants)) return 'Product variants must be a list';
  if (variants.length > 200) return 'A product can have up to 200 variants';
  const combinations = new Set();
  const skus = new Set();
  for (const variant of variants) {
    if (!variant || typeof variant !== 'object' || Array.isArray(variant)) return 'Every product variant must be valid';
    const stock = Number(variant.stock || 0);
    if (!Number.isSafeInteger(stock) || stock < 0) return 'Every variant stock value must be a whole number of zero or more';
    const price = optionalPositiveNumber(variant.price);
    const originalPrice = optionalPositiveNumber(variant.originalPrice);
    if (price === false) return 'Variant selling prices must be greater than zero when entered';
    if (originalPrice === false) return 'Variant MRP values must be greater than zero when entered';
    if (price !== null && originalPrice !== null && price > originalPrice) return 'A variant selling price cannot exceed its MRP';
    const optionValues = variant.optionValues instanceof Map ? Object.fromEntries(variant.optionValues) : { ...(variant.optionValues || {}) };
    if (variant.size && !optionValues.size) optionValues.size = variant.size;
    if (variant.color && !optionValues.color && !optionValues.colour) optionValues.color = variant.color;
    const combination = Object.entries(optionValues)
      .map(([key, value]) => [String(key).trim().toLowerCase(), String(value || '').trim().toLowerCase()])
      .filter(([, value]) => value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}:${value}`).join('|');
    if (!combination) return 'Every variant needs at least one option value';
    if (combinations.has(combination)) return 'Variant option combinations must be unique';
    combinations.add(combination);
    const sku = String(variant.sku || '').trim().toLowerCase();
    if (sku && skus.has(sku)) return 'Variant SKUs must be unique within the product';
    if (sku) skus.add(sku);
  }
  return '';
}

function optionalPositiveNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : false;
}

module.exports = {
  activeVariants,
  availableStock,
  findVariant,
  hasManagedVariants,
  normalizeVariantsPayload,
  validateVariantPayload,
  requireVariant,
  totalVariantStock,
  variantId,
  variantImage,
  variantKey,
  variantSku,
  variantUnitMrp,
  variantUnitPrice,
};
