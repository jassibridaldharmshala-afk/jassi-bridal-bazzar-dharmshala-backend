const test = require('node:test');
const assert = require('node:assert/strict');

const { request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createAdmin, createCustomer, createProduct, setSettings, validAddress } = require('./factories');
const Order = require('../models/Order');
const Product = require('../models/Product');
const ReturnExchange = require('../models/ReturnExchange');
const InventoryItem = require('../models/InventoryItem');

test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(async () => {
  await resetDatabase();
  await setSettings({ returnWindowDays: 7 });
});

async function deliveredOrder(customerToken, product, quantity = 1) {
  const { data } = await request('/api/orders/cod', {
    method: 'POST',
    token: customerToken,
    body: {
      orderItems: [{ product: String(product._id), quantity, size: 'M', color: 'Red' }],
      shippingAddress: validAddress(),
      paymentMethod: 'COD',
    },
  });
  const { token: adminToken } = await createAdmin();
  await Order.updateOne({ _id: data._id }, { $set: { orderStatus: 'Delivered', deliveredAt: new Date(), paymentStatus: 'Paid', paymentState: 'PAID' } });
  return { orderId: data._id, adminToken };
}

test('a delivered order can request a return inside the window', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ stock: 5 });
  const { orderId } = await deliveredOrder(token, product);

  const { status, data } = await request('/api/returns', {
    method: 'POST',
    token,
    body: { order: orderId, product: String(product._id), type: 'return', reason: 'Size issue', quantity: 1 },
  });

  assert.equal(status, 201);
  assert.equal(data.status, 'Requested');
});

