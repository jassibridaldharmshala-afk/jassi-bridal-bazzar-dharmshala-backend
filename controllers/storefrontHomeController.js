const mongoose = require('mongoose');
const Banner = require('../models/Banner');
const Category = require('../models/Category');
const Product = require('../models/Product');
const Settings = require('../models/Settings');
const WebsiteTheme = require('../models/WebsiteTheme');
const { asyncHandler } = require('../middleware/validate');
const { normalizeProductResponse } = require('./productController');
const { andFilter } = require('../services/storeService');

const SECTION_LIMIT = 12;
const CATEGORY_LIMIT = 100;
const BANNER_LIMIT = 100;
const HOME_QUERY_TIMEOUT_MS = 4000;
const HOME_SETTINGS_FIELDS = [
  'acceptingOrders', 'orderPauseMessage', 'shippingPricingMode', 'shippingFreeAboveEnabled',
  'freeShippingMinAmount', 'deliveryCharge', 'returnsEnabled', 'returnWindowDays', 'codEnabled',
  'razorpayEnabled', 'upiEnabled', 'cardPaymentEnabled', 'netBankingEnabled', 'walletEnabled', 'socialLinks',
  'occasionShoppingEnabled', 'recentlyViewedEnabled', 'completeLookEnabled',
].join(' ');
const HOME_PRODUCT_FIELDS = [
  '_id', 'slug', 'name', 'category', 'subCategory', 'price', 'originalPrice', 'discountPercentage',
  'salePrice', 'saleStartAt', 'saleEndAt', 'stock', 'lowStockAlert', 'sizes', 'colors', 'variants',
  'sizingMode', 'images', 'primaryImage', 'rating', 'numReviews', 'isFeatured', 'isNewArrival',
  'isBestSeller', 'showOnHomepage', 'showInTrending', 'tags', 'commerceMode', 'createdAt', 'updatedAt',
].join(' ');

function publicProductFilter(req, extra = {}) {
  return andFilter({
    $and: [
      { isActive: true, isArchived: { $ne: true } },
      { $or: [{ publishAt: { $exists: false } }, { publishAt: null }, { publishAt: { $lte: new Date() } }] },
      extra,
    ],
  }, req.tenantFilter);
}

function configuredIds(req, activeTheme) {
  const globalConfig = activeTheme?.publishedConfig || {};
  const storeConfig = req.store?.storefrontDesign?.publishedConfig || {};
  const globalSections = globalConfig.homepage?.sectionProductIds || {};
  const storeSections = storeConfig.homepage?.sectionProductIds || {};
  const sectionIds = {};
  const keys = new Set([...Object.keys(globalSections), ...Object.keys(storeSections)]);
  for (const key of keys) {
    const source = Array.isArray(storeSections[key]) ? storeSections[key] : globalSections[key];
    sectionIds[key] = cleanObjectIds(source, SECTION_LIMIT);
  }
  const globalBlocks = globalConfig.homepage?.blocks || [];
  const storeBlocks = storeConfig.homepage?.blocks || [];
  const blocks = Array.isArray(storeBlocks) && storeBlocks.length ? storeBlocks : globalBlocks;
  const blockProductIds = cleanObjectIds(blocks.flatMap((block) => block?.productIds || []), 60);
  const categoryIds = cleanObjectIds([
    ...(globalConfig.homepage?.featuredCategoryIds || []),
    ...(storeConfig.homepage?.featuredCategoryIds || []),
    ...blocks.flatMap((block) => block?.categoryIds || []),
  ], 32);
  return { sectionIds, blockProductIds, categoryIds };
}

function cleanObjectIds(values, limit) {
  return [...new Set((Array.isArray(values) ? values : []).map(String).filter((value) => mongoose.isValidObjectId(value)))].slice(0, limit);
}

function productKey(product) {
  return String(product?._id || product?.id || product?.slug || '');
}

function homeProduct(product, req) {
  const value = normalizeProductResponse(product, req);
  return Object.fromEntries([
    '_id', 'id', 'slug', 'name', 'category', 'subCategory', 'price', 'originalPrice', 'discountPercentage',
    'stock', 'lowStockAlert', 'sizes', 'colors', 'variants', 'sizingMode', 'images', 'primaryImage',
    'rating', 'numReviews', 'isFeatured', 'isNewArrival', 'isBestSeller', 'showOnHomepage', 'showInTrending', 'commerceMode',
  ].map((key) => {
    const field = key === 'images' && Array.isArray(value.images)
      ? value.images.slice(0, 1).map(publicImage)
      : key === 'variants' && Array.isArray(value.variants)
        ? value.variants.map(publicVariant)
        : value[key];
    return [key, field];
  }).filter(([, field]) => field !== undefined));
}

function publicImage(image) {
  if (typeof image === 'string') return image;
  return { url: image?.url || '', primary: Boolean(image?.primary) };
}

