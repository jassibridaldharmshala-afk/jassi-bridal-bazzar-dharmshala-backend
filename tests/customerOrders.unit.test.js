const test = require('node:test');
const assert = require('node:assert/strict');
const { returnEligibility, returnOrderStatus } = require('../services/returnEligibilityService');
const { refundEstimate } = require('../services/returnWorkflowService');
const Order = require('../models/Order');
const Settings = require('../models/Settings');
const ReturnExchange = require('../models/ReturnExchange');
// These tests do not send notifications, use a database, or start a payment.
require('../services/notificationService').notifyLater = () => {};
require('../services/analyticsService').recordEventLater = () => {};
const returns = require('../controllers/returnController');
const orders = require('../controllers/orderController');
const productId = '0123456789abcdef01234567';
const orderId = '0123456789abcdef11111111';
const userId = '0123456789abcdef22222222';
const first = { _id: '0123456789abcdef33333333', product: productId, name: 'Saree', size: 'M', color: 'Red', quantity: 2 };
const second = { ...first, _id: '0123456789abcdef44444444', size: 'L', quantity: 1 };
const delivered = () => ({ _id: orderId, user: userId, orderStatus: 'Delivered', deliveredAt: new Date(), orderItems: [first, second], shippingAddress: { fullName: 'Asha Sharma', mobile: '9812345678', houseNo: '12', area: 'Market Road', city: 'Delhi', state: 'Delhi', pincode: '110001' }, statusTimeline: [], save: async () => {} });
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const invoke = async (handler, req) => { const res = response(); let error; await handler(req, res, (err) => { error = err; }); return { res, error }; };

