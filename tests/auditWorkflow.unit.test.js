// Isolated controller tests. No database connection, listener, SMS or gateway.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const AuditLog = require('../models/AuditLog');
const Product = require('../models/Product');
const Order = require('../models/Order');
const Coupon = require('../models/Coupon');
const Notification = require('../models/Notification');
const Shipment = require('../models/Shipment');
const delivery = require('../services/deliveryService');
const inventory = require('../services/inventoryService');

const ID = '0123456789abcdef01234567';
const STORE = new mongoose.Types.ObjectId('0123456789abcdef01234568');
const USER = '0123456789abcdef01234569';
const req = (body = {}) => ({ user: { _id: USER, name: 'Manager', role: 'admin', activeMode: 'admin' }, body, params: { id: ID }, requestId: 'workflow-request', tenantFilter: { storeId: STORE }, store: { _id: STORE }, storeMember: { role: 'OWNER' } });
function res() { return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } }; }
function capture(t) {
  const events = [];
  t.mock.method(AuditLog, 'create', async (value) => { events.push(value); return value; });
  t.mock.method(Notification, 'insertMany', async () => []);
  return events;
}
function bypassCourier(t, order) {
  t.mock.method(delivery, 'withOrderLock', async (_orderId, action) => action(order));
  t.mock.method(delivery, 'cancelBooking', async () => null);
}
function doc(fields) { return { ...fields, toObject() { const { toObject, save, ...value } = this; return value; }, async save() { return this; } }; }

