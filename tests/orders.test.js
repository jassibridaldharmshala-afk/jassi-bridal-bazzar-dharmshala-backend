const test = require('node:test');
const assert = require('node:assert/strict');

const { request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createAdmin, createCoupon, createCustomer, createProduct, setSettings, validAddress } = require('./factories');
const Product = require('../models/Product');
const Order = require('../models/Order');
const Coupon = require('../models/Coupon');
const InventoryTransaction = require('../models/InventoryTransaction');
const ReturnExchange = require('../models/ReturnExchange');
const Shipment = require('../models/Shipment');
const Cart = require('../models/Cart');
const InventoryItem = require('../models/InventoryItem');
const { retryPendingCartCleanup } = require('../services/checkoutSafetyService');

test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(async () => {
  await resetDatabase();
  await setSettings();
});

function codOrderBody(product, overrides = {}) {
  return {
    orderItems: [{ product: String(product._id), quantity: 1, size: 'M', color: 'Red' }],
    shippingAddress: validAddress(),
    paymentMethod: 'COD',
    ...overrides,
  };
}

test('a COD order is priced from the database, not from the request', async t => {
  const queued = t.mock.method(require('../services/orderAlertService'), 'queueLater', () => {});
  const { token } = await createCustomer();
  const product = await createProduct({ price: 1200, originalPrice: 2000, stock: 5 });

  const { status, data } = await request('/api/orders/cod', {
    method: 'POST',
    token,
    body: {
      orderItems: [{ product: String(product._id), quantity: 2, price: 1, originalPrice: 1 }],
      shippingAddress: validAddress(),
      paymentMethod: 'COD',
      finalAmount: 1,
      totalMRP: 1,
    },
  });

  assert.equal(status, 201);
  assert.equal(queued.mock.callCount(), 1);
  assert.equal(String(queued.mock.calls[0].arguments[0]), String(data._id));
  assert.equal(data.orderItems[0].price, 1200);
  assert.equal(data.totalMRP, 4000);
  // 2 x 1200 = 2400, above the 999 free-shipping threshold.
  assert.equal(data.deliveryCharge, 0);
  assert.equal(data.finalAmount, 2400);
});

test('placing a COD order deducts stock exactly once and writes a ledger entry', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ stock: 5 });

  const { status, data } = await request('/api/orders/cod', { method: 'POST', token, body: codOrderBody(product) });
  assert.equal(status, 201);

  const refreshed = await Product.findById(product._id);
  assert.equal(refreshed.stock, 4);

  const ledger = await InventoryTransaction.find({ order: data._id });
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].type, 'SALE');
  assert.equal(ledger[0].quantity, -1);
  assert.equal(ledger[0].stockAfter, 4);
});

test('a repeated COD checkout attempt creates one order and deducts stock once', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ stock: 5 });
  const body = codOrderBody(product, { checkoutAttemptId: 'checkout_same_cod_001' });
  const results = await Promise.all([
    request('/api/orders/cod', { method: 'POST', token, body }),
    request('/api/orders/cod', { method: 'POST', token, body }),
  ]);
  assert.ok(results.every(result => [200, 201].includes(result.status)), JSON.stringify(results));
  assert.equal(String(results[0].data._id), String(results[1].data._id));
  assert.equal(await Order.countDocuments(), 1);
  assert.equal((await Product.findById(product._id)).stock, 4);
});

test('the generic order endpoint cannot bypass online payment creation', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ stock: 5 });
  const result = await request('/api/orders', { method: 'POST', token, body: codOrderBody(product, { paymentMethod: 'UPI' }) });
  assert.equal(result.status, 400);
  assert.equal(result.data.code, 'PAYMENT_METHOD_UNAVAILABLE');
  assert.equal(await Order.countDocuments(), 0);
  assert.equal((await Product.findById(product._id)).stock, 5);
});