test('a mismatched tracked item requires a documented manual decision and never auto-refunds', async () => {
  await setSettings({ requireProductQrScan: true, highValueVerificationThreshold: 0 });
  const customer = await createCustomer();
  const admin = await createAdmin();
  const product = await createProduct({ stock: 5 });
  const placed = await request('/api/orders/cod', { method: 'POST', token: customer.token, body: { orderItems: [{ product: String(product._id), quantity: 1, size: 'M', color: 'Red' }], shippingAddress: validAddress(), paymentMethod: 'COD' } });
  assert.equal(placed.status, 201, JSON.stringify(placed.data));
  await Order.updateOne({ _id: placed.data._id }, { $set: { orderStatus: 'Confirmed' } });
  const labels = await request(`/api/admin/orders/${placed.data._id}/item-identities/generate`, { method: 'POST', token: admin.token, body: {} });
  assert.equal(labels.status, 201, JSON.stringify(labels.data));
  let order = await Order.findById(placed.data._id);
  const packed = await request(`/api/admin/orders/${order._id}/packing/verify`, { method: 'POST', token: admin.token, body: { items: [{ orderItemId: String(order.orderItems[0]._id), uniqueItemIds: order.orderItems[0].uniqueItemIds }] } });
  assert.equal(packed.status, 200, JSON.stringify(packed.data));
  await Order.updateOne({ _id: order._id }, { $set: { orderStatus: 'Delivered', deliveredAt: new Date(), paymentStatus: 'Paid', paymentState: 'PAID' } });

  const created = await request('/api/returns', { method: 'POST', token: customer.token, body: { order: String(order._id), product: String(product._id), type: 'return', reason: 'Size issue', quantity: 1 } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  for (const status of ['Approved', 'Received']) {
    const moved = await request(`/api/admin/returns/${created.data._id}/status`, { method: 'PUT', token: admin.token, body: { status } });
    assert.equal(moved.status, 200, JSON.stringify(moved.data));
  }
  const bypass = await request(`/api/admin/returns/${created.data._id}/status`, { method: 'PUT', token: admin.token, body: { status: 'QC Passed', inventoryDisposition: 'RESTOCK', receivedQuantity: 1, qcNotes: 'Attempted without identity inspection.' } });
  assert.equal(bypass.status, 409);
  assert.equal(bypass.data.code, 'RETURN_INSPECTION_REQUIRED');
  const inspection = await request(`/api/admin/returns/${created.data._id}/inspect`, { method: 'POST', token: admin.token, body: { returnedUniqueItemIds: ['SC-WRONG-999999'], condition: 'DIFFERENT_ITEM', notes: 'Scanned item does not match dispatch record.' } });
  assert.equal(inspection.status, 200, JSON.stringify(inspection.data));
  assert.equal(inspection.data.request.status, 'Mismatch Found');
  assert.ok(inspection.data.assessment.flags.includes('ITEM_ID_MISMATCH'));
  assert.equal((await InventoryItem.findOne({ order: order._id })).status, 'RETURNED');

  const unsafeApproval = await request(`/api/admin/returns/${created.data._id}/decision`, { method: 'POST', token: admin.token, body: { decision: 'APPROVED' } });
  assert.equal(unsafeApproval.status, 409);
  assert.equal(unsafeApproval.data.code, 'MANUAL_REVIEW_REQUIRED');
  const rejected = await request(`/api/admin/returns/${created.data._id}/decision`, { method: 'POST', token: admin.token, body: { decision: 'REJECTED', reason: 'Returned identifier and product do not match the dispatch record.', customerMessage: 'The returned product could not be verified. Please contact support if you need a second review.' } });
  assert.equal(rejected.status, 200, JSON.stringify(rejected.data));
  assert.equal((await Order.findById(order._id)).refundedAmount, 0);
});

test('a verified tracked return can be approved and refunded without exposing internal evidence', async () => {
  await setSettings({ requireProductQrScan: true, highValueVerificationThreshold: 0, autoApproveVerifiedReturns: true });
  const customer = await createCustomer();
  const admin = await createAdmin();
  const product = await createProduct({ stock: 5, price: 1000 });
  const placed = await request('/api/orders/cod', { method: 'POST', token: customer.token, body: { orderItems: [{ product: String(product._id), quantity: 1, size: 'M', color: 'Red' }], shippingAddress: validAddress(), paymentMethod: 'COD' } });
  await Order.updateOne({ _id: placed.data._id }, { $set: { orderStatus: 'Confirmed' } });
  const labels = await request(`/api/admin/orders/${placed.data._id}/item-identities/generate`, { method: 'POST', token: admin.token, body: {} });
  assert.equal(labels.status, 201, JSON.stringify(labels.data));
  const trackedId = labels.data.items[0].uniqueItemId;
  let order = await Order.findById(placed.data._id);
  assert.equal((await request(`/api/admin/orders/${order._id}/packing/verify`, { method: 'POST', token: admin.token, body: { items: [{ orderItemId: String(order.orderItems[0]._id), uniqueItemIds: [trackedId] }] } })).status, 200);
  await Order.updateOne({ _id: order._id }, { $set: { orderStatus: 'Delivered', deliveredAt: new Date(), paymentStatus: 'Paid', paymentState: 'PAID' } });
  const created = await request('/api/returns', { method: 'POST', token: customer.token, body: { order: String(order._id), product: String(product._id), type: 'return', reason: 'Size issue', quantity: 1 } });
  for (const status of ['Approved', 'Received']) assert.equal((await request(`/api/admin/returns/${created.data._id}/status`, { method: 'PUT', token: admin.token, body: { status } })).status, 200);
  const inspected = await request(`/api/admin/returns/${created.data._id}/inspect`, { method: 'POST', token: admin.token, body: { returnedUniqueItemIds: [trackedId], condition: 'GOOD', notes: 'Identity and condition matched.' } });
  assert.equal(inspected.status, 200, JSON.stringify(inspected.data));
  assert.equal(inspected.data.request.status, 'Verified');
  assert.equal(inspected.data.request.refundDecision.decision, 'APPROVED');
  assert.equal((await request(`/api/admin/returns/${created.data._id}/status`, { method: 'PUT', token: admin.token, body: { status: 'QC Passed', inventoryDisposition: 'RESTOCK', receivedQuantity: 1, qcNotes: 'Verified and sellable.' } })).status, 200);
  assert.equal((await request(`/api/admin/returns/${created.data._id}/status`, { method: 'PUT', token: admin.token, body: { status: 'Refund Initiated', refundAmount: 1000 } })).status, 200);
  const customerView = await request('/api/returns/my-requests', { token: customer.token });
  assert.equal(customerView.status, 200);
  assert.equal(customerView.data[0].inspection.expectedUniqueItemIds, undefined);
  assert.equal(customerView.data[0].inspection.flags, undefined);
  assert.equal(customerView.data[0].refundDecision.reason, undefined);
});

test('refund destination stays encrypted and requires an audited admin reveal', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ stock: 5 });
  const { orderId, adminToken } = await deliveredOrder(token, product);
  const created = await request('/api/returns', { method: 'POST', token, body: { order: orderId, product: String(product._id), type: 'return', reason: 'Size issue', refundMethod: 'UPI', refundDestination: { vpa: 'asha@upi' }, pickupAddress: validAddress() } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.refundDestination, undefined);
  const stored = await ReturnExchange.findById(created.data._id).select('+refundDestinationEncrypted');
  assert.ok(stored.refundDestinationEncrypted); assert.equal(stored.refundDestinationEncrypted.includes('asha@upi'), false);
  const detail = await request(`/api/admin/returns/${created.data._id}`, { token: adminToken });
  assert.equal(detail.status, 200); assert.equal(detail.data.refundDestination, undefined);
  const revealed = await request(`/api/admin/returns/${created.data._id}/refund-destination`, { token: adminToken });
  assert.equal(revealed.status, 200, JSON.stringify(revealed.data)); assert.equal(revealed.data.refundDestination.vpa, 'asha@upi');
  const denied = await request(`/api/returns/${created.data._id}/refund-destination`, { token });
  assert.equal(denied.status, 403);
});

