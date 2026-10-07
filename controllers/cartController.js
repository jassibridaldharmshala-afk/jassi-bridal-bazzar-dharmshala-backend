const Cart = require('../models/Cart');
const Product = require('../models/Product');
const { asyncHandler } = require('../middleware/validate');
const { ApiError, notFound } = require('../utils/apiError');
const { availableStock, findVariant, requireVariant, variantId, variantUnitPrice, variantUnitMrp } = require('../services/variantService');
const { requireQuantity, requireObjectId } = require('../utils/validators');
const { andFilter } = require('../services/storeService');
const { normalizeProductImages } = require('../utils/imageUtils');
const { getSelectableProductSizes } = require('../services/productSizingService');
const { productAvailableForSale } = require('../services/productPricingService');

function readSessionId(req) {
  const raw = String(req.headers['x-session-id'] || '').trim();
  if (raw.length < 8 || raw.length > 120) return '';
  return raw;
}

function requireCartIdentity(req) {
  if (req.user?._id || readSessionId(req)) return;
  throw new ApiError('UNAUTHORIZED', 'Sign in or keep a shopping session to update your cart');
}

async function mergeSessionCartIntoUser(userId, sessionId, req) {
  if (!userId || !sessionId) return;
  const tenant = req.tenantFilter || {};
  const guest = await Cart.findOne(andFilter({ sessionId }, tenant));
  if (!guest) return;
  if (guest.user && String(guest.user) === String(userId)) {
    guest.sessionId = undefined;
    await guest.save();
    return;
  }
  if (guest.user && String(guest.user) !== String(userId)) return;

  let userCart = await Cart.findOne(andFilter({ user: userId }, tenant));
  if (!userCart) {
    guest.user = userId;
    guest.sessionId = undefined;
    await guest.save();
    return;
  }

  // A retried sign-in request must not transfer the same guest bag twice.
  if (userCart.mergedGuestCarts.some(id => String(id) === String(guest._id))) {
    await guest.deleteOne();
    return;
  }

  for (const line of guest.items || []) {
    const existing = userCart.items.find((entry) => sameCartLine(
      entry,
      line.product,
      line.size,
      line.color,
      line.variantId,
    ));
    if (existing) {
      existing.quantity = Number(existing.quantity || 0) + Number(line.quantity || 0);
      if (line.price != null) existing.price = line.price;
    } else {
      userCart.items.push({
        product: line.product,
        size: line.size,
        color: line.color,
        variantId: line.variantId,
        quantity: line.quantity,
        price: line.price,
        selected: line.selected !== false,
      });
    }
  }

  userCart.mergedGuestCarts.push(guest._id);
  await userCart.save();
  await guest.deleteOne();
}

async function findCart(req, { create = false } = {}) {
  const userId = req.user?._id;
  const sessionId = readSessionId(req);

  if (userId) {
    await mergeSessionCartIntoUser(userId, sessionId, req);
    let cart = await Cart.findOne(andFilter({ user: userId }, req.tenantFilter));
    if (!cart && create) cart = await Cart.create({ user: userId, items: [], ...(req.store?._id ? { storeId: req.store._id } : {}) });
    return cart;
  }

  if (sessionId) {
    let cart = await Cart.findOne(andFilter({ sessionId }, req.tenantFilter));
    if (!cart && create) cart = await Cart.create({ sessionId, items: [], ...(req.store?._id ? { storeId: req.store._id } : {}) });
    return cart;
  }

  return null;
}