test('successful COD checkout consumes only the purchased server cart line', async () => {
  const { token } = await createCustomer();
  const purchased = await createProduct({ stock: 5 });
  const saved = await createProduct({ stock: 5 });
  const first = await request('/api/cart', { method: 'POST', token, body: { product: String(purchased._id), quantity: 1, size: 'M', color: 'Red' } });
  await request('/api/cart', { method: 'POST', token, body: { product: String(saved._id), quantity: 1, size: 'M', color: 'Red' } });
  const line = first.data.items.find(item => String(item.productId) === String(purchased._id));
  const placed = await request('/api/orders/cod', { method: 'POST', token, body: codOrderBody(purchased, {
    checkoutAttemptId: 'checkout_cart_cleanup_001',
    cartItems: [{ cartItemId: line._id, product: String(purchased._id), size: 'M', color: 'Red', quantity: 1 }],
  }) });
  assert.equal(placed.status, 201, JSON.stringify(placed.data));
  const cart = await request('/api/cart', { token });
  assert.equal(cart.data.items.length, 1);
  assert.equal(String(cart.data.items[0].productId), String(saved._id));
});

test('pending server cart cleanup is retried without consuming the same checkout twice', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ stock: 5 });
  const initial = await request('/api/cart', { method: 'POST', token, body: { product: String(product._id), quantity: 2, size: 'M', color: 'Red' } });
  const line = initial.data.items.find(item => String(item.productId) === String(product._id));
  const placed = await request('/api/orders/cod', { method: 'POST', token, body: codOrderBody(product, {
    checkoutAttemptId: 'checkout_cart_retry_001',
    cartItems: [{ cartItemId: line._id, product: String(product._id), size: 'M', color: 'Red', quantity: 1 }],
  }) });
  assert.equal(placed.status, 201, JSON.stringify(placed.data));

  const storedOrder = await Order.findById(placed.data._id).select('+checkoutCartItems');
  const storedCart = await Cart.findOne({ user: storedOrder.user });
  storedCart.items[0].quantity = 2;
  storedCart.checkoutConsumptions = [];
  await storedCart.save();
  await Order.updateOne({ _id: storedOrder._id }, { $set: { cartCleanupStatus: 'PENDING' } });

  assert.deepEqual(await retryPendingCartCleanup(), { scanned: 1, completed: 1, failed: 0 });
  assert.deepEqual(await retryPendingCartCleanup(), { scanned: 0, completed: 0, failed: 0 });
  const cleaned = await Cart.findById(storedCart._id);
  assert.equal(cleaned.items[0].quantity, 1);
  assert.deepEqual(cleaned.checkoutConsumptions, ['checkout_cart_retry_001']);
});

test('an order for more than the available stock is rejected', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ stock: 2 });

  const { status, data } = await request('/api/orders/cod', {
    method: 'POST',
    token,
    body: codOrderBody(product, { orderItems: [{ product: String(product._id), quantity: 5 }] }),
  });

  assert.equal(status, 409);
  assert.equal(data.code, 'OUT_OF_STOCK');
  assert.equal(await Order.countDocuments(), 0);
  assert.equal((await Product.findById(product._id)).stock, 2);
});

test('two simultaneous checkouts for the last unit: only one succeeds', async () => {
  const productA = await createProduct({ stock: 1 });
  const first = await createCustomer();
  const second = await createCustomer();

  const [resultA, resultB] = await Promise.all([
    request('/api/orders/cod', { method: 'POST', token: first.token, body: codOrderBody(productA) }),
    request('/api/orders/cod', { method: 'POST', token: second.token, body: codOrderBody(productA) }),
  ]);

  const statuses = [resultA.status, resultB.status].sort();
  assert.deepEqual(statuses, [201, 409], 'exactly one checkout must win the last unit');

  const refreshed = await Product.findById(productA._id);
  assert.equal(refreshed.stock, 0, 'stock must never go negative');
  assert.equal(await Order.countDocuments(), 1);
});

