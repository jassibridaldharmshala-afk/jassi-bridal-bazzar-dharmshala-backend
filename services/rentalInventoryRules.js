const { ApiError } = require('../utils/apiError');
const A = require('./rentalAlgorithms');
const key = value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
function publishedRentalFilter(now = new Date()) {
  return { isActive: true, isArchived: { $ne: true }, commerceMode: { $in: ['RENTAL_ONLY', 'SALE_AND_RENTAL'] }, $or: [{ publishAt: null }, { publishAt: { $exists: false } }, { publishAt: { $lte: now } }] };
}
function matchesPiece(asset, requirement, listing) {
  const constraints = {
    productId: requirement.productId || (listing.requirements.length === 1 ? listing.productId : undefined),
    variantId: requirement.variantId || (listing.requirements.length === 1 ? listing.variantId : undefined),
    size: requirement.size || (listing.requirements.length === 1 ? listing.size : undefined),
    colour: requirement.colour || (listing.requirements.length === 1 ? listing.colour : undefined),
  };
  return Object.entries(constraints).every(([field, value]) => !value || (asset[field] ? key(asset[field]) === key(value) : listing.matchingVersion !== 2));
}
async function binding(store, input, existing, session) {
  const M = require('../models/Rental');
  const Product = require('../models/Product');
  const { defaultStoreFilter } = require('./storeService');
  let productId = input.productId || existing?.productId;
  let inferred = {};
  if (!productId) {
    const listings = await M.Listing.find({ storeId: store._id, active: true, 'requirements.poolKey': input.poolKey }).limit(100).session(session).lean();
    const maps = listings.map(l => {
      const r = l.requirements.find(r => r.poolKey === input.poolKey);
      return { productId: r.productId || l.productId, variantId: r.variantId || (l.requirements.length === 1 ? l.variantId : ''), size: r.size || (l.requirements.length === 1 ? l.size : ''), colour: r.colour || (l.requirements.length === 1 ? l.colour : '') };
    });
    if (maps.length && new Set(maps.map(m => JSON.stringify(Object.fromEntries(Object.entries(m).map(([k, v]) => [k, key(v)]))))).size === 1) inferred = maps[0];
    productId = inferred.productId;
  }
  if (!productId) throw new ApiError('VALIDATION_ERROR', 'Choose the product/variant for this physical piece; its pool has no unambiguous mapping.');
  const product = await Product.findOne({ _id: A.id(productId), ...(store.isDefault ? defaultStoreFilter(store._id) : { storeId: store._id }), isArchived: { $ne: true } }).session(session);
  if (!product) throw new ApiError('VALIDATION_ERROR', 'Choose a product from this store for the physical piece.');
  const variantId = input.variantId ?? existing?.variantId ?? inferred.variantId ?? '';
  const variant = variantId ? product.variants.find(v => String(v._id) === variantId) : null;
  if (variantId && !variant) throw new ApiError('VALIDATION_ERROR', 'The piece variant does not belong to this product.');
  const size = A.text(input.size ?? existing?.size ?? inferred.size ?? variant?.size ?? '', 80);
  const colour = A.text(input.colour ?? existing?.colour ?? inferred.colour ?? variant?.color ?? '', 80);
  if (variant && ((size && key(size) !== key(variant.size)) || (colour && key(colour) !== key(variant.color)))) throw new ApiError('VALIDATION_ERROR', 'Piece size/colour must match its selected variant.');
  return { productId: product._id, variantId, size: size || variant?.size || '', colour: colour || variant?.color || '' };
}
module.exports = { publishedRentalFilter, matchesPiece, binding };