test('concurrent requests cannot open two active cases for the same order item', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ stock: 5 });
  const { orderId } = await deliveredOrder(token, product);
  const body = { order: orderId, product: String(product._id), type: 'return', reason: 'Size issue', quantity: 1, pickupAddress: validAddress() };
  const responses = await Promise.all([
    request('/api/returns', { method: 'POST', token, body }),
    request('/api/returns', { method: 'POST', token, body }),
  ]);
  const accepted = responses.find(response => response.status === 201);
  const rejected = responses.find(response => response.status !== 201);
  assert.ok(accepted);
  assert.ok([400, 409].includes(rejected?.status));
  assert.equal(rejected?.data?.code, 'DUPLICATE_REQUEST', JSON.stringify(rejected?.data));
  assert.equal(await ReturnExchange.countDocuments({ order: orderId, active: true }), 1);
});

test('returns are refused after the return window', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ stock: 5 });
  const { orderId } = await deliveredOrder(token, product);
  await Order.updateOne({ _id: orderId }, { deliveredAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) });

  const { status, data } = await request('/api/returns', {
    method: 'POST',
    token,
    body: { order: orderId, product: String(product._id), type: 'return', reason: 'Changed mind' },
  });

  assert.equal(status, 400);
  assert.equal(data.code, 'RETURN_WINDOW_EXPIRED');
});

