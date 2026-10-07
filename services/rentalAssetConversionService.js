const M = require('../models/Rental');
const Product = require('../models/Product');
const A = require('./rentalAlgorithms');
const { ApiError } = require('../utils/apiError');
const { defaultStoreFilter } = require('./storeService');
const { hasManagedVariants } = require('./variantService');
async function convert(store, assetId, input, actorId) {
  A.operation(input.operationId);
  if (input.confirmTransfer !== true || !A.text(input.note || '', 1000)) throw new ApiError('VALIDATION_ERROR', 'Confirm the physical stock transfer and record its reason.');
  return require('./rentalService').transaction(store, async session => {
    const asset = await M.Asset.findOne({ _id: A.id(assetId), storeId: store._id }).session(session);
    if (!asset) throw new ApiError('NOT_FOUND', 'Rental piece not found.');
    if (asset.saleConversion?.operationId === input.operationId) return asset.toObject();
    const config = await M.Configuration.findOne({ storeId: store._id }).session(session).lean();
    if (config?.mode === 'RENTAL_ONLY') throw new ApiError('VALIDATION_ERROR', 'Enable sale operations before transferring a rental piece into sale inventory.');
    if (asset.saleConversion || asset.revision !== input.revision || asset.status !== 'READY' || asset.currentBookingId) throw new ApiError('DUPLICATE_REQUEST', 'Only an unassigned ready rental piece can be transferred once.');
    if (await M.Reservation.exists({ storeId: store._id, assetId: asset._id, active: true, $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] }).session(session)) throw new ApiError('DUPLICATE_REQUEST', 'Release/reassign all bookings and maintenance reservations before selling this piece.');
    const productId = A.id(input.productId || asset.productId);
    if (!asset.productId || String(asset.productId) !== productId) throw new ApiError('VALIDATION_ERROR', 'Bind this piece to its exact product before transferring it to sale stock.');
    const product = await Product.findOne({ _id: productId, ...(store.isDefault ? defaultStoreFilter(store._id) : { storeId: store._id }), isArchived: { $ne: true }, commerceMode: { $ne: 'RENTAL_ONLY' } }).session(session);
    if (!product) throw new ApiError('VALIDATION_ERROR', 'Enable sale availability for the bound product first.');
    const variantId = input.variantId || asset.variantId || '';
    if (hasManagedVariants(product)) {
      const variant = product.variants.find(v => String(v._id) === variantId && v.isActive !== false);
      const key = value => String(value || '').trim().toLowerCase();
      if (!variant || (asset.variantId && asset.variantId !== variantId) || (asset.size && key(asset.size) !== key(variant.size)) || (asset.colour && key(asset.colour) !== key(variant.color))) throw new ApiError('VALIDATION_ERROR', 'Choose the exact active sale variant matching this piece.');
      variant.stock = Number(variant.stock || 0) + 1;
      product.stock = product.variants.filter(v => v.isActive !== false).reduce((n, v) => n + Number(v.stock || 0), 0);
    } else product.stock = Number(product.stock || 0) + 1;
    asset.status = 'RETIRED'; asset.revision += 1;
    asset.saleConversion = { operationId: input.operationId, productId: product._id, variantId, at: new Date(), actorId, note: A.text(input.note, 1000) };
    await product.save({ session }); await asset.save({ session });
    return asset.toObject();
  });
}
module.exports = { convert };
