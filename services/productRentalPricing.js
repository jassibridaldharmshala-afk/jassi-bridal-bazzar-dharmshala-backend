const M = require('../models/Rental');
const A = require('./rentalAlgorithms');
const { ApiError } = require('../utils/apiError');
const { supportsTransactions } = require('../utils/transaction');

function values(input) {
  if (!input || Array.isArray(input) || typeof input !== 'object') throw new ApiError('VALIDATION_ERROR', 'Enter rental pricing.');
  return { dailyRatePaise: A.integer(input.dailyRatePaise, 'rental price per day', 1), depositPaise: A.integer(input.depositPaise, 'refundable deposit'), ...A.advanceRules(input), ...(input.fitting !== undefined ? { fitting: require('./rentalFitting').fitting(input.fitting) } : {}) };
}
async function prepare(input) {
  if (input === undefined || input === null) return;
  values(input);
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
    const saved = await M.Listing.findOneAndUpdate({ _id: A.id(input.listingId), storeId: store._id, productId: product._id, revision: A.integer(input.revision, 'rental offer revision') }, { $set: pricing, $inc: { revision: 1 } }, { new: true, session, runValidators: true });
    if (!saved) throw new ApiError('DUPLICATE_REQUEST', 'Rental pricing changed. Reload this product before saving.');
    return saved;
  }
  if (await M.Listing.exists({ storeId: store._id, productId: product._id }).session(session)) throw new ApiError('DUPLICATE_REQUEST', 'This product already has rental offers. Reload and choose the offer to edit.');
  // An offer is a price, not physical stock. Activation follows piece setup.
  return (await M.Listing.create([{ storeId: store._id, productId: product._id, title: product.name, active: false, ...pricing, matchingVersion: 2, requirements: [{ poolKey: `product-${product._id}`, label: product.name.slice(0, 100), quantity: 1, productId: product._id }] }], { session }))[0];
}
async function offers(product, store) {
  store ||= product.storeId ? null : await require('./storeService').ensureDefaultStore();
  return M.Listing.find({ storeId: product.storeId || store?._id, productId: product._id }).sort({ createdAt: 1, _id: 1 }).limit(50).select('_id title active revision dailyRatePaise depositPaise advanceMode advancePercent advanceAmountPaise fitting').lean();
}
module.exports = { prepare, save, offers, values };