test('completing a return restores stock once', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ stock: 3 });
  const { orderId, adminToken } = await deliveredOrder(token, product);
  assert.equal((await Product.findById(product._id)).stock, 2);

  const created = await request('/api/returns', {
    method: 'POST',
    token,
    body: { order: orderId, product: String(product._id), type: 'return', reason: 'Damaged', photos: ['/uploads/return-test.jpg'] },
  });
  assert.equal(created.status, 201);

  let refundInitiated;
  for (const body of [
    { status: 'Approved' },
    { status: 'Received' },
    { status: 'QC Passed', inventoryDisposition: 'RESTOCK', receivedQuantity: 1, qcNotes: 'Unused and sellable.' },
    { status: 'Refund Initiated', refundAmount: 1000 },
    { status: 'Refunded', refundAmount: 1000, refundReference: 'refund-test-001' },
  ]) {
    const updated = await request(`/api/admin/returns/${created.data._id}/status`, { method: 'PUT', token: adminToken, body });
    assert.equal(updated.status, 200);
    if (body.status === 'Refund Initiated') refundInitiated = updated.data;
  }
  assert.ok(new Date(refundInitiated.financial.expectedBy).getTime() > new Date(refundInitiated.financial.initiatedAt).getTime());
  assert.equal((await Product.findById(product._id)).stock, 3);

  await request(`/api/admin/returns/${created.data._id}/status`, {
    method: 'PUT',
    token: adminToken,
    body: { status: 'Closed' },
  });
  assert.equal((await Product.findById(product._id)).stock, 3);
  assert.equal((await ReturnExchange.findById(created.data._id)).inventoryRestored, true);
});

test('a completed return cannot record its refund twice with a changed note', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ stock: 3, price: 1000 });
  const { orderId, adminToken } = await deliveredOrder(token, product);
  const created = await request('/api/returns', { method: 'POST', token, body: { order: orderId, product: String(product._id), type: 'return', reason: 'Changed mind' } });
  for (const body of [
    { status: 'Approved' }, { status: 'Received' },
    { status: 'QC Passed', inventoryDisposition: 'RESTOCK', receivedQuantity: 1, qcNotes: 'Sellable.' },
    { status: 'Refund Initiated', refundAmount: 1000 },
    { status: 'Refunded', refundAmount: 1000, refundReference: 'return-refund-once', adminComment: 'First record' },
  ]) assert.equal((await request(`/api/admin/returns/${created.data._id}/status`, { method: 'PUT', token: adminToken, body })).status, 200);
  const repeated = await request(`/api/admin/returns/${created.data._id}/status`, { method: 'PUT', token: adminToken, body: { status: 'Refunded', refundAmount: 1000, refundReference: 'different-reference', adminComment: 'Changed note' } });
  assert.equal(repeated.status, 200);
  const order = await Order.findById(orderId);
  assert.equal(order.refundedAmount, 1000);
  assert.equal(order.refunds.filter(refund => refund.sourceType === 'RETURN').length, 1);
});

test('an unpaid COD return cannot be marked as refund initiated', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ stock: 3, price: 1000 });
  const placed = await request('/api/orders/cod', { method: 'POST', token, body: { orderItems: [{ product: String(product._id), quantity: 1, size: 'M', color: 'Red' }], shippingAddress: validAddress(), paymentMethod: 'COD' } });
  const { token: adminToken } = await createAdmin();
  await Order.updateOne({ _id: placed.data._id }, { $set: { orderStatus: 'Delivered', deliveredAt: new Date() } });
  const created = await request('/api/returns', { method: 'POST', token, body: { order: placed.data._id, product: String(product._id), type: 'return', reason: 'Changed mind' } });
  for (const body of [{ status: 'Approved' }, { status: 'Received' }, { status: 'QC Passed', inventoryDisposition: 'RESTOCK', receivedQuantity: 1, qcNotes: 'Sellable.' }]) {
    assert.equal((await request(`/api/admin/returns/${created.data._id}/status`, { method: 'PUT', token: adminToken, body })).status, 200);
  }
  const refund = await request(`/api/admin/returns/${created.data._id}/status`, { method: 'PUT', token: adminToken, body: { status: 'Refund Initiated', refundAmount: 1000 } });
  assert.equal(refund.status, 409);
  assert.equal(refund.data.code, 'PAYMENT_NOT_COLLECTED');
  assert.equal((await Order.findById(placed.data._id)).refundedAmount, 0);
});