test('a multi-item order that runs out on the second item leaves stock untouched', async () => {
  const { token } = await createCustomer();
  const inStock = await createProduct({ stock: 10 });
  const shortStock = await createProduct({ stock: 1 });

  const { status } = await request('/api/orders/cod', {
    method: 'POST',
    token,
    body: codOrderBody(inStock, {
      orderItems: [
        { product: String(inStock._id), quantity: 2 },
        { product: String(shortStock._id), quantity: 4 },
      ],
    }),
  });

  assert.equal(status, 409);
  assert.equal((await Product.findById(inStock._id)).stock, 10, 'the first item must be rolled back');
  assert.equal((await Product.findById(shortStock._id)).stock, 1);
  assert.equal(await Order.countDocuments(), 0);
});

test('cancelling an order restores stock exactly once', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ stock: 5 });

  const created = await request('/api/orders/cod', { method: 'POST', token, body: codOrderBody(product) });
  assert.equal((await Product.findById(product._id)).stock, 4);

  const cancelled = await request(`/api/orders/${created.data._id}/cancel`, { method: 'POST', token, body: {} });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.orderStatus, 'Cancelled');
  assert.equal((await Product.findById(product._id)).stock, 5);

  const again = await request(`/api/orders/${created.data._id}/cancel`, { method: 'POST', token, body: {} });
  assert.equal(again.status, 200);
  assert.equal((await Product.findById(product._id)).stock, 5, 'a repeat cancellation must not restock twice');

  const restores = await InventoryTransaction.find({ order: created.data._id, type: 'CANCELLATION' });
  assert.equal(restores.length, 1);
});

test('concurrent cancellations restore stock only once', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ stock: 5 });
  const created = await request('/api/orders/cod', { method: 'POST', token, body: codOrderBody(product) });

  await Promise.all([
    request(`/api/orders/${created.data._id}/cancel`, { method: 'POST', token, body: {} }),
    request(`/api/orders/${created.data._id}/cancel`, { method: 'POST', token, body: {} }),
  ]);

  assert.equal((await Product.findById(product._id)).stock, 5);
  assert.equal((await InventoryTransaction.find({ order: created.data._id, type: 'CANCELLATION' })).length, 1);
});

test('a delivered order cannot be cancelled', async () => {
  const { token } = await createCustomer();
  const admin = await createAdmin();
  const product = await createProduct({ stock: 5 });
  const created = await request('/api/orders/cod', { method: 'POST', token, body: codOrderBody(product) });

  await Order.updateOne({ _id: created.data._id }, { $set: { orderStatus: 'Delivered', deliveredAt: new Date() } });

  const { status, data } = await request(`/api/orders/${created.data._id}/cancel`, { method: 'POST', token, body: {} });
  assert.equal(status, 409);
  assert.equal(data.code, 'ORDER_NOT_CANCELLABLE');
  assert.equal((await Product.findById(product._id)).stock, 4, 'stock must stay deducted for a delivered order');
});

test('fulfilment follows the safe sequence and rejects a stale revision', async () => {
  const { token } = await createCustomer();
  const admin = await createAdmin();
  const product = await createProduct({ stock: 5 });
  const created = await request('/api/orders/cod', { method: 'POST', token, body: codOrderBody(product) });
  const detail = await request(`/api/admin/orders/${created.data._id}`, { token: admin.token });
  assert.ok(detail.data.allowedActions.includes('CONFIRM_ORDER'));
  const summary = await request('/api/admin/orders/workspace-summary', { token: admin.token });
  assert.equal(summary.status, 200); assert.equal(summary.data.pending, 1);

  const skipped = await request(`/api/admin/orders/${created.data._id}/status`, { method: 'PUT', token: admin.token, body: { orderStatus: 'Delivered', revision: 0 } });
  assert.equal(skipped.status, 409); assert.equal(skipped.data.code, 'ORDER_TRANSITION_INVALID');

  const confirmed = await request(`/api/admin/orders/${created.data._id}/status`, { method: 'PUT', token: admin.token, body: { orderStatus: 'Confirmed', revision: 0 } });
  assert.equal(confirmed.status, 200); assert.equal(confirmed.data.revision, 1);
  const packingSummary = await request('/api/admin/orders/workspace-summary', { token: admin.token });
  assert.equal(packingSummary.data.todayPacking, 1);
  const stale = await request(`/api/admin/orders/${created.data._id}/status`, { method: 'PUT', token: admin.token, body: { orderStatus: 'Packed', revision: 0 } });
  assert.equal(stale.status, 409); assert.equal(stale.data.code, 'ORDER_CHANGED');
});

