const crypto = require('node:crypto');
const Cart = require('../models/Cart');
const Order = require('../models/Order');
const CheckoutAttempt = require('../models/CheckoutAttempt');
const { ApiError } = require('../utils/apiError');

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((result, key) => {
    if (value[key] !== undefined) result[key] = canonical(value[key]);
    return result;
  }, {});
}

function checkoutAttemptId(req) {
  const raw = String(req.body?.checkoutAttemptId || req.headers?.['idempotency-key'] || '').trim();
  if (!/^[A-Za-z0-9:_-]{12,120}$/.test(raw)) {
    throw new ApiError('VALIDATION_ERROR', 'This checkout session is no longer valid. Refresh checkout and try again.');
  }
  return raw;
}

function checkoutFingerprint(body = {}, paymentMethod) {
  const items = Array.isArray(body.orderItems) ? body.orderItems.map(item => ({
    product: String(item?.product || item?.productId || ''),
    variantId: String(item?.variantId || item?.selectedVariant || ''),
    size: String(item?.size || ''),
    color: String(item?.color || ''),
    quantity: Number(item?.quantity || 0),
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : [];
  const address = body.shippingAddress || {};
  const value = canonical({
    paymentMethod: String(paymentMethod || body.paymentMethod || '').toUpperCase(),
    items,
    couponCode: String(body.coupon?.code || body.couponCode || '').trim().toUpperCase(),
    address: {
      fullName: String(address.fullName || '').trim(), mobile: String(address.mobile || address.phone || '').replace(/\D/g, ''),
      pincode: String(address.pincode || '').replace(/\D/g, ''), state: String(address.state || '').trim(), city: String(address.city || '').trim(),
      houseNo: String(address.houseNo || address.houseNumber || '').trim(), area: String(address.area || '').trim(), landmark: String(address.landmark || '').trim(),
    },
  });
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function checkoutCartItems(body = {}) {
  if (!Array.isArray(body.cartItems)) return [];
  return body.cartItems.slice(0, 200).map(item => ({
    cartItemId: String(item?.cartItemId || item?.id || '').trim(),
    product: item?.product || item?.productId,
    size: String(item?.size || ''), color: String(item?.color || ''), variantId: String(item?.variantId || ''),
    quantity: Math.max(1, Math.min(20, Number(item?.quantity || 1))),
  })).filter(item => /^[a-f\d]{24}$/i.test(item.cartItemId) && /^[a-f\d]{24}$/i.test(String(item.product || '')));
}

async function findCheckoutReplay({ userId, attemptId, fingerprint }) {
  // The API can receive requests before Mongoose's background index build
  // finishes. Deduplication is only safe once the unique attempt index exists.
  await Order.init();
  const order = await Order.findOne({ user: userId, checkoutAttemptId: attemptId }).select('+checkoutFingerprint +checkoutCartItems');
  if (!order) return null;
  if (order.checkoutFingerprint && order.checkoutFingerprint !== fingerprint) {
    throw new ApiError('DUPLICATE_REQUEST', 'This checkout attempt belongs to a different bag. Refresh checkout and try again.', { statusCode: 409 });
  }
  return order;
}

async function beginPaymentAttempt({ userId, storeId, attemptId, fingerprint }) {
  await CheckoutAttempt.init();
  try {
    const attempt = await CheckoutAttempt.create({ user: userId, storeId: storeId || undefined, attemptId, fingerprint, status: 'PROCESSING' });
    return { owned: true, attempt };
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
  }
  for (let retry = 0; retry < 40; retry += 1) {
    const attempt = await CheckoutAttempt.findOne({ user: userId, attemptId }).select('+fingerprint');
    if (!attempt) throw new ApiError('DUPLICATE_REQUEST', 'This payment attempt could not be recovered. Refresh checkout and try again.', { statusCode: 409 });
    if (attempt.fingerprint !== fingerprint) throw new ApiError('DUPLICATE_REQUEST', 'This checkout attempt belongs to a different bag. Refresh checkout and try again.', { statusCode: 409 });
    if (attempt.status === 'READY' && attempt.order) return { owned: false, attempt, order: await Order.findById(attempt.order).select('+checkoutFingerprint +checkoutCartItems') };
    if (attempt.status === 'FAILED') throw new ApiError('DUPLICATE_REQUEST', 'This payment attempt has ended. Refresh checkout and try again.', { statusCode: 409 });
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new ApiError('DUPLICATE_REQUEST', 'This payment is already being prepared. Please wait a moment and retry.', { statusCode: 409 });
}

async function finishPaymentAttempt(attemptId, userId, { order, providerOrderId } = {}) {
  await CheckoutAttempt.updateOne({ user: userId, attemptId, status: 'PROCESSING' }, { $set: { status: 'READY', order, providerOrderId, failureCode: '' } });
}

async function failPaymentAttempt(attemptId, userId, error) {
  await CheckoutAttempt.updateOne({ user: userId, attemptId, status: 'PROCESSING' }, { $set: { status: 'FAILED', failureCode: String(error?.errorCode || error?.code || 'PAYMENT_SETUP_FAILED').slice(0, 80) } }).catch(() => null);
}

function isDuplicateKey(error) {
  return Number(error?.code) === 11000 || Number(error?.cause?.code) === 11000;
}

function sameLine(line, snapshot) {
  return String(line._id) === String(snapshot.cartItemId)
    && String(line.product?._id || line.product) === String(snapshot.product)
    && String(line.size || '') === String(snapshot.size || '')
    && String(line.color || '') === String(snapshot.color || '')
    && String(line.variantId || '') === String(snapshot.variantId || '');
}

async function consumePurchasedCart(orderOrId) {
  const order = orderOrId?._id
    ? orderOrId
    : await Order.findById(orderOrId).select('+checkoutCartItems');
  if (!order || order.cartCleanupStatus === 'COMPLETE') return order;
  const attemptId = String(order.checkoutAttemptId || '').trim();
  const snapshots = Array.isArray(order.checkoutCartItems) ? order.checkoutCartItems : [];
  if (!attemptId || !snapshots.length) {
    await Order.updateOne({ _id: order._id }, { $set: { cartCleanupStatus: 'NOT_REQUIRED' } });
    return order;
  }

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const filter = { user: order.user, ...(order.storeId ? { storeId: order.storeId } : {}) };
      const cart = await Cart.findOne(filter);
      if (cart && !(cart.checkoutConsumptions || []).includes(attemptId)) {
        for (const snapshot of snapshots) {
          const line = cart.items.find(item => sameLine(item, snapshot));
          if (!line) continue;
          const remaining = Number(line.quantity || 0) - Number(snapshot.quantity || 0);
          if (remaining > 0) line.quantity = remaining;
          else line.deleteOne();
        }
        cart.checkoutConsumptions = [...(cart.checkoutConsumptions || []), attemptId].slice(-100);
        await cart.save();
      }
      await Order.updateOne({ _id: order._id }, { $set: { cartCleanupStatus: 'COMPLETE', cartCleanupAt: new Date() } });
      return order;
    } catch (error) {
      if (error.name === 'VersionError' && attempt < 3) continue;
      await Order.updateOne({ _id: order._id }, { $set: { cartCleanupStatus: 'PENDING' } }).catch(() => null);
      throw error;
    }
  }
  return order;
}

async function retryPendingCartCleanup({ limit = 50 } = {}) {
  const batchSize = Math.max(1, Math.min(200, Number(limit) || 50));
  const orders = await Order.find({
    cartCleanupStatus: 'PENDING',
    checkoutAttemptId: { $exists: true, $type: 'string', $ne: '' },
  }).select('+checkoutCartItems').sort({ createdAt: 1 }).limit(batchSize);
  let completed = 0;
  let failed = 0;
  for (const order of orders) {
    try {
      await consumePurchasedCart(order);
      completed += 1;
    } catch {
      failed += 1;
    }
  }
  return { scanned: orders.length, completed, failed };
}

module.exports = { beginPaymentAttempt, checkoutAttemptId, checkoutFingerprint, checkoutCartItems, consumePurchasedCart, failPaymentAttempt, findCheckoutReplay, finishPaymentAttempt, isDuplicateKey, retryPendingCartCleanup };
