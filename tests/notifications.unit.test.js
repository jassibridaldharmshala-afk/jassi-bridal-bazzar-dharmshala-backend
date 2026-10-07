const test = require('node:test');
const assert = require('node:assert/strict');
const Notification = require('../models/Notification');
const User = require('../models/User');
const controller = require('../controllers/notificationController');
const { notify } = require('../services/notificationService');
const events = [];
// Capture event emission without a database, gateway call or background job.
require('../services/notificationService').notifyLater = (payload) => events.push(payload);
require('../services/auditService').logAudit = () => {};
const { razorpayWebhook } = require('../controllers/paymentController');
const Order = require('../models/Order');
const crypto = require('crypto');
const userId = '0123456789abcdef11111111';
const notificationId = '0123456789abcdef22222222';
const req = (extra = {}) => ({ user: { _id: userId, role: 'customer' }, query: {}, params: { id: notificationId }, body: {}, ...extra });
const invoke = async (handler, request) => {
  const res = { json(body) { this.body = body; return this; } };
  let error;
  await handler(request, res, (err) => { error = err; });
  return { body: res.body, error };
};

test('customer inbox filters by recipient, delivered in-app channel, category and read state', async (t) => {
  let captured;
  t.mock.method(Notification, 'find', (filter) => {
    captured = filter;
    return { sort() { return this; }, skip(value) { assert.equal(value, 20); return this; }, limit: async () => [{ _id: notificationId }] };
  });
  t.mock.method(Notification, 'countDocuments', async (filter) => { assert.deepEqual(filter, captured); return 43; });
  const { body, error } = await invoke(controller.myNotifications, req({ query: { page: '2', limit: '20', category: 'orders', read: 'unread' } }));
  assert.equal(error, undefined);
  assert.ok(captured.deliverAfter.$not.$gt instanceof Date);
  const { deliverAfter, ...visibleFilter } = captured;
  assert.deepEqual(visibleFilter, { user: userId, channel: 'IN_APP', status: 'SENT', audience: { $ne: 'ADMIN' }, readAt: null, event: { $regex: '^ORDER_' } });
  assert.equal(body.total, 43); assert.equal(body.totalPages, 3); assert.equal(body.items.length, 1);
});

test('unread summary counts the entire inbox, independently of the list page', async (t) => {
  t.mock.method(Notification, 'countDocuments', async (filter) => { assert.equal(filter.user, userId); assert.equal(filter.readAt, null); return 152; });
  t.mock.method(Notification, 'findOne', (filter) => {
    assert.equal(filter.channel, 'IN_APP'); assert.equal(filter.status, 'SENT');
    return { sort() { return this; }, select: async () => ({ _id: notificationId, title: 'Order shipped' }) };
  });
  const { body, error } = await invoke(controller.summary, req());
  assert.equal(error, undefined); assert.equal(body.unreadCount, 152); assert.equal(body.latest._id, notificationId);
});

test('mark all read updates only the signed-in recipient, including updates on other pages', async (t) => {
  t.mock.method(Notification, 'updateMany', async (filter, update) => {
    assert.ok(filter.deliverAfter.$not.$gt instanceof Date);
    const { deliverAfter, ...ownedVisibleFilter } = filter;
    assert.deepEqual(ownedVisibleFilter, { user: userId, channel: 'IN_APP', status: 'SENT', audience: { $ne: 'ADMIN' }, readAt: null });
    assert.ok(update.$set.readAt instanceof Date);
    return { modifiedCount: 200 };
  });
  const result = await invoke(controller.markAllRead, req());
  assert.equal(result.error, undefined); assert.ok(result.body.readAt instanceof Date);
});

test('mark unread clears the persisted receipt and retains ownership checks', async (t) => {
  t.mock.method(Notification, 'findOneAndUpdate', async (filter, update, options) => {
    assert.equal(filter.user, userId); assert.equal(filter._id, notificationId); assert.equal(filter.status, 'SENT');
    assert.equal(update.$set.readAt, null); assert.equal(options.new, true);
    return { _id: notificationId, readAt: null };
  });
  assert.equal((await invoke(controller.markRead, req({ body: { read: false } }))).body.readAt, null);
});