test('product visibility records real before/after and respects store scope', async (t) => {
  const events = capture(t); let filter;
  const product = doc({ _id: ID, storeId: STORE, isActive: true });
  t.mock.method(Product, 'findOne', async (value) => { filter = value; return product; });
  const response = res();
  await require('../controllers/productController').updateStatus(req({ isActive: false }), response, (error) => { throw error; });
  assert.equal(response.body.isActive, false);
  assert.ok(JSON.stringify(filter).includes(String(STORE)));
  assert.equal(events.length, 1); assert.equal(events[0].before.isActive, true);
  assert.equal(events[0].after.isActive, false); assert.equal(events[0].requestId, 'workflow-request');
});
test('failed product save produces no successful change event', async (t) => {
  const events = capture(t);
  t.mock.method(Product, 'findOne', async () => ({ isActive: true, save: async () => { throw new Error('write failed'); } }));
  let error;
  await require('../controllers/productController').updateStatus(req({ isActive: false }), res(), (value) => { error = value; });
  assert.equal(error.message, 'write failed'); assert.equal(events.length, 0);
});
test('missing product is reported and not logged as a successful change', async (t) => {
  const events = capture(t); t.mock.method(Product, 'findOne', async () => null);
  const response = res();
  await require('../controllers/productController').updateStatus(req({ isActive: false }), response, (error) => { throw error; });
  assert.equal(response.statusCode, 404); assert.equal(events.length, 0);
});
test('order status changes are logged only after an atomic valid transition', async (t) => {
  const events = capture(t);
  const order = doc({ _id: ID, storeId: STORE, orderStatus: 'Pending', paymentMethod: 'COD', paymentStatus: 'Pending', revision: 0, statusTimeline: [] });
  const confirmed = doc({ ...order, orderStatus: 'Confirmed', codConfirmationStatus: 'CONFIRMED', revision: 1 });
  t.mock.method(require('../services/deliveryService'), 'withOrderLock', async (_id, action) => action(order));
  t.mock.method(Order, 'findOne', async () => order);
  t.mock.method(Shipment, 'findOne', async () => null);
  t.mock.method(Order, 'findOneAndUpdate', async (_filter, _update, options) => {
    assert.equal(events.length, 0); assert.equal(options.new, true); return confirmed;
  });
  t.mock.method(Order, 'findById', () => ({ populate: async () => confirmed }));
  const response = res();
  await require('../controllers/orderController').updateOrderStatus(req({ orderStatus: 'Confirmed' }), response, (error) => { throw error; });
  assert.equal(events.length, 1); assert.equal(events[0].before.orderStatus, 'Pending'); assert.equal(events[0].after.orderStatus, 'Confirmed');
  assert.equal(response.body.orderStatus, 'Confirmed');
});
test('COD collection records the financial event after delivery', async (t) => {
  const events = capture(t); let options;
  const previous = doc({ _id: ID, storeId: STORE, orderStatus: 'Delivered', paymentMethod: 'COD', paymentStatus: 'Pending', paymentState: 'PENDING', finalAmount: 450, revision: 0 });
  const paid = doc({ ...previous, paymentStatus: 'Paid', paymentState: 'PAID', revision: 1 });
  t.mock.method(Order, 'findOne', () => ({ select: async () => previous }));
  t.mock.method(Order, 'findOneAndUpdate', (_filter, _update, opts) => { options = opts; return { select: async () => paid }; });
  const response = res();
  await require('../controllers/orderController').updatePaymentStatus(req({ paymentStatus: 'Paid', note: 'Cash received at delivery' }), response, (error) => { throw error; });
  assert.equal(options.new, true); assert.equal(events[0].before.paymentStatus, 'Pending');
  assert.equal(events[0].after.paymentStatus, 'Paid'); assert.equal(response.body.paymentStatus, 'Paid'); assert.equal(response.body.finalAmount, 450);
});
test('order workflow rejects skipped fulfilment and unpaid online confirmation', () => {
  const { allowedActions, assertOrderTransition } = require('../services/orderWorkflowService');
  const cod = { orderStatus: 'Pending', paymentMethod: 'COD', paymentStatus: 'Pending' };
  assert.deepEqual(allowedActions(cod), ['CONFIRM_ORDER', 'CANCEL_ORDER']);
  assert.throws(() => assertOrderTransition(cod, 'Delivered'), error => error.errorCode === 'ORDER_TRANSITION_INVALID');
  assert.deepEqual(allowedActions({ orderStatus: 'Pending', paymentMethod: 'ONLINE', paymentStatus: 'Pending' }), ['CANCEL_ORDER']);
});
test('coupon update records discount changes, not just the coupon code', async (t) => {
  const events = capture(t);
  const coupon = doc({ _id: ID, storeId: STORE, code: 'SAVE10', type: 'Flat', discountValue: 10, expiryDate: new Date('2099-01-01'), isActive: true });
  t.mock.method(Coupon, 'findOne', async () => coupon);
  const response = res();
  await require('../controllers/couponController').updateCoupon(req({ discountValue: 20 }), response, (error) => { throw error; });
  assert.equal(events[0].before.discountValue, 10); assert.equal(events[0].after.discountValue, 20);
  assert.equal(response.body.discountValue, 20);
});
test('only the winning cancellation claim produces an audit event, after commit', async (t) => {
  const events = capture(t);
  t.mock.method(inventory, 'claimInventoryRestore', async () => null);
  const pending = { _id: ID, storeId: STORE, orderStatus: 'Pending', paymentMethod: 'COD', paymentStatus: 'Pending', finalAmount: 450 };
  const cancelled = { ...pending, orderStatus: 'Cancelled' };
  bypassCourier(t, pending);
  t.mock.method(Shipment, 'findOne', async () => null);
  t.mock.method(require('../services/shippingService'), 'closeManualShipmentForOrder', async () => ({}));
  let alreadyClaimed = false;
  t.mock.method(Order, 'findOneAndUpdate', async (filter) => {
    if (filter.couponConsumed) return null;
    if (alreadyClaimed) return null;
    alreadyClaimed = true; return cancelled;
  });
  t.mock.method(Order, 'findById', () => ({ session: async () => cancelled }));
  const controller = require('../controllers/orderController');
  assert.equal((await controller.cancelOrderInternal(pending, { req: req(), actor: req().user, note: 'Cancelled' })).orderStatus, 'Cancelled');
  assert.equal((await controller.cancelOrderInternal(pending, { req: req(), actor: req().user, note: 'Cancelled' })).orderStatus, 'Cancelled');
  assert.equal(events.length, 1); assert.equal(events[0].action, 'ORDER_CANCEL'); assert.equal(events[0].requestId, 'workflow-request');
});
test('failed cancellation does not claim a completed audit event', async (t) => {
  const pending = { _id: ID, orderStatus: 'Pending' };
  const events = capture(t); bypassCourier(t, pending);
  t.mock.method(Shipment, 'findOne', async () => null);
  t.mock.method(inventory, 'claimInventoryRestore', async () => { throw new Error('stock write failed'); });
  await assert.rejects(require('../controllers/orderController').cancelOrderInternal(pending, { req: req(), actor: req().user }), /stock write failed/);
  assert.equal(events.length, 0);
});
test('payment finalization retry keeps exactly one capture audit event', async (t) => {
  const events = capture(t); let alreadyPaid = false;
  const paid = { _id: ID, storeId: STORE, user: USER, paymentStatus: 'Paid', orderStatus: 'Confirmed', finalAmount: 450, cartCleanupStatus: 'COMPLETE' };
  t.mock.method(inventory, 'claimInventoryDeduction', async () => null);
  t.mock.method(Order, 'findOneAndUpdate', async (filter) => {
    if (!filter.paymentStatus) return null;
    if (alreadyPaid) return null;
    alreadyPaid = true; return paid;
  });
  t.mock.method(Order, 'findById', () => ({ session: async () => paid }));
  const controller = require('../controllers/paymentController');
  const first = await controller.finalizePaidOrder(ID, { req: req(), source: 'WEBHOOK', razorpayPaymentId: 'pay_unit' });
  const retry = await controller.finalizePaidOrder(ID, { req: req(), source: 'WEBHOOK', razorpayPaymentId: 'pay_unit' });
  assert.equal(first.alreadyPaid, false); assert.equal(retry.alreadyPaid, true);
  assert.equal(events.length, 1); assert.equal(events[0].action, 'PAYMENT_CAPTURED'); assert.equal(events[0].after.finalAmount, 450);
  await new Promise(setImmediate);
});
test('a transaction failure creates no successful payment capture event', async (t) => {
  const events = capture(t);
  t.mock.method(Order, 'findOneAndUpdate', async () => ({ _id: ID }));
  t.mock.method(inventory, 'claimInventoryDeduction', async () => { throw new Error('transaction rolled back'); });
  await assert.rejects(require('../controllers/paymentController').finalizePaidOrder(ID, { source: 'WEBHOOK' }), /rolled back/);
  assert.equal(events.length, 0);
});