test('private notes and pre-booking address corrections are revision-safe', async () => {
  const customer = await createCustomer();
  const admin = await createAdmin();
  const product = await createProduct({ stock: 5 });
  const created = await request('/api/orders/cod', { method: 'POST', token: customer.token, body: codOrderBody(product) });

  const noted = await request(`/api/admin/orders/${created.data._id}/staff-notes`, {
    method: 'PATCH', token: admin.token, body: { text: 'Customer confirmed the landmark.', revision: 0 },
  });
  assert.equal(noted.status, 200); assert.equal(noted.data.revision, 1);
  assert.equal(noted.data.staffNotes[0].text, 'Customer confirmed the landmark.');

  const customerView = await request(`/api/orders/${created.data._id}`, { token: customer.token });
  assert.equal(customerView.data.staffNotes, undefined, 'private staff notes must never reach the customer');

  const correctedAddress = validAddress({ houseNo: '22B', landmark: 'Opposite City Mall' });
  const corrected = await request(`/api/admin/orders/${created.data._id}/shipping-address`, {
    method: 'PUT', token: admin.token, body: { shippingAddress: correctedAddress, reason: 'Customer corrected the house number', revision: 1 },
  });
  assert.equal(corrected.status, 200); assert.equal(corrected.data.revision, 2);
  assert.equal(corrected.data.shippingAddress.houseNo, '22B');

  const stale = await request(`/api/admin/orders/${created.data._id}/staff-notes`, {
    method: 'PATCH', token: admin.token, body: { text: 'Stale note', revision: 1 },
  });
  assert.equal(stale.status, 409); assert.equal(stale.data.code, 'ORDER_CHANGED');
});

test('completed COD returns can record cumulative refund payments with a remaining balance', async () => {
  const customer = await createCustomer();
  const admin = await createAdmin();
  const product = await createProduct({ stock: 5, price: 1200 });
  const created = await request('/api/orders/cod', { method: 'POST', token: customer.token, body: codOrderBody(product) });
  await Order.updateOne({ _id: created.data._id }, { $set: { orderStatus: 'Delivered', deliveredAt: new Date() } });
  const paid = await request(`/api/admin/orders/${created.data._id}/payment-status`, {
    method: 'PUT', token: admin.token, body: { paymentStatus: 'Paid', note: 'COD received at delivery', revision: 0 },
  });
  assert.equal(paid.status, 200); assert.equal(paid.data.paymentStatus, 'Paid');
  const premature = await request(`/api/admin/orders/${created.data._id}/payment-status`, {
    method: 'PUT', token: admin.token, body: { paymentStatus: 'Refunded', amount: 300, note: 'Refund attempted before return completion', revision: 1 },
  });
  assert.equal(premature.status, 409); assert.equal(premature.data.code, 'PAYMENT_TRANSITION_INVALID');
  const stored = await Order.findById(created.data._id);
  await ReturnExchange.create({ order: stored._id, product: product._id, user: customer.user._id, orderItemId: String(stored.orderItems[0]._id), quantity: 1, type: 'return', reason: 'Returned item', status: 'Refunded', resolutionStatus: 'Refunded', storeId: stored.storeId });

  const detail = await request(`/api/admin/orders/${stored._id}`, { token: admin.token });
  assert.ok(detail.data.allowedActions.includes('RECORD_COD_REFUND'));
  const partial = await request(`/api/admin/orders/${stored._id}/payment-status`, {
    method: 'PUT', token: admin.token, body: { paymentStatus: 'Refunded', amount: 300, reference: 'cash-refund-1', note: 'First refund instalment paid', revision: 1 },
  });
  assert.equal(partial.status, 200); assert.equal(partial.data.paymentStatus, 'Paid');
  assert.equal(partial.data.paymentState, 'PARTIALLY_REFUNDED'); assert.equal(partial.data.refundedAmount, 300);
  assert.equal(partial.data.refunds[0].provider, 'manual');

  const balance = Number(partial.data.finalAmount) - 300;
  const completed = await request(`/api/admin/orders/${stored._id}/payment-status`, {
    method: 'PUT', token: admin.token, body: { paymentStatus: 'Refunded', amount: balance, reference: 'cash-refund-2', note: 'Remaining refund paid', revision: 2 },
  });
  assert.equal(completed.status, 200); assert.equal(completed.data.paymentStatus, 'Refunded');
  assert.equal(completed.data.paymentState, 'REFUNDED'); assert.equal(completed.data.refundedAmount, partial.data.finalAmount);
  assert.equal(completed.data.refunds.length, 2);
});