test('return eligibility counts exact order lines and allows other items after a partial request', () => {
  const order = { ...delivered(), orderStatus: 'Return Requested' };
  const prior = [{ orderItemId: first._id, product: productId, quantity: 2, status: 'Requested' }];
  const result = returnEligibility(order, prior, 7);
  assert.equal(result.items[0].canRequest, false);
  assert.equal(result.items[1].canRequest, true);
  assert.equal(result.items[1].remainingQuantity, 1);
});
test('completed and closed requests cannot be submitted again, while rejected requests can', () => {
  for (const status of ['Refunded', 'Exchanged', 'Closed']) {
    assert.equal(returnEligibility(delivered(), [{ orderItemId: first._id, quantity: 2, status }], 7).items[0].remainingQuantity, 0);
  }
  assert.equal(returnEligibility(delivered(), [{ orderItemId: first._id, quantity: 2, status: 'Rejected' }], 7).items[0].remainingQuantity, 2);
});
test('legacy requests match size and colour without swallowing a different order line', () => {
  const result = returnEligibility(delivered(), [{ product: productId, variantId: '', size: 'M', color: 'Red', quantity: 2, status: 'Requested' }], 7);
  assert.equal(result.items[0].remainingQuantity, 0); assert.equal(result.items[1].remainingQuantity, 1);
});
test('uses the actual delivery date and store window', () => {
  const order = { ...delivered(), deliveredAt: '2026-09-01T00:00:00Z' };
  assert.equal(returnEligibility(order, [], 7, Date.parse('2026-09-09')).items[0].canRequest, false);
  assert.equal(returnEligibility(order, [], 14, Date.parse('2026-09-09')).items[0].canRequest, true);
  const unlimited = returnEligibility(order, [], { returnsEnabled: true, returnWindowDays: null }, Date.parse('2030-09-09'));
  assert.equal(unlimited.items[0].canRequest, true); assert.equal(unlimited.items[0].deadline, null);
  assert.equal(returnEligibility(order, [], { returnsEnabled: false, returnWindowDays: null }).items[0].canRequest, false);
});
test('does not allow undelivered cancelled or refunded orders to start a return', () => {
  for (const orderStatus of ['Pending', 'Shipped', 'Cancelled', 'Refunded']) {
    assert.equal(returnEligibility({ ...delivered(), deliveredAt: null, orderStatus }, [], 7).items[0].canRequest, false);
  }
});
test('refund estimates allocate discounts and apply purchase-time return charges only where eligible', () => {
  const order = { orderItems: [{ ...first, price: 1000 }, { ...second, price: 500 }], couponDiscount: 300, prepaidDiscount: 150, deliveryCharge: 100, platformFee: 20, codCharge: 10 };
  const settings = { refundDeliveryChargeOnFullReturn: true, refundPlatformFeeOnFullReturn: true, refundCodChargeOnFullReturn: true, customerReturnShippingCharge: 50, customerRestockingFeePercent: 10 };
  const partial = refundEstimate(order, order.orderItems[1], 1, settings, { priorRequests: [{ type: 'exchange', quantity: 2, status: 'Exchanged' }] });
  assert.equal(partial.estimatedRefundAmount, 319); assert.equal(partial.refundableDeliveryCharge, 0);
  const full = refundEstimate(order, order.orderItems[1], 1, settings, { priorRequests: [{ type: 'return', quantity: 2, status: 'Refunded' }] });
  assert.equal(full.estimatedRefundAmount, 449); assert.equal(full.refundableDeliveryCharge, 100); assert.equal(full.restockingFee, 41);
  const sellerFault = refundEstimate(order, order.orderItems[1], 1, settings, { sellerFault: true });
  assert.equal(sellerFault.returnShippingCharge, 0); assert.equal(sellerFault.restockingFee, 0);
});
test('eligibility endpoint scopes both order and requests to the signed-in customer', async (t) => {
  t.mock.method(Order, 'findOne', async (filter) => { assert.equal(filter.user, userId); return delivered(); });
  t.mock.method(Settings, 'findOne', () => ({ lean: async () => ({ returnWindowDays: 7 }) }));
  t.mock.method(ReturnExchange, 'find', (filter) => { assert.equal(filter.user, userId); assert.equal(filter.order, orderId); return { sort: async () => [] }; });
  const { res, error } = await invoke(returns.orderReturns, { params: { orderId }, user: { _id: userId } });
  assert.equal(error, undefined); assert.equal(res.body.items.length, 2);
});
test('eligibility endpoint refuses another customer’s order', async (t) => {
  t.mock.method(Order, 'findOne', async () => null);
  const { error } = await invoke(returns.orderReturns, { params: { orderId }, user: { _id: userId } });
  assert.equal(error.statusCode, 404);
});
test('return submission checks product identity even when an order-item ID is provided', async (t) => {
  t.mock.method(Order, 'findOne', async () => delivered());
  const { error } = await invoke(returns.createReturn, { body: { order: orderId, product: '0123456789abcdef99999999', orderItemId: first._id, type: 'return', reason: 'Wrong item' }, user: { _id: userId } });
  assert.match(error.message, /not part of this order/);
});
test('a second line can be returned after the first line has a request', async (t) => {
  const order = { ...delivered(), orderStatus: 'Return Requested' };
  t.mock.method(Order, 'findOne', async () => order);
  t.mock.method(Settings, 'findOne', () => ({ lean: async () => ({ returnWindowDays: 7 }) }));
  t.mock.method(ReturnExchange, 'find', async () => [{ orderItemId: first._id, quantity: 2, status: 'Requested' }]);
  t.mock.method(ReturnExchange, 'create', async (payload) => ({ ...payload, _id: 'request' }));
  const { res, error } = await invoke(returns.createReturn, { body: { order: orderId, product: productId, orderItemId: second._id, type: 'return', reason: 'Size issue', quantity: 1 }, user: { _id: userId } });
  assert.equal(error, undefined); assert.equal(res.statusCode, 201); assert.equal(res.body.orderItemId, second._id);
});
test('server rejects a duplicate item return even if the frontend button was stale', async (t) => {
  t.mock.method(Order, 'findOne', async () => delivered());
  t.mock.method(Settings, 'findOne', () => ({ lean: async () => ({ returnWindowDays: 7 }) }));
  t.mock.method(ReturnExchange, 'find', async () => [{ orderItemId: first._id, quantity: 2, status: 'Closed' }]);
  const { error } = await invoke(returns.createReturn, { body: { order: orderId, product: productId, orderItemId: first._id, type: 'return', reason: 'Size issue' }, user: { _id: userId } });
  assert.equal(error.errorCode, 'DUPLICATE_REQUEST');
});
test('order history filters escape search input, retain ownership, and paginate', async (t) => {
  let captured;
  const finder = { populate() { return this; }, sort() { return this; }, skip(value) { assert.equal(value, 12); return this; }, limit: async () => [] };
  t.mock.method(Order, 'find', (filter) => { captured = filter; return finder; });
  t.mock.method(Order, 'countDocuments', async (filter) => { assert.equal(filter.user, userId); return 20; });
  const { res, error } = await invoke(orders.myOrders, { query: { page: '2', limit: '12', status: 'Delivered', search: 'silk (red)', days: '30' }, user: { _id: userId } });
  assert.equal(error, undefined); assert.equal(captured.user, userId); assert.equal(captured.orderStatus, 'Delivered');
  assert.equal(captured.$or[0]['orderItems.name'].$regex, 'silk \\(red\\)');
  assert.ok(captured.createdAt.$gte instanceof Date); assert.equal(res.body.totalPages, 2); assert.equal(res.body.page, 2);
});
test('invalid filters are rejected before querying orders', async () => {
  const { error } = await invoke(orders.myOrders, { query: { status: 'unknown' }, user: { _id: userId } });
  assert.equal(error.errorCode, 'VALIDATION_ERROR');
});

