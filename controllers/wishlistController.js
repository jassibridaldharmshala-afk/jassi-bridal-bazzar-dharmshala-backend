const mongoose = require('mongoose');
const Product = require('../models/Product');
const User = require('../models/User');
const { normalizeProductImages } = require('../utils/imageUtils');
const { andFilter } = require('../services/storeService');
const { asyncHandler } = require('../middleware/validate');

function unavailable(id) {
  return { _id: String(id), id: String(id), name: 'This product is no longer available', images: [], isActive: false, unavailable: true, stock: 0 };
}

async function resolveProducts(values, req) {
  const ids = [...new Set(values.map(value => String(value?._id || value || '').trim()).filter(Boolean))];
  if (!ids.length) return [];
  const objectIds = ids.filter(id => mongoose.Types.ObjectId.isValid(id));
  const slugs = ids.filter(id => !mongoose.Types.ObjectId.isValid(id));
  const products = await Product.find(andFilter({
    $or: [{ _id: { $in: objectIds } }, { slug: { $in: slugs } }],
    isActive: { $ne: false }, isArchived: { $ne: true },
  }, req.tenantFilter)).populate('category', 'name slug');
  const lookup = new Map();
  products.forEach(product => { lookup.set(String(product._id), product); lookup.set(product.slug, product); });
  const seen = new Set();
  return ids.map(id => {
    const product = lookup.get(id);
    const key = String(product?._id || id);
    if (seen.has(key)) return null;
    seen.add(key);
    return product ? { ...normalizeProductImages(product, req), id: key } : unavailable(id);
  }).filter(Boolean);
}

async function readWishlist(req) {
  const user = await User.findById(req.user._id).select('wishlist').lean();
  return resolveProducts(user?.wishlist || [], req);
}

// Refresh guest saves from the public catalogue without exposing unpublished data.
exports.resolveWishlist = asyncHandler(async (req, res) => {
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || ids.length > 200 || ids.some(id => typeof id !== 'string' || !/^[\w-]{1,160}$/.test(id))) {
    return res.status(400).json({ message: 'Provide up to 200 valid product IDs.' });
  }
  res.json(await resolveProducts(ids, req));
});

exports.getWishlist = asyncHandler(async (req, res) => {
  res.json(await readWishlist(req));
});

exports.addWishlist = asyncHandler(async (req, res) => {
  const [product] = await resolveProducts([req.params.productId], req);
  if (!product || product.unavailable) return res.status(404).json({ message: 'This product is no longer available.' });
  // Atomic updates prevent simultaneous tabs from overwriting each other's saves.
  await User.updateOne({ _id: req.user._id }, { $addToSet: { wishlist: product._id } });
  res.json(await readWishlist(req));
});

exports.removeWishlist = asyncHandler(async (req, res) => {
  const value = String(req.params.productId || '');
  let id = mongoose.Types.ObjectId.isValid(value) ? value : null;
  if (!id) id = (await Product.findOne(andFilter({ slug: value }, req.tenantFilter)).select('_id').lean())?._id;
  // Deleted or archived products remain removable by their stored ID.
  if (id) await User.updateOne({ _id: req.user._id }, { $pull: { wishlist: id } });
  res.json(await readWishlist(req));
});