test('delivery exception follow-ups are audited for staff and hidden from customers', async () => {
  const customer = await createCustomer();
  const admin = await createAdmin();
  const product = await createProduct({ stock: 5 });
  const created = await request('/api/orders/cod', { method: 'POST', token: customer.token, body: codOrderBody(product) });
  const shipment = await Shipment.create({ order: created.data._id, provider: 'manual', courierName: 'Local courier', status: 'EXCEPTION', bookingState: 'BOOKED', awb: 'ISSUE-AWB-1', trackingNumber: 'ISSUE-AWB-1', storeId: created.data.storeId });
  await Order.updateOne({ _id: created.data._id }, { $set: { shipment: shipment._id, orderStatus: 'Shipped' } });

  const detail = await request(`/api/admin/orders/${created.data._id}`, { token: admin.token });
  assert.ok(detail.data.allowedActions.includes('RESOLVE_DELIVERY_EXCEPTION'));
  const result = await request(`/api/admin/orders/${created.data._id}/delivery/exception`, {
    method: 'POST', token: admin.token, body: { action: 'REQUESTED_REDELIVERY', reference: 'NDR-22', note: 'Customer confirmed the complete address and next-day availability.' },
  });
  assert.equal(result.status, 200);
  assert.equal(result.data.shipment.exceptionActions[0].action, 'REQUESTED_REDELIVERY');
  assert.equal(result.data.shipment.exceptionActions[0].reference, 'NDR-22');

  const customerDelivery = await request(`/api/orders/${created.data._id}/delivery`, { token: customer.token });
  assert.equal(customerDelivery.status, 200);
  assert.equal(customerDelivery.data.shipment.exceptionActions, undefined);
});

test('a customer cannot cancel or read another customer order', async () => {
  const owner = await createCustomer();
  const stranger = await createCustomer();
  const product = await createProduct({ stock: 5 });
  const created = await request('/api/orders/cod', { method: 'POST', token: owner.token, body: codOrderBody(product) });

  const read = await request(`/api/orders/${created.data._id}`, { token: stranger.token });
  assert.equal(read.status, 403);

  const cancel = await request(`/api/orders/${created.data._id}/cancel`, { method: 'POST', token: stranger.token, body: {} });
  assert.equal(cancel.status, 403);
});

test('checkout is blocked until the mobile number is verified', async () => {
  const { token } = await createCustomer({ isPhoneVerified: false });
  const product = await createProduct({ stock: 5 });

  const { status } = await request('/api/orders/cod', { method: 'POST', token, body: codOrderBody(product) });
  assert.equal(status, 403);
});

test('an order without a valid address is rejected', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ stock: 5 });

  const { status, data } = await request('/api/orders/cod', {
    method: 'POST',
    token,
    body: codOrderBody(product, { shippingAddress: { fullName: 'No Pincode', mobile: '9000000001' } }),
  });

  assert.equal(status, 400);
  assert.equal(data.code, 'VALIDATION_ERROR');
  assert.equal(await Order.countDocuments(), 0);
});