test('refunding one item does not mark an entire multi-item order refunded', () => {
  const oneRefund = { orderItemId: first._id, quantity: 2, status: 'Refunded', type: 'return', inventoryRestored: true };
  assert.equal(returnOrderStatus(delivered(), [oneRefund]), 'Delivered');
  assert.equal(returnOrderStatus(delivered(), [oneRefund, { orderItemId: second._id, quantity: 1, type: 'exchange', status: 'Requested' }]), 'Exchange Requested');
  assert.equal(returnOrderStatus(delivered(), [oneRefund, { ...oneRefund, orderItemId: second._id, quantity: 1 }]), 'Refunded');
  assert.equal(returnOrderStatus(delivered(), [oneRefund, { ...oneRefund, orderItemId: second._id, quantity: 1, status: 'Closed', resolutionStatus: 'Refunded' }]), 'Refunded');
});

test('being on the same storefront never grants access to another customer’s order or invoice', async (t) => {
  const order = { ...delivered(), user: 'different-customer', storeId: 'same-store' };
  const finder = { populate() { return this; }, then(resolve) { return Promise.resolve(order).then(resolve); } };
  t.mock.method(Order, 'findOne', () => finder);
  t.mock.method(Order, 'findById', () => finder);
  const req = { params: { id: orderId }, user: { _id: userId, role: 'customer' }, store: { _id: 'same-store' } };
  assert.equal((await invoke(orders.getOrder, req)).error.statusCode, 403);
  assert.equal((await invoke(orders.receipt, req)).error.statusCode, 403);
});

test('receipt includes platform fees, prepaid savings and inclusive GST from the order snapshot', async (t) => {
  const order = { ...delivered(), platformFee: 10, prepaidDiscount: 50, taxAmount: 80, taxRate: 5 };
  const finder = { populate() { return this; }, then(resolve) { return Promise.resolve(order).then(resolve); } };
  t.mock.method(Order, 'findById', () => finder);
  t.mock.method(Settings, 'findOne', () => ({ lean: async () => ({ storeName: 'Test store' }) }));
  const { res, error } = await invoke(orders.receipt, { params: { id: orderId }, user: { _id: userId, role: 'customer' } });
  assert.equal(error, undefined);
  assert.equal(res.body.platformFee, 10); assert.equal(res.body.prepaidDiscount, 50); assert.equal(res.body.taxAmount, 80); assert.equal(res.body.taxRate, 5);
});

test('receipt keeps the saved seller identity instead of applying later settings changes', async (t) => {
  const order = { ...delivered(), invoiceSeller: { storeName: 'Original seller', gstin: 'SAVED-GSTIN', address: 'Original seller address' } };
  const finder = { populate() { return this; }, then(resolve) { return Promise.resolve(order).then(resolve); } };
  t.mock.method(Order, 'findById', () => finder);
  t.mock.method(Settings, 'findOne', () => { throw new Error('Historical invoices must use their saved seller'); });
  const { res, error } = await invoke(orders.receipt, { params: { id: orderId }, user: { _id: userId } });
  assert.equal(error, undefined); assert.equal(res.body.storeDetails.storeName, 'Original seller'); assert.equal(res.body.storeDetails.gstin, 'SAVED-GSTIN');
});

