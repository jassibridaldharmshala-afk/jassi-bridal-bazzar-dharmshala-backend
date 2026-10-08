const M = require('../models/Rental');
const Product = require('../models/Product');
const A = require('./rentalAlgorithms');
const I = require('./rentalInventoryRules');
const { defaultStoreFilter } = require('./storeService');
const { ApiError } = require('../utils/apiError');

// Readiness means the offer is configured, not that a particular date is free.
// The reservation engine remains authoritative for date availability.
async function readiness(store, listing, session = null) {
  const scope = store.isDefault ? defaultStoreFilter(store._id) : { storeId: store._id };
  const ids = [...new Set([listing.productId, ...listing.requirements.map(r => r.productId)].filter(Boolean).map(String))];
  const productQuery = Product.find({ $and: [scope, { _id: { $in: ids } }, I.publishedRentalFilter()] }).select('_id variants').session(session).lean();
  const assetQuery = M.Asset.find({ storeId: store._id, poolKey: { $in: listing.requirements.map(r => r.poolKey) }, status: { $nin: ['LOST', 'RETIRED'] }, saleConversion: null }).select('productId variantId size colour poolKey status').session(session).lean();
  // MongoDB operations on the same transaction/session must be sequential.
  const [products, assets] = session ? [await productQuery, await assetQuery] : await Promise.all([productQuery, assetQuery]);
  const byId = new Map(products.map(p => [String(p._id), p]));
  const productReady = (productId, variantId) => {
    const p = byId.get(String(productId));
    return !!p && (!variantId || p.variants?.some(v => String(v._id) === variantId && v.isActive !== false));
  };
  const components = listing.requirements.map(r => {
    const matching = assets.filter(a => a.poolKey === r.poolKey && I.matchesPiece(a, r, listing));
    return { ...r, productReady: productReady(r.productId || listing.productId, r.variantId || (listing.requirements.length === 1 ? listing.variantId : '')), configured: matching.length, readyNow: matching.filter(a => a.status === 'READY').length, required: r.quantity };
  });
  const checks = [
    { key: 'product', label: 'Product published with rental enabled', ready: productReady(listing.productId, listing.variantId) && components.every(r => r.productReady) },
    { key: 'price', label: 'Rental price and deposit configured', ready: Number.isSafeInteger(listing.dailyRatePaise) && listing.dailyRatePaise > 0 && Number.isSafeInteger(listing.depositPaise) && listing.depositPaise >= 0 },
    { key: 'pieces', label: 'Actual matching pieces registered for every component', ready: components.length > 0 && components.every(r => r.configured >= r.required) },
  ];
  return { ready: checks.every(c => c.ready), checks, components };
}
async function detail(store, id) {
  const listing = await M.Listing.findOne({ _id: A.id(id), storeId: store._id }).lean();
  if (!listing) throw new ApiError('NOT_FOUND', 'Rental offer not found.');
  const configuration = await require('./rentalService').readConfiguration(store);
  return { listing, ...(await readiness(store, listing)), shopEnabled: configuration.mode !== 'SALE_ONLY', policyRevision: configuration.revision };
}
module.exports = { readiness, detail };
