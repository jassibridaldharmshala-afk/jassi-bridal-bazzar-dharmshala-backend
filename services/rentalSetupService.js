const M = require('../models/Rental');
const Product = require('../models/Product');
const A = require('./rentalAlgorithms');
const I = require('./rentalInventoryRules');
const { defaultStoreFilter } = require('./storeService');
const { ApiError } = require('../utils/apiError');

// Readiness means the offer is configured, not that a particular date is free.
// The reservation engine remains authoritative for date availability.
async function batchReadiness(store, listings, session = null) {
  if (!listings.length) return new Map();
  const scope = store.isDefault ? defaultStoreFilter(store._id) : { storeId: store._id };
  const ids = [...new Set(listings.flatMap(listing => [listing.productId, ...(listing.requirements || []).map(r => r.productId)]).filter(Boolean).map(String))];
  const productQuery = Product.find({ $and: [scope, { _id: { $in: ids } }, I.publishedRentalFilter()] }).select('_id variants').session(session).lean();
  const inventory = listings.flatMap(listing => (listing.requirements || []).map(r => I.assetFilter(r, listing)));
  const assetQuery = M.Asset.find({ storeId: store._id, $or: inventory.length ? inventory : [{ _id: null }], status: { $nin: ['LOST', 'RETIRED'] }, saleConversion: null }).select('productId variantId size colour poolKey status').session(session).lean();
  // MongoDB operations on the same transaction/session must be sequential.
  const [products, assets] = session ? [await productQuery, await assetQuery] : await Promise.all([productQuery, assetQuery]);
  const now = new Date();
  const reservations = await M.Reservation.find({ storeId: store._id, assetId: { $in: assets.map(a => a._id) }, kind: 'BOOKING', active: true, blockedUntil: { $gt: now }, $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] }).select('assetId').session(session).lean();
  const reservedIds = new Set(reservations.map(row => String(row.assetId)));
  const byId = new Map(products.map(p => [String(p._id), p]));
  const productReady = (productId, variantId) => {
    const p = byId.get(String(productId));
    return !!p && (!variantId || p.variants?.some(v => String(v._id) === String(variantId) && v.isActive !== false));
  };
  const pools = new Map(), productPieces = new Map();
  for (const asset of assets) {
    if (!pools.has(asset.poolKey)) pools.set(asset.poolKey, []); pools.get(asset.poolKey).push(asset);
    const productId = String(asset.productId || '');
    if (!productPieces.has(productId)) productPieces.set(productId, []); productPieces.get(productId).push(asset);
  }
  return new Map(listings.map(listing => {
  const components = (listing.requirements || []).map(r => {
    const candidates = I.usesProductInventory(r, listing) ? productPieces.get(String(listing.productId)) : pools.get(r.poolKey);
    const matching = (candidates || []).filter(a => I.matchesPiece(a, r, listing));
    return { ...r, _pieceStates: matching.map(a => ({ id: String(a._id), status: a.status, reserved: reservedIds.has(String(a._id)) })), productReady: productReady(r.productId || listing.productId, r.variantId || (listing.requirements.length === 1 ? listing.variantId : '')), configured: matching.length, readyNow: matching.filter(a => a.status === 'READY').length, reserved: matching.filter(a => a.status !== 'OUT' && reservedIds.has(String(a._id))).length, booked: matching.filter(a => a.status === 'OUT').length, cleaning: matching.filter(a => ['CLEANING', 'REPAIR'].includes(a.status)).length, required: r.quantity };
  });
  const checks = [
    { key: 'product', label: 'Product published with rental enabled', ready: productReady(listing.productId, listing.variantId) && components.every(r => r.productReady) },
    { key: 'price', label: 'Rental price and deposit configured', ready: Number.isSafeInteger(listing.dailyRatePaise) && listing.dailyRatePaise > 0 && Number.isSafeInteger(listing.depositPaise) && listing.depositPaise >= 0 },
    { key: 'pieces', label: 'Actual matching pieces registered for every component', ready: components.length > 0 && components.every(r => r.configured >= r.required) },
  ];
  const reasons = checks.filter(c => !c.ready).map(c => ({ code: { product: 'PRODUCT_OR_COMPONENT_UNAVAILABLE', price: 'PRICE_NOT_SET', pieces: 'NO_PHYSICAL_PIECES' }[c.key], message: c.label }));
  return [String(listing._id), { ready: checks.every(c => c.ready), checks, components, reasons }];
  }));
}
async function readiness(store, listing, session = null) {
  return (await batchReadiness(store, [listing], session)).get(String(listing._id));
}
async function detail(store, id) {
  const listing = await M.Listing.findOne({ _id: A.id(id), storeId: store._id }).lean();
  if (!listing) throw new ApiError('NOT_FOUND', 'Rental offer not found.');
  const configuration = await require('./rentalService').readConfiguration(store);
  const product = await Product.findOne({ _id: listing.productId, ...(store.isDefault ? defaultStoreFilter(store._id) : { storeId: store._id }), isArchived: { $ne: true } }).select('_id name sku images commerceMode isActive publishAt').lean();
  return { listing, product, ...(await readiness(store, listing)), shopEnabled: configuration.mode !== 'SALE_ONLY', onlinePayments: configuration.readiness.onlinePayments, acceptingOrders: configuration.readiness.acceptingOrders, contact: configuration.contact, policyRevision: configuration.revision };
}
async function registerPieces(store, id, input) {
  const operationId = A.operation(input.operationId), quantity = A.integer(input.quantity, 'actual quantity to register', 1, 100);
  const componentIndex = A.integer(input.componentIndex, 'component', 0, 11);
  const fingerprint = require('./rentalStudioAlgorithms').fingerprint({ id, componentIndex, quantity, location: input.location || '', condition: input.condition || 'Good' });
  return require('./rentalService').transaction(store, async session => {
    const existing = await M.Asset.find({ storeId: store._id, registrationBatchId: operationId }).session(session).lean();
    if (existing.length) {
      if (existing.length !== quantity || existing.some(row => row.registrationFingerprint !== fingerprint)) throw new ApiError('DUPLICATE_REQUEST', 'This piece-registration attempt belongs to different details.');
      return { rows: existing, quantity, replay: true };
    }
    const listing = await M.Listing.findOne({ _id: A.id(id), storeId: store._id }).session(session).lean();
    if (!listing) throw new ApiError('NOT_FOUND', 'Rental offer not found.');
    if (listing.revision !== input.revision) throw new ApiError('DUPLICATE_REQUEST', 'Offer changed. Reload setup before registering pieces.');
    const component = listing.requirements[componentIndex];
    if (!component) throw new ApiError('VALIDATION_ERROR', 'Choose an existing component.');
    const values = { poolKey: component.poolKey, productId: component.productId || listing.productId, variantId: component.variantId || (listing.requirements.length === 1 ? listing.variantId : ''), size: component.size || '', colour: component.colour || '' };
    const binding = await I.binding(store, values, null, session);
    const prefix = `R-${String(listing._id).slice(-8)}-${componentIndex + 1}-${require('node:crypto').createHash('sha256').update(operationId).digest('hex').slice(0, 16)}`.toUpperCase();
    const rows = await M.Asset.insertMany(Array.from({ length: quantity }, (_, i) => ({ storeId: store._id, ...values, ...binding,
      code: `${prefix}-${String(i + 1).padStart(3, '0')}`, label: A.text(component.label, 190) + ` #${i + 1}`,
      location: A.text(input.location || '', 200), condition: A.text(input.condition || 'Good', 1000),
      registrationBatchId: operationId, registrationFingerprint: fingerprint })), { session });
    return { rows: rows.map(row => row.toObject()), quantity, replay: false };
  });
}
module.exports = { readiness, batchReadiness, detail, registerPieces };