test('legacy receipts fetch only their store settings', async (t) => {
  const order = { ...delivered(), storeId: 'store-1' };
  const finder = { populate() { return this; }, then(resolve) { return Promise.resolve(order).then(resolve); } };
  t.mock.method(Order, 'findById', () => finder);
  t.mock.method(Settings, 'findOne', (filter) => { assert.deepEqual(filter, { storeId: 'store-1' }); return { lean: async () => ({ storeName: 'Scoped store' }) }; });
  const { res, error } = await invoke(orders.receipt, { params: { id: orderId }, user: { _id: userId } });
  assert.equal(error, undefined); assert.equal(res.body.storeDetails.storeName, 'Scoped store');
});

test('default-store legacy invoices can use global settings without using another store settings', async (t) => {
  const order = { ...delivered(), storeId: 'store-1' };
  const finder = { populate() { return this; }, then(resolve) { return Promise.resolve(order).then(resolve); } };
  t.mock.method(Order, 'findById', () => finder);
  t.mock.method(require('../models/Store'), 'findById', () => ({ select() { return this; }, lean: async () => ({ name: 'Default store', isDefault: true }) }));
  t.mock.method(Settings, 'findOne', (filter) => ({ lean: async () => filter.storeId === null ? { storeName: 'Original global store', contactPhone: '9000000000' } : null }));
  const { res, error } = await invoke(orders.receipt, { params: { id: orderId }, user: { _id: userId } });
  assert.equal(error, undefined); assert.equal(res.body.storeDetails.storeName, 'Original global store');
});

test('new orders snapshot seller identity, product facts and purchase-time return policy', () => {
  const { buildPersistedOrderFields } = require('../services/orderSnapshotService');
  const snapshot = buildPersistedOrderFields({ userId, draft: { settings: { storeName: 'Seller', gstin: 'GST', contactPhone: '9000000000', unrelatedSecret: 'excluded', returnsEnabled: true, returnWindowDays: null, customerRestockingFeePercent: 5, rtoRefundDeduction: 99 }, items: [{ product: productId, name: 'Saree', sku: 'SKU-123', quantity: 2, price: 899, originalPrice: 1899 }], totals: { finalAmount: 1798 } }, shippingAddress: { fullName: 'Customer' } });
  assert.equal(snapshot.invoiceSeller.storeName, 'Seller'); assert.equal(snapshot.invoiceSeller.unrelatedSecret, undefined);
  assert.equal(snapshot.orderItems[0].sku, 'SKU-123'); assert.equal(snapshot.orderItems[0].originalPrice, 1899);
  assert.equal(snapshot.returnPolicySnapshot.returnWindowDays, null); assert.equal(snapshot.returnPolicySnapshot.customerRestockingFeePercent, 5); assert.equal(snapshot.returnPolicySnapshot.rtoRefundDeduction, 99);
});

test('closing a refunded request preserves its financial resolution', async (t) => {
  const request = { _id: productId, order: orderId, orderItemId: first._id, quantity: 2, type: 'return', status: 'Refunded', inventoryRestored: true, save: async () => {} };
  const order = { ...delivered(), orderItems: [first] };
  t.mock.method(ReturnExchange, 'findOneAndUpdate', async () => request);
  t.mock.method(ReturnExchange, 'updateOne', async () => ({ modifiedCount: 1 }));
  t.mock.method(ReturnExchange, 'findOne', async () => request);
  t.mock.method(ReturnExchange, 'find', async () => [request]);
  t.mock.method(Order, 'findById', async () => order);
  const { error } = await invoke(returns.updateReturnStatus, { params: { id: productId }, body: { status: 'Closed' }, user: { _id: userId } });
  assert.equal(error, undefined); assert.equal(request.resolutionStatus, 'Refunded'); assert.equal(order.orderStatus, 'Refunded');
});