test('an inactive product cannot be ordered', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ stock: 5, isActive: false });

  const { status } = await request('/api/orders/cod', { method: 'POST', token, body: codOrderBody(product) });
  assert.equal(status, 409);
});

test('coupon usage is consumed on order and released on cancellation, once', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ price: 1000, stock: 5 });
  const coupon = await createCoupon({ type: 'Flat', discountValue: 200 });

  const created = await request('/api/orders/cod', {
    method: 'POST',
    token,
    body: codOrderBody(product, { coupon: { code: coupon.code } }),
  });

  assert.equal(created.status, 201);
  assert.equal(created.data.couponDiscount, 200);
  assert.equal(created.data.finalAmount, 800);
  assert.equal((await Coupon.findById(coupon._id)).usedCount, 1);

  await request(`/api/orders/${created.data._id}/cancel`, { method: 'POST', token, body: {} });
  assert.equal((await Coupon.findById(coupon._id)).usedCount, 0);

  await request(`/api/orders/${created.data._id}/cancel`, { method: 'POST', token, body: {} });
  assert.equal((await Coupon.findById(coupon._id)).usedCount, 0, 'a repeat cancellation must not release twice');
});

test('a client-supplied coupon discount is ignored', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ price: 1000, stock: 5 });
  const coupon = await createCoupon({ type: 'Flat', discountValue: 100 });

  const { data } = await request('/api/orders/cod', {
    method: 'POST',
    token,
    body: codOrderBody(product, { coupon: { code: coupon.code, discount: 999, discountAmount: 999 }, couponDiscount: 999 }),
  });

  assert.equal(data.couponDiscount, 100);
  assert.equal(data.finalAmount, 900);
});

test('an expired coupon is rejected at checkout', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ price: 1000, stock: 5 });
  const coupon = await createCoupon({ expiryDate: new Date(Date.now() - 1000) });

  const { status, data } = await request('/api/orders/cod', {
    method: 'POST',
    token,
    body: codOrderBody(product, { coupon: { code: coupon.code } }),
  });

  assert.equal(status, 400);
  assert.equal(data.code, 'COUPON_EXPIRED');
  assert.equal(await Order.countDocuments(), 0);
});

test('deleting an order cancels it instead of destroying the record', async () => {
  const { token } = await createCustomer();
  const admin = await createAdmin();
  const product = await createProduct({ stock: 5 });
  const created = await request('/api/orders/cod', { method: 'POST', token, body: codOrderBody(product) });

  const { status } = await request(`/api/admin/orders/${created.data._id}`, { method: 'DELETE', token: admin.token });
  assert.equal(status, 200);

  const stored = await Order.findById(created.data._id);
  assert.ok(stored, 'order history must be preserved');
  assert.equal(stored.orderStatus, 'Cancelled');
  assert.equal((await Product.findById(product._id)).stock, 5);
});

test('the quote endpoint includes platform fee and inclusive GST when configured', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ price: 1050, originalPrice: 1200, stock: 5 });
  await setSettings({ deliveryCharge: 0, freeShippingMinAmount: 0, platformFee: 23, gstRate: 5, codCharge: 0 });

  const { status, data } = await request('/api/orders/quote', {
    method: 'POST',
    token,
    body: { orderItems: [{ product: String(product._id), quantity: 1 }], paymentMethod: 'COD' },
  });

  assert.equal(status, 200);
  assert.equal(data.totals.platformFee, 23);
  assert.equal(data.totals.taxRate, 5);
  assert.equal(data.totals.taxAmount, 50);
  assert.equal(data.totals.finalAmount, 1073);
});

test('the quote endpoint returns backend totals and allowed payment methods', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ price: 500, originalPrice: 800, stock: 5 });
  await setSettings({ codEnabled: true, codCharge: 49, razorpayEnabled: false });

  const { status, data } = await request('/api/orders/quote', {
    method: 'POST',
    token,
    body: { orderItems: [{ product: String(product._id), quantity: 1 }], paymentMethod: 'COD' },
  });

  assert.equal(status, 200);
  assert.equal(data.totals.codCharge, 49);
  assert.equal(data.totals.deliveryCharge, 99);
  assert.equal(data.totals.finalAmount, 500 + 99 + 49);
  assert.ok(data.paymentOptions.some((option) => option.key === 'COD'));
});

