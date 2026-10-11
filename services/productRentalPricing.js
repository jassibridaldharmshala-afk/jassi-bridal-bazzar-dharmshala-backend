const M = require('../models/Rental');
const A = require('./rentalAlgorithms');
const { ApiError } = require('../utils/apiError');
const { supportsTransactions } = require('../utils/transaction');

function inventoryValues(input, required = false) {
  if (input?.inventory === undefined && !required) return;
  if (!Array.isArray(input?.inventory) || !input.inventory.length || input.inventory.length > 12) throw new ApiError('VALIDATION_ERROR', 'Enter the actual number of physical rental pieces before publishing.');
  const indices = new Set();
  return input.inventory.map(row => {
    const componentIndex = A.integer(row?.componentIndex, 'rental component', 0, 11);
    if (indices.has(componentIndex)) throw new ApiError('VALIDATION_ERROR', 'Enter rental pieces once for each component.');
    indices.add(componentIndex);
    // A new product accepts at most 100 pieces. Existing totals may be larger,
    // but saveInventory also caps the number of additions per component at 100.
    const quantity = A.integer(row.quantity, 'physical rental piece count', 1, input.listingId ? 1000 : 100);
    const status = row.status || 'READY';
    if (!['READY', 'CLEANING', 'REPAIR'].includes(status)) throw new ApiError('VALIDATION_ERROR', 'Choose the condition of the new rental pieces.');
    return { componentIndex, quantity, location: A.text(row.location ?? '', 200), status };
  });
}
function values(input, { requireInventory = false } = {}) {
  if (!input || Array.isArray(input) || typeof input !== 'object') throw new ApiError('VALIDATION_ERROR', 'Enter rental pricing.');
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new ApiError('VALIDATION_ERROR', 'Choose whether to show this product for rental.');
  inventoryValues(input, requireInventory);
  return { dailyRatePaise: A.integer(input.dailyRatePaise, 'rental price per day', 1), depositPaise: A.integer(input.depositPaise, 'refundable deposit'), ...A.advanceRules(input), ...(input.fitting !== undefined ? { fitting: require('./rentalFitting').fitting(input.fitting) } : {}) };
}
async function prepare(input, { requireInventory = false } = {}) {
  if ((input === undefined || input === null) && !requireInventory) return;
  values(input, { requireInventory });
  if (!(await supportsTransactions())) throw new ApiError('SERVICE_UNAVAILABLE', 'Saving rental pricing requires a MongoDB replica set.');
  await require('./rentalService').ensureIndexes();
}
async function save(store, product, input, session) {
  if (input === undefined || input === null) return;
  if (!session) throw new ApiError('SERVICE_UNAVAILABLE', 'Rental pricing requires a transaction.');
  store ||= product.storeId ? await require('../models/Store').findById(product.storeId).session(session) : await require('./storeService').ensureDefaultStore();
  if (!store?._id || (product.storeId && String(product.storeId) !== String(store._id))) throw new ApiError('NOT_FOUND', 'Choose a product from this store.');
  if (product.commerceMode === 'SALE_ONLY') throw new ApiError('VALIDATION_ERROR', 'Enable rental mode before adding a rental price.');
  if (!product.storeId) { product.storeId = store._id; await require('../models/Product').updateOne({ _id: product._id }, { $set: { storeId: store._id } }, { session }); }
  const pricing = values(input);
  // Use the same fence as reservations: a booking cannot accept an old price
  // while a product and its offer are being updated together.
  await M.Configuration.updateOne({ storeId: store._id }, { $inc: { fence: 1 }, $setOnInsert: { mode: store.catalogStructure?.commerce?.mode || 'SALE_ONLY', policy: { ...A.DEFAULT_POLICY, timezone: store.timezone || 'Asia/Kolkata' }, revision: 0 } }, { session, upsert: true });
  if (input.listingId) {
    const saved = await M.Listing.findOneAndUpdate({ _id: A.id(input.listingId), storeId: store._id, productId: product._id, revision: A.integer(input.revision, 'rental offer revision') }, { $set: { ...pricing, ...(input.enabled !== undefined ? { active: input.enabled } : {}) }, $inc: { revision: 1 } }, { new: true, session, runValidators: true });
    if (!saved) throw new ApiError('DUPLICATE_REQUEST', 'Rental pricing changed. Reload this product before saving.');
    await saveInventory(store, saved, input, session);
    return saved;
  }
  if (await M.Listing.exists({ storeId: store._id, productId: product._id }).session(session)) throw new ApiError('DUPLICATE_REQUEST', 'This product already has rental offers. Reload and choose the offer to edit.');
  inventoryValues(input, true);
  const created = (await M.Listing.create([{ storeId: store._id, productId: product._id, title: product.name, active: input.enabled !== false, publicationOrigin: 'PRODUCT', ...pricing, matchingVersion: 2, requirements: [{ poolKey: `product-${product._id}`, label: product.name.slice(0, 100), quantity: 1, productId: product._id }] }], { session }))[0];
  await saveInventory(store, created, input, session);
  return created;
}
async function saveInventory(store, listing, input, session) {
  const rows = inventoryValues(input);
  if (!rows) return; // Existing integrations may update a saved offer's price only.
  if (rows.length !== listing.requirements.length || rows.some(row => !listing.requirements[row.componentIndex])) throw new ApiError('VALIDATION_ERROR', 'Enter the physical piece count for every rental component.');
  const I = require('./rentalInventoryRules');
  for (const row of rows) {
    const requirement = listing.requirements[row.componentIndex];
    const assets = await M.Asset.find({ storeId: store._id, ...I.assetFilter(requirement, listing), status: { $nin: ['LOST', 'RETIRED'] }, saleConversion: null }).session(session).lean();
    const count = assets.filter(asset => I.matchesPiece(asset, requirement, listing)).length;
    if (row.quantity < count) throw new ApiError('VALIDATION_ERROR', 'Rental pieces have changed, or this count would remove existing pieces. Reload the product; retire pieces in rental stock.');
    if (row.quantity < requirement.quantity) throw new ApiError('VALIDATION_ERROR', `Register at least ${requirement.quantity} physical pieces for ${requirement.label}.`);
    const quantity = row.quantity - count;
    if (quantity > 100) throw new ApiError('VALIDATION_ERROR', 'Add at most 100 new rental pieces per component in one save.');
    if (!quantity) continue;
    await require('./rentalSetupService').registerPiecesInSession(store, listing, {
      ...row, quantity, operationId: `product_${listing._id}_${listing.revision}_${row.componentIndex}_${row.quantity}`,
      condition: { READY: 'Good', CLEANING: 'Needs cleaning', REPAIR: 'Needs repair' }[row.status],
    }, session);
  }
}
async function offers(product, store) {
  store ||= product.storeId ? await require('../models/Store').findById(product.storeId) : await require('./storeService').ensureDefaultStore();
  const rows = await M.Listing.find({ storeId: product.storeId || store?._id, productId: product._id }).sort({ createdAt: 1, _id: 1 }).limit(50).lean();
  if (!rows.length) return [];
  const statuses = await require('./rentalSetupService').batchReadiness(store, rows);
  const config = await require('./rentalService').readConfiguration(store);
  return rows.map(row => {
    const status = statuses.get(String(row._id));
    return { _id: row._id, title: row.title, active: row.active, revision: row.revision,
      dailyRatePaise: row.dailyRatePaise, depositPaise: row.depositPaise,
      advanceMode: row.advanceMode, advancePercent: row.advancePercent, advanceAmountPaise: row.advanceAmountPaise,
      ...(row.fitting ? { fitting: row.fitting } : {}), ready: status.ready,
      live: row.active && status.ready && config.mode !== 'SALE_ONLY',
      pieces: status.components.map(c => ({ label: c.label, configured: c.configured, required: c.required })),
      reasons: [...status.reasons, ...(config.mode === 'SALE_ONLY' ? [{ code: 'RENTALS_DISABLED', message: 'Enable rentals in shop policies.' }] : [])] };
  });
}
module.exports = { prepare, save, offers, values, inventoryValues };