function publicVariant(variant = {}) {
  return Object.fromEntries([
    '_id', 'sku', 'size', 'color', 'optionValues', 'stock', 'lowStockAlert', 'price', 'originalPrice', 'isActive',
  ].map((key) => [key, key === 'optionValues' && variant[key] instanceof Map ? Object.fromEntries(variant[key]) : variant[key]])
    .filter(([, value]) => value !== undefined));
}

function uniqueProducts(groups) {
  const rows = new Map();
  Object.values(groups).flat().forEach((product) => {
    const key = productKey(product);
    if (key && !rows.has(key)) rows.set(key, product);
  });
  return [...rows.values()];
}

function publicBanner(banner = {}) {
  return Object.fromEntries([
    '_id', 'title', 'subtitle', 'image', 'tabletImage', 'mobileImage', 'altText', 'focalPoint',
    'buttonText', 'link', 'type', 'position', 'displayOrder', 'campaignKey', 'couponCode',
  ].map((key) => [key, banner[key]]).filter(([, value]) => value !== undefined));
}

function publicCategory(category = {}) {
  return Object.fromEntries([
    '_id', 'name', 'slug', 'image', 'parent', 'level', 'displayOrder',
  ].map((key) => [key, category[key]]).filter(([, value]) => value !== undefined));
}

function publicSettings(settings = {}) {
  const value = settings || {};
  return {
    acceptingOrders: value.acceptingOrders !== false,
    orderPauseMessage: value.orderPauseMessage || '',
    shippingPricingMode: value.shippingPricingMode || 'fixed',
    shippingFreeAboveEnabled: value.shippingFreeAboveEnabled !== false,
    freeShippingMinAmount: Math.max(0, Number(value.freeShippingMinAmount ?? 999)),
    deliveryCharge: Math.max(0, Number(value.deliveryCharge ?? 99)),
    returnsEnabled: value.returnsEnabled !== false,
    returnWindowDays: Math.max(0, Number(value.returnWindowDays ?? 7)),
    codEnabled: value.codEnabled !== false,
    razorpayEnabled: Boolean(value.razorpayEnabled),
    upiEnabled: value.upiEnabled !== false,
    cardPaymentEnabled: value.cardPaymentEnabled !== false,
    netBankingEnabled: value.netBankingEnabled !== false,
    walletEnabled: value.walletEnabled !== false,
    socialLinks: value.socialLinks || {},
    occasionShoppingEnabled: value.occasionShoppingEnabled !== false,
    recentlyViewedEnabled: value.recentlyViewedEnabled !== false,
    completeLookEnabled: value.completeLookEnabled !== false,
  };
}

async function settled(label, work, fallback, warnings) {
  try {
    return await work();
  } catch (_error) {
    warnings.push(label);
    return fallback;
  }
}