test('simultaneous return completion restores the returned unit exactly once', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ stock: 3 });
  const { orderId, adminToken } = await deliveredOrder(token, product);
  const created = await request('/api/returns', { method: 'POST', token, body: { order: orderId, product: String(product._id), type: 'return', reason: 'Damaged', photos: ['/uploads/return-test.jpg'] } });
  await request(`/api/admin/returns/${created.data._id}/status`, { method: 'PUT', token: adminToken, body: { status: 'Approved' } });
  await request(`/api/admin/returns/${created.data._id}/status`, { method: 'PUT', token: adminToken, body: { status: 'Received' } });
  const results = await Promise.all([1,2].map(() => request(`/api/admin/returns/${created.data._id}/status`, { method: 'PUT', token: adminToken, body: { status: 'QC Passed', inventoryDisposition: 'RESTOCK', receivedQuantity: 1, qcNotes: 'Sellable.' } })));
  assert.ok(results.every(result => result.status === 200));
  assert.equal((await Product.findById(product._id)).stock, 3);
});

test('failed return QC records received units in quarantine without making them sellable', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ stock: 3 });
  const { orderId, adminToken } = await deliveredOrder(token, product);
  const created = await request('/api/returns', { method: 'POST', token, body: { order: orderId, product: String(product._id), type: 'return', reason: 'Damaged', photos: ['/uploads/return-test.jpg'] } });
  await request(`/api/admin/returns/${created.data._id}/status`, { method: 'PUT', token: adminToken, body: { status: 'Approved' } });
  await request(`/api/admin/returns/${created.data._id}/status`, { method: 'PUT', token: adminToken, body: { status: 'Received' } });
  const failed = await request(`/api/admin/returns/${created.data._id}/status`, {
    method: 'PUT', token: adminToken,
    body: { status: 'QC Failed', inventoryDisposition: 'QUARANTINE', receivedQuantity: 1, qcNotes: 'Seal was broken.' },
  });
  assert.equal(failed.status, 200, JSON.stringify(failed.data));
  const stored = await Product.findById(product._id).lean();
  assert.equal(stored.stock, 2);
  assert.equal(stored.nonSellableStock.quarantine, 1);
  assert.equal((await ReturnExchange.findById(created.data._id)).inventoryDispositionRecorded, true);
  const history = await request(`/api/admin/inventory/history?product=${product._id}&bucket=QUARANTINE`, { token: adminToken });
  assert.equal(history.status, 200);
  assert.equal(history.data.items.length, 1);
  assert.equal(history.data.items[0].stockAfter, 1);
});

test('purchase-time product policy blocks returns, permits exchanges and supports atomic customer cancellation', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ stock: 4, returnable: false, exchangeable: true, returnWindowDays: 14 });
  const { orderId, adminToken } = await deliveredOrder(token, product);
  const blocked = await request('/api/returns', { method: 'POST', token, body: { order: orderId, product: String(product._id), type: 'return', reason: 'Changed mind' } });
  assert.equal(blocked.status, 400);
  assert.match(blocked.data.message, /cannot be returned/i);
  const created = await request('/api/returns', { method: 'POST', token, body: { order: orderId, product: String(product._id), type: 'exchange', reason: 'Size or fit issue', exchangeSize: 'L', exchangeColor: 'Red' } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.policySnapshot.windowDays, 14);
  const list = await request('/api/admin/returns?page=1&limit=10', { token: adminToken });
  assert.equal(list.status, 200);
  assert.equal(list.data.items[0].user.password, undefined);
  const cancelled = await request(`/api/returns/${created.data._id}/cancel`, { method: 'PATCH', token, body: { comment: 'I no longer need a different size.' } });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.status, 'Cancelled');
  const repeated = await request(`/api/returns/${created.data._id}/cancel`, { method: 'PATCH', token, body: {} });
  assert.equal(repeated.status, 409);
  const replacement = await request('/api/returns', { method: 'POST', token, body: { order: orderId, product: String(product._id), type: 'exchange', reason: 'Size or fit issue', exchangeSize: 'L', exchangeColor: 'Red' } });
  assert.equal(replacement.status, 201, JSON.stringify(replacement.data));
});