test('coupon-discounted invoice line taxes add up exactly to the charged inclusive GST', async () => {
  const { token } = await createCustomer();
  const first = await createProduct({ price: 1050, originalPrice: 1200 });
  const second = await createProduct({ price: 525, originalPrice: 700 });
  const coupon = await createCoupon({ discountValue: 175 });
  await setSettings({ gstRate: 5, deliveryCharge: 0 });
  const { status, data } = await request('/api/orders/cod', {
    method: 'POST', token,
    body: codOrderBody(first, {
      orderItems: [{ product: String(first._id), quantity: 1 }, { product: String(second._id), quantity: 1 }],
      coupon: { code: coupon.code },
    }),
  });
  assert.equal(status, 201);
  assert.equal(data.taxAmount, 66.67);
  assert.equal(Math.round(data.orderItems.reduce((sum, item) => sum + item.tax, 0) * 100), 6667);
  assert.ok(data.orderItems.every((item) => item.tax >= 0));
});

test('checkout honors its resolved store when loading authoritative product rows', async () => {
  const product = await createProduct();
  const { buildOrderDraft } = require('../services/orderPricingService');
  await assert.rejects(buildOrderDraft({
    orderItems: [{ product: String(product._id), quantity: 1 }],
    tenantFilter: { storeId: '0123456789abcdef11111111' },
  }), (error) => error.errorCode === 'NOT_FOUND');
});

test('protected orders cannot be packed until every physical unit is verified', async () => {
  await setSettings({ requireProductQrScan: true, highValueVerificationThreshold: 0 });
  const customer = await createCustomer();
  const admin = await createAdmin();
  const product = await createProduct({ stock: 5 });
  const created = await request('/api/orders/cod', { method: 'POST', token: customer.token, body: codOrderBody(product, { orderItems: [{ product: String(product._id), quantity: 2, size: 'M', color: 'Red' }] }) });
  assert.equal(created.status, 201, JSON.stringify(created.data));

  let current = await Order.findById(created.data._id);
  const confirmed = await request(`/api/admin/orders/${current._id}/status`, { method: 'PUT', token: admin.token, body: { orderStatus: 'Confirmed', revision: current.revision } });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));
  current = await Order.findById(current._id);
  const blocked = await request(`/api/admin/orders/${current._id}/status`, { method: 'PUT', token: admin.token, body: { orderStatus: 'Packed', revision: current.revision } });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.code, 'PACKING_VERIFICATION_REQUIRED');

  const labels = await request(`/api/admin/orders/${current._id}/item-identities/generate`, { method: 'POST', token: admin.token, body: {} });
  assert.equal(labels.status, 201, JSON.stringify(labels.data));
  assert.equal(labels.data.items.length, 2);
  assert.equal(new Set(labels.data.items.map(item => item.uniqueItemId)).size, 2);
  assert.ok(labels.data.items.every(item => item.barcodeDataUrl.startsWith('data:image/svg+xml;base64,')));

  current = await Order.findById(current._id);
  const verification = await request(`/api/admin/orders/${current._id}/packing/verify`, {
    method: 'POST', token: admin.token,
    body: { items: [{ orderItemId: String(current.orderItems[0]._id), uniqueItemIds: current.orderItems[0].uniqueItemIds }] },
  });
  assert.equal(verification.status, 200, JSON.stringify(verification.data));
  current = await Order.findById(current._id);
  assert.equal(current.packageVerification.status, 'VERIFIED');
  assert.equal((await InventoryItem.countDocuments({ order: current._id, status: 'PACKED' })), 2);
  const packed = await request(`/api/admin/orders/${current._id}/status`, { method: 'PUT', token: admin.token, body: { orderStatus: 'Packed', revision: current.revision } });
  assert.equal(packed.status, 200, JSON.stringify(packed.data));
});