async function presentCart(cart, req) {
  if (!cart) return { items: [] };
  const products = await Product.find(andFilter({ _id: { $in: cart.items.map(item => item.product) } }, req.tenantFilter)).populate('category', 'name');
  const lookup = new Map(products.map(product => [String(product._id), product]));
  return { _id: cart._id, items: cart.items.map(line => {
    const product = lookup.get(String(line.product));
    const visible = productAvailableForSale(product);
    const managed = Boolean(product?.variants?.length);
    const variant = visible && managed ? findVariant(product, line) : null;
    const unavailable = !visible || (managed && !variant);
    const stock = unavailable ? 0 : availableStock(product, line);
    const price = visible ? variantUnitPrice(product, variant) : Number(line.price || 0);
    return {
      ...line.toObject(), productId: String(line.product), selected: line.selected !== false,
      product: visible ? normalizeProductImages(product, req) : { _id: String(line.product), name: 'This product is no longer available', isActive: false, unavailable: true, images: [], stock: 0 },
      price, originalPrice: visible ? Math.max(price, variantUnitMrp(product, variant)) : price,
      previousPrice: Number(line.price || 0), availableStock: stock, unavailable,
      issue: unavailable ? 'This item or selection is no longer available.' : stock < line.quantity ? (stock ? 'Only ' + stock + ' left. Reduce the quantity to continue.' : 'This selection is out of stock.') : '',
    };
  }) };
}
async function changeCart(req, operation, { create = false } = {}) {
  requireCartIdentity(req);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const cart = await findCart(req, { create });
      if (!cart) return { items: [] };
      await operation(cart); await cart.save();
      return presentCart(cart, req);
    } catch (error) {
      // Retry concurrent changes against the newest document instead of overwriting it.
      if ((error.name === 'VersionError' || error.code === 11000) && attempt < 3) continue;
      throw error;
    }
  }
}
async function resolveSelection(productId, input, req) {
  const product = await Product.findOne(andFilter({ _id: requireObjectId(String(productId), 'product') }, req.tenantFilter)).populate('category', 'name');
  if (!productAvailableForSale(product)) throw notFound('This product is not available for sale yet');
  const size = String(input.size || '').trim(), color = String(input.color || '').trim();
  if (size.length > 60 || color.length > 100) throw new ApiError('VALIDATION_ERROR', 'Please choose a valid size and colour');
  let variant = null;
  if (product.variants?.length) {
    variant = requireVariant(product, input);
    if (!variant) throw new ApiError('VARIANT_UNAVAILABLE', 'This selection is no longer available');
  } else {
    const sizes = getSelectableProductSizes(product);
    if (sizes.length && !sizes.includes(size)) throw new ApiError('VARIANT_UNAVAILABLE', 'Please choose an available size');
    if (product.colors?.length && !product.colors.includes(color)) throw new ApiError('VARIANT_UNAVAILABLE', 'Please choose an available colour');
  }
  const selection = { size: variant?.size ?? size, color: variant?.color ?? color, variantId: variant ? variantId(variant) : '' };
  return { product, ...selection, stock: availableStock(product, selection), price: variantUnitPrice(product, variant) };
}
function checkQuantity(quantity, stock) {
  requireQuantity(quantity);
  if (quantity > stock) throw new ApiError('OUT_OF_STOCK', 'Only ' + stock + ' item' + (stock === 1 ? '' : 's') + ' available in stock', { details: { available: stock } });
}
function readIds(req) {
  const ids = req.body?.itemIds;
  if (!Array.isArray(ids) || !ids.length || ids.length > 200) throw new ApiError('VALIDATION_ERROR', 'Choose up to 200 bag items');
  return new Set(ids.map(id => String(requireObjectId(id, 'itemId'))));
}
exports.getCart = asyncHandler(async (req, res) => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try { return res.json(await presentCart(await findCart(req), req)); }
    catch (error) { if ((error.name === 'VersionError' || error.code === 11000) && attempt < 3) continue; throw error; }
  }
});
exports.addToCart = asyncHandler(async (req, res) => {
  const productId = req.body.product || req.body.productId;
  const quantity = requireQuantity(req.body.quantity ?? 1);
  res.status(201).json(await changeCart(req, async cart => {
    const next = await resolveSelection(productId, { ...req.body, variantId: req.body.variantId || req.body.selectedVariant }, req);
    const existing = cart.items.find(item => sameCartLine(item, productId, next.size, next.color, next.variantId));
    const total = quantity + Number(existing?.quantity || 0);
    checkQuantity(total, next.stock);
    if (existing) { existing.quantity = total; existing.price = next.price; existing.selected = true; }
    else cart.items.push({ product: productId, size: next.size, color: next.color, variantId: next.variantId, quantity, price: next.price, selected: true });
  }, { create: true }));
});
exports.updateCartItem = asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.itemId, 'itemId');
  res.json(await changeCart(req, async cart => {
    const item = cart.items.id(id);
    if (!item) throw notFound('Bag item not found. Refresh your bag.');
    const quantity = requireQuantity(req.body.quantity ?? item.quantity, 'quantity', { min: 0 });
    if (!quantity) { item.deleteOne(); return; }
    const changedOptions = ['size', 'color', 'variantId'].some(key => Object.prototype.hasOwnProperty.call(req.body, key));
    const next = await resolveSelection(item.product, {
      size: req.body.size ?? item.size, color: req.body.color ?? item.color,
      variantId: changedOptions ? req.body.variantId || '' : item.variantId,
    }, req);
    const duplicate = cart.items.find(row => String(row._id) !== String(item._id) && sameCartLine(row, item.product, next.size, next.color, next.variantId));
    const total = quantity + Number(duplicate?.quantity || 0);
    checkQuantity(total, next.stock);
    // Validate first, then save the replacement and any duplicate merge together.
    item.size = next.size; item.color = next.color; item.variantId = next.variantId; item.quantity = total; item.price = next.price;
    if (duplicate) { item.selected = item.selected !== false || duplicate.selected !== false; duplicate.deleteOne(); }
  }));
});
exports.selectCartItems = asyncHandler(async (req, res) => {
  const ids = readIds(req);
  if (typeof req.body.selected !== 'boolean') throw new ApiError('VALIDATION_ERROR', 'Selection must be true or false');
  res.json(await changeCart(req, cart => { cart.items.forEach(item => { if (ids.has(String(item._id))) item.selected = req.body.selected; }); }));
});
exports.removeCartItems = asyncHandler(async (req, res) => {
  const ids = readIds(req);
  res.json(await changeCart(req, cart => { cart.items = cart.items.filter(item => !ids.has(String(item._id))); }));
});
exports.removeCartItem = asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.itemId, 'itemId');
  res.json(await changeCart(req, cart => { cart.items.pull({ _id: id }); }));
});
exports.clearCart = asyncHandler(async (req, res) => res.json(await changeCart(req, cart => { cart.items = []; })));
function sameCartLine(item, productId, size, color, variantIdValue) {
  return String(item.product?._id || item.product) === String(productId)
    && String(item.size || '') === String(size || '') && String(item.color || '') === String(color || '')
    && String(item.variantId || '') === String(variantIdValue || '');
}