test('reading a notification that is not owned returns 404', async (t) => {
  t.mock.method(Notification, 'findOneAndUpdate', async () => null);
  assert.equal((await invoke(controller.markRead, req())).error.statusCode, 404);
});

test('invalid read filters and notification identifiers are rejected', async () => {
  assert.equal((await invoke(controller.myNotifications, req({ query: { read: 'everything' } }))).error.statusCode, 400);
  assert.equal((await invoke(controller.markRead, req({ params: { id: 'not-an-id' } }))).error.statusCode, 400);
});

test('admin inbox includes staff alerts but still requires the exact recipient', () => {
  const filter = controller.recipientFilter(req({ user: { _id: userId, role: 'admin' } }));
  assert.ok(filter.deliverAfter.$not.$gt instanceof Date);
  delete filter.deliverAfter;
  assert.deepEqual(filter, { user: userId, channel: 'IN_APP', status: 'SENT' });
});

test('scheduled in-app notifications stay queued until their delivery time', async (t) => {
  t.mock.method(User, 'find', () => ({ select: async () => [] }));
  const deliverAfter = new Date(Date.now() + 86400000);
  let stored;
  t.mock.method(Notification, 'bulkWrite', async (operations) => { stored = operations[0].updateOne.update.$setOnInsert; });
  await notify({ userId, event: 'REVIEW_REQUEST', title: 'How was your order?', metadata: { orderId: 'order-review-1' }, deliverAfter });
  assert.equal(stored.deliverAfter, deliverAfter);
  assert.equal(stored.event, 'REVIEW_REQUEST');
});

test('order events create separate customer and active-admin alerts, with repeat delivery deduplicated', async (t) => {
  t.mock.method(User, 'find', (filter) => {
    assert.deepEqual(filter, { role: 'admin', isBlocked: { $ne: true } });
    return { select: async () => [{ _id: 'staff-1' }, { _id: 'staff-2' }] };
  });
  const saved = new Map();
  t.mock.method(Notification, 'bulkWrite', async (operations) => {
    for (const { updateOne } of operations) {
      assert.equal(updateOne.upsert, true); assert.equal(updateOne.timestamps, false);
      const key = updateOne.filter.dedupeKey;
      if (!saved.has(key)) saved.set(key, updateOne.update.$setOnInsert);
    }
  });
  const payload = { userId, event: 'ORDER_PLACED', title: 'Order placed', metadata: { orderId: 'order-1' }, storeId: 'store-1' };
  await notify(payload); await notify(payload);
  assert.equal(saved.size, 3);
  assert.equal([...saved.values()].filter((item) => item.audience === 'ADMIN').length, 2);
  assert.ok([...saved.values()].every((item) => item.status === 'SENT' && item.storeId === 'store-1' && item.createdAt instanceof Date));
});

test('a negative review keeps the customer message and sends a priority review event to staff', async (t) => {
  t.mock.method(User, 'find', () => ({ select: async () => [{ _id: 'staff-review' }] }));
  let stored = [];
  t.mock.method(Notification, 'bulkWrite', async (operations) => {
    stored = operations.map((operation) => operation.updateOne.update.$setOnInsert);
  });
  await notify({
    userId,
    event: 'REVIEW_SUBMITTED',
    adminEvent: 'REVIEW_NEGATIVE',
    title: 'Review published',
    message: 'Thank you for your feedback.',
    metadata: { reviewId: 'review-negative-1' },
  });
  assert.equal(stored.find((item) => item.audience === 'CUSTOMER').event, 'REVIEW_SUBMITTED');
  assert.equal(stored.find((item) => item.audience === 'ADMIN').event, 'REVIEW_NEGATIVE');
  assert.match(stored.find((item) => item.audience === 'ADMIN').title, /negative review/i);
});

test('anonymous support messages are delivered to staff without an unowned inbox entry', async (t) => {
  t.mock.method(User, 'find', () => ({ select: async () => [{ _id: 'staff' }] }));
  t.mock.method(Notification, 'bulkWrite', async (operations) => {
    assert.equal(operations.length, 1);
    assert.equal(operations[0].updateOne.update.$setOnInsert.audience, 'ADMIN');
    assert.equal(operations[0].updateOne.update.$setOnInsert.metadata.contactId, 'contact-1');
  });
  await notify({ event: 'CONTACT_RECEIVED', metadata: { contactId: 'contact-1' } });
});