test('invalid workflow jumps do not alter inventory or payment records', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ stock: 3 });
  const { orderId, adminToken } = await deliveredOrder(token, product);
  const created = await request('/api/returns', { method: 'POST', token, body: { order: orderId, product: String(product._id), type: 'return', reason: 'Changed mind' } });
  const skipped = await request(`/api/admin/returns/${created.data._id}/status`, { method: 'PUT', token: adminToken, body: { status: 'Refunded', refundAmount: 1000, refundReference: 'invalid-skip' } });
  assert.equal(skipped.status, 409);
  assert.equal(skipped.data.code, 'RETURN_TRANSITION_INVALID');
  assert.equal((await Product.findById(product._id)).stock, 2);
  const order = await Order.findById(orderId);
  assert.equal(order.refundedAmount, 0);
});

test('exchange price differences must be settled before allocating the replacement', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({
    stock: 4,
    variants: [
      { sku: 'RET-M-RED', size: 'M', color: 'Red', stock: 2, price: 1000, originalPrice: 1500, isActive: true },
      { sku: 'RET-L-RED', size: 'L', color: 'Red', stock: 2, price: 1200, originalPrice: 1600, isActive: true },
    ],
  });
  const replacement = product.variants.find(variant => variant.size === 'L');
  const { orderId, adminToken } = await deliveredOrder(token, product);
  const created = await request('/api/returns', {
    method: 'POST', token,
    body: { order: orderId, product: String(product._id), type: 'exchange', reason: 'Size or fit issue', exchangeVariantId: String(replacement._id) },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.financial.exchangePriceDifference, 200);
  assert.equal(created.data.financial.exchangeAdjustmentStatus, 'AMOUNT_DUE');

  for (const body of [
    { status: 'Approved' },
    { status: 'Received' },
    { status: 'QC Passed', inventoryDisposition: 'RESTOCK', receivedQuantity: 1, qcNotes: 'Sellable item.' },
  ]) {
    const updated = await request(`/api/admin/returns/${created.data._id}/status`, { method: 'PUT', token: adminToken, body });
    assert.equal(updated.status, 200, JSON.stringify(updated.data));
  }
  const inventory = await request('/api/admin/inventory/summary', { token: adminToken });
  assert.equal(inventory.status, 200);
  assert.equal(inventory.data.reserved, 0);
  const unsettled = await request(`/api/admin/returns/${created.data._id}/status`, { method: 'PUT', token: adminToken, body: { status: 'Exchange Allocated' } });
  assert.equal(unsettled.status, 400);
  assert.match(unsettled.data.message, /price difference/i);
  process.env.RAZORPAY_KEY_ID = 'rzp_test_exchange';
  process.env.RAZORPAY_KEY_SECRET = 'exchange-test-secret';
  const paymentLink = await request(`/api/admin/returns/${created.data._id}/exchange-adjustment/prepare`, { method: 'POST', token: adminToken, body: {} });
  delete process.env.RAZORPAY_KEY_ID;
  delete process.env.RAZORPAY_KEY_SECRET;
  assert.equal(paymentLink.status, 200, JSON.stringify(paymentLink.data));
  assert.equal(paymentLink.data.financial.exchangeAdjustmentStatus, 'PAYMENT_LINK_CREATED');
  assert.match(paymentLink.data.financial.exchangePaymentLinkUrl, /^https:\/\//);
  const allocated = await request(`/api/admin/returns/${created.data._id}/status`, { method: 'PUT', token: adminToken, body: { status: 'Exchange Allocated', exchangeAdjustmentSettled: true, exchangeAdjustmentReference: 'exchange-payment-001' } });
  assert.equal(allocated.status, 200, JSON.stringify(allocated.data));
  assert.equal(allocated.data.financial.exchangeAdjustmentStatus, 'SETTLED');
  assert.equal(allocated.data.financial.exchangeAdjustmentReference, 'exchange-payment-001');
  const allocatedInventory = await request('/api/admin/inventory/summary', { token: adminToken });
  assert.equal(allocatedInventory.status, 200);
  assert.equal(allocatedInventory.data.reserved, 1);
});