exports.getMobileHome = asyncHandler(async (req, res) => {
  const started = process.hrtime.bigint();
  const warnings = [];
  // Start independent work together. A policy/theme lookup must not postpone
  // every catalog, category and banner query behind another network roundtrip.
  const themePromise = settled('configuration', () => WebsiteTheme.findOne({ isActive: true, publishedConfig: { $exists: true, $ne: null } })
    .select('publishedConfig').maxTimeMS(HOME_QUERY_TIMEOUT_MS).lean(), null, warnings);
  const settingsPromise = settled('settings', () => Settings.findOne(req.tenantFilter || {})
    .select(HOME_SETTINGS_FIELDS).maxTimeMS(HOME_QUERY_TIMEOUT_MS).lean(), {}, warnings);
  const categoriesPromise = settled('categories', () => Category.find(andFilter({ isActive: true, isArchived: { $ne: true } }, req.tenantFilter))
    .select('_id name slug image parent level displayOrder').sort('level displayOrder name').limit(CATEGORY_LIMIT)
    .maxTimeMS(HOME_QUERY_TIMEOUT_MS).lean(), [], warnings);
  const bannersPromise = settled('banners', async () => {
    const now = new Date();
    const live = andFilter({
      isActive: true, isArchived: { $ne: true },
      $and: [
        { $or: [{ startsAt: { $exists: false } }, { startsAt: null }, { startsAt: { $lte: now } }] },
        { $or: [{ endsAt: { $exists: false } }, { endsAt: null }, { endsAt: { $gte: now } }] },
      ],
    }, req.tenantFilter);
    return (await Banner.find(live).sort({ position: 1, displayOrder: 1, createdAt: -1 })
      .limit(BANNER_LIMIT).maxTimeMS(HOME_QUERY_TIMEOUT_MS).lean()).map(publicBanner);
  }, [], warnings);
  const recentIds = cleanObjectIds(String(req.query.recent || '').split(','), SECTION_LIMIT);
  const textFilter = (terms) => ({ $or: [
    { name: { $regex: terms, $options: 'i' } },
    { subCategory: { $regex: terms, $options: 'i' } },
    { tags: { $elemMatch: { $regex: terms, $options: 'i' } } },
  ] });
  const loadProducts = (extra, sort = '-createdAt', limit = SECTION_LIMIT) => Product.find(publicProductFilter(req, extra))
    .select(HOME_PRODUCT_FIELDS).sort(sort).limit(limit).maxTimeMS(HOME_QUERY_TIMEOUT_MS).lean();

  const productJobs = {
    latest: () => loadProducts({}, '-createdAt'),
    featured: () => loadProducts({ $or: [{ isFeatured: true }, { showOnHomepage: true }] }, '-updatedAt'),
    trending: () => loadProducts({ showInTrending: true }, '-updatedAt'),
    newArrivals: () => loadProducts({ isNewArrival: true }, '-createdAt'),
    bestSellers: () => loadProducts({ isBestSeller: true }, '-rating -numReviews -updatedAt'),
    ethnicSets: () => loadProducts(textFilter('ethnic|set|suit|kurti|lehenga|saree'), '-updatedAt'),
    accessories: () => loadProducts(textFilter('accessor|jewell|earring|necklace|bracelet|bag'), '-updatedAt'),
    instagram: () => loadProducts({ 'images.0': { $exists: true } }, '-createdAt'),
    recommended: () => loadProducts({ rating: { $gt: 0 } }, '-rating -numReviews -updatedAt'),
  };
  const productsPromise = Promise.all(Object.entries(productJobs).map(async ([key, job]) => [
    key, await settled(`products.${key}`, job, [], warnings),
  ]));
  const configured = configuredIds(req, await themePromise);
  const allSelectedIds = cleanObjectIds([...Object.values(configured.sectionIds).flat(), ...configured.blockProductIds, ...recentIds], 100);
  const [productResults, selectedProducts, settings, baseCategories, selectedCategories, banners] = await Promise.all([
    productsPromise,
    settled('products.selected', () => allSelectedIds.length ? loadProducts({ _id: { $in: allSelectedIds } }, '-updatedAt', 100) : [], [], warnings),
    settingsPromise,
    categoriesPromise,
    settled('categories', () => configured.categoryIds.length ? Category.find(andFilter({
      _id: { $in: configured.categoryIds }, isActive: true, isArchived: { $ne: true },
    }, req.tenantFilter)).select('_id name slug image parent level displayOrder').maxTimeMS(HOME_QUERY_TIMEOUT_MS).lean() : [], [], warnings),
    bannersPromise,
  ]);
  const rawCollections = Object.fromEntries(productResults);
  rawCollections.selected = selectedProducts;
  const uniqueRows = uniqueProducts(rawCollections);
  // One category population for unique products, instead of repeating it for
  // each rail. Use the same pricing/sizing serializer as product detail.
  const populated = await settled('products.categories', () => Product.populate(uniqueRows, {
    path: 'category', select: 'name slug', options: { lean: true, maxTimeMS: HOME_QUERY_TIMEOUT_MS },
  }), uniqueRows, warnings);
  const byId = new Map(populated.map(product => [productKey(product), homeProduct(product, req)]));
  rawCollections.recentlyViewed = settings?.recentlyViewedEnabled === false ? [] : recentIds.map((id) => byId.get(String(id))).filter(Boolean);
  for (const [section, ids] of Object.entries(configured.sectionIds)) {
    if (!ids.length) continue;
    const resolved = ids.map((id) => byId.get(String(id))).filter(Boolean);
    // A deleted or unpublished selection must not blank the section.
    if (resolved.length) rawCollections[section] = resolved;
  }
  const serializedCollections = Object.fromEntries(Object.entries(rawCollections).map(([key, products]) => [
    key, products.map(product => byId.get(productKey(product))).filter(Boolean),
  ]));
  const products = uniqueProducts(serializedCollections);
  const categories = uniqueById([...selectedCategories, ...baseCategories]).slice(0, CATEGORY_LIMIT).map(publicCategory);
  const compact = req.query.format === 'compact';

  // A failed section must be retryable immediately, not pinned in an HTTP cache.
  res.setHeader('Cache-Control', recentIds.length ? 'private, no-store' : warnings.length ? 'no-store' : 'public, max-age=30, stale-while-revalidate=120');
  res.setHeader('Server-Timing', `home;dur=${(Number(process.hrtime.bigint() - started) / 1e6).toFixed(1)}`);
  res.vary('X-Store-Slug');
  res.json({
    products,
    ...(compact ? { format: 'compact-v1' } : {}),
    collections: compact ? Object.fromEntries(Object.entries(serializedCollections).map(([key, rows]) => [key, rows.map(productKey)])) : serializedCollections,
    categories,
    banners,
    settings: { ...publicSettings(settings), commerceMode: req.store?.catalogStructure?.commerce?.mode || 'SALE_ONLY', available: !warnings.includes('settings') },
    warnings: [...new Set(warnings)],
    generatedAt: new Date().toISOString(),
  });
});

function uniqueById(items) {
  const seen = new Set();
  return items.filter((item) => {
    const id = String(item?._id || item?.id || item?.slug || '');
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

exports.publicSettings = publicSettings;
exports.homeProduct = homeProduct;