test('refund deduplication uses each refund ID so a second partial refund is visible', async (t) => {
  const keys = [];
  t.mock.method(Notification, 'bulkWrite', async (operations) => { keys.push(operations[0].updateOne.filter.dedupeKey); });
  await notify({ userId, event: 'REFUND_PROCESSED', metadata: { orderId: 'order-1', refundId: 'refund-1' } });
  await notify({ userId, event: 'REFUND_PROCESSED', metadata: { orderId: 'order-1', refundId: 'refund-2' } });
  assert.notEqual(keys[0], keys[1]);
});

test('external notification channels are never presented as sent without delivery integration', async (t) => {
  t.mock.method(Notification, 'insertMany', async (docs) => docs);
  const docs = await notify({ userId, event: 'TEST', channels: ['EMAIL', 'SMS', 'PUSH'] });
  assert.equal(docs.length, 3); assert.ok(docs.every((doc) => doc.status === 'SKIPPED'));
});

function signedWebhook(payload) {
  const body = Buffer.from(JSON.stringify(payload));
  return { body, headers: { 'x-razorpay-signature': crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(body).digest('hex') } };
}

test('verified partial refunds accumulate exactly once and finish at the charged total', async (t) => {
  const original = process.env.RAZORPAY_WEBHOOK_SECRET;
  process.env.RAZORPAY_WEBHOOK_SECRET = 'unit-test-only';
  t.after(() => { if (original === undefined) delete process.env.RAZORPAY_WEBHOOK_SECRET; else process.env.RAZORPAY_WEBHOOK_SECRET = original; });
  events.length = 0;
  const order = { _id: notificationId, user: userId, finalAmount: 1000, refundedAmount: 0, refunds: [], paymentState: 'PAID', paymentStatus: 'Paid', storeId: 'store-1' };
  const ReturnExchange = require('../models/ReturnExchange');
  t.mock.method(ReturnExchange, 'findOneAndUpdate', async () => null);
  t.mock.method(Order, 'findOne', async (filter) => {
    assert.deepEqual(filter, { razorpayPaymentId: 'pay_test' });
    return order;
  });
  t.mock.method(Order, 'findOneAndUpdate', async (_filter, update) => {
    const entry = update.$push.refunds;
    if (order.refunds.some(item => item.providerRefundId === entry.providerRefundId)) return null;
    order.refundedAmount += update.$inc.refundedAmount;
    order.refunds.push(entry);
    return { ...order };
  });
  t.mock.method(Order, 'updateOne', async (_filter, update) => { Object.assign(order, update.$set); return { modifiedCount: 1 }; });
  const request = signedWebhook({ event: 'refund.processed', payload: { refund: { entity: { id: 'refund_test', payment_id: 'pay_test', amount: 25000 } } } });
  const res = { json(body) { this.body = body; }, status() { return this; } };
  await razorpayWebhook(request, res);
  assert.equal(res.body.success, true); assert.equal(events.length, 1);
  assert.equal(events[0].event, 'REFUND_PROCESSED'); assert.equal(events[0].title, 'Partial refund processed');
  assert.equal(events[0].metadata.amount, 250); assert.equal(events[0].metadata.refundId, 'refund_test');
  assert.equal(events[0].userId, userId);
  await razorpayWebhook(request, res);
  assert.equal(events.length, 1, 'a repeated refund webhook must be ignored');
  const remainder = signedWebhook({ event: 'refund.processed', payload: { refund: { entity: { id: 'refund_remainder', payment_id: 'pay_test', amount: 75000 } } } });
  await razorpayWebhook(remainder, res);
  assert.equal(events.length, 2); assert.equal(events[1].title, 'Refund processed');
  assert.equal(order.refundedAmount, 1000); assert.equal(order.paymentState, 'REFUNDED'); assert.equal(order.paymentStatus, 'Refunded');
  assert.deepEqual(order.refunds.map(item => item.providerRefundId), ['refund_test', 'refund_remainder']);
});

test('a provider refund completes its return case and reconciles the order status', async (t) => {
  const original = process.env.RAZORPAY_WEBHOOK_SECRET;
  process.env.RAZORPAY_WEBHOOK_SECRET = 'unit-test-only';
  t.after(() => { if (original === undefined) delete process.env.RAZORPAY_WEBHOOK_SECRET; else process.env.RAZORPAY_WEBHOOK_SECRET = original; });
  events.length = 0;
  const order = { _id: notificationId, user: userId, finalAmount: 1000, refundedAmount: 0, refunds: [], paymentState: 'PAID', paymentStatus: 'Paid', orderStatus: 'Return Requested', orderItems: [{ _id: 'line-one', quantity: 1 }], storeId: 'store-1' };
  const ReturnExchange = require('../models/ReturnExchange');
  const updates = [];
  t.mock.method(Order, 'findOne', async () => order);
  t.mock.method(Order, 'findOneAndUpdate', async (_filter, update) => ({ ...order, refundedAmount: update.$inc.refundedAmount, refunds: [update.$push.refunds] }));
  t.mock.method(Order, 'updateOne', async (_filter, update) => { updates.push(update); Object.assign(order, update.$set); return { modifiedCount: 1 }; });
  t.mock.method(ReturnExchange, 'findOneAndUpdate', async (_filter, update) => {
    assert.equal(update.$set.active, false);
    return { _id: 'return-one', order: order._id, orderItemId: 'line-one', quantity: 1, type: 'return', status: 'Refunded', resolutionStatus: 'Refunded', storeId: order.storeId };
  });
  t.mock.method(ReturnExchange, 'find', async () => [{ orderItemId: 'line-one', quantity: 1, type: 'return', status: 'Refunded', resolutionStatus: 'Refunded' }]);
  const request = signedWebhook({ event: 'refund.processed', payload: { refund: { entity: { id: 'refund_return', payment_id: 'pay_test', amount: 100000 } } } });
  const res = { json(body) { this.body = body; }, status() { return this; } };
  await razorpayWebhook(request, res);
  assert.equal(res.body.success, true);
  assert.ok(updates.some(update => update.$set?.orderStatus === 'Refunded'));
});

test('a verified failed payment creates a customer alert only on the first state change', async (t) => {
  const original = process.env.RAZORPAY_WEBHOOK_SECRET;
  process.env.RAZORPAY_WEBHOOK_SECRET = 'unit-test-only';
  t.after(() => { if (original === undefined) delete process.env.RAZORPAY_WEBHOOK_SECRET; else process.env.RAZORPAY_WEBHOOK_SECRET = original; });
  events.length = 0;
  const order = { _id: notificationId, user: userId, paymentStatus: 'Pending', orderStatus: 'Cancelled' };
  t.mock.method(Order, 'findOne', async () => order);
  let previous = 'Pending';
  t.mock.method(Order, 'findOneAndUpdate', async () => { const value = { ...order, paymentStatus: previous }; previous = 'Failed'; return value; });
  const request = signedWebhook({ event: 'payment.failed', payload: { payment: { entity: { order_id: 'rzp_test', error_description: 'Declined' } } } });
  const res = { json(body) { this.body = body; }, status() { return this; } };
  await razorpayWebhook(request, res); await razorpayWebhook(request, res);
  assert.equal(events.length, 1); assert.equal(events[0].event, 'PAYMENT_FAILED');
  assert.equal(events[0].userId, userId); assert.equal(events[0].metadata.orderId, notificationId);
});

test('admin deep links query exact records before limiting results and retain store scope', async (t) => {
  const ReturnExchange = require('../models/ReturnExchange');
  const ContactMessage = require('../models/ContactMessage');
  const filterCheck = (filter) => {
    assert.deepEqual(filter, { $and: [{ _id: notificationId }, { storeId: 'store-1' }] });
    return { populate() { return this; }, sort() { return this; }, skip() { return this; }, limit: async () => [] };
  };
  t.mock.method(ReturnExchange, 'find', filterCheck); t.mock.method(ReturnExchange, 'countDocuments', async () => 0); t.mock.method(ContactMessage, 'find', filterCheck);
  const request = req({ query: { id: notificationId }, tenantFilter: { storeId: 'store-1' } });
  assert.equal((await invoke(require('../controllers/returnController').adminReturns, request)).error, undefined);
  assert.equal((await invoke(require('../controllers/contactController').adminList, request)).error, undefined);
});
