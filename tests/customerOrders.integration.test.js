require('./clientTestSetup.cjs');
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers'), F = require('./factories');
const Store = require('../models/Store'), Order = require('../models/Order');
const { ensureDefaultStore } = require('../services/storeService');
let store, boutique, customer, other;
before(H.startTestEnvironment);
after(H.stopTestEnvironment);
beforeEach(async () => {
  await H.resetDatabase(); store = await ensureDefaultStore();
  boutique = await Store.create({ name: 'Other boutique', slug: 'history-other', status: 'PUBLISHED', plan: 'PREMIUM', license: { status: 'ACTIVE', billingCycle: 'LIFETIME', startsAt: new Date() } });
  customer = await F.createCustomer(); other = await F.createCustomer();
  const row = (storeId, user, name) => ({ ...(storeId ? { storeId } : {}), user, orderItems: [{ name, quantity: 1, price: 1000 }], finalAmount: 1000, paymentMethod: 'COD', paymentStatus: 'Paid', orderStatus: 'Delivered', invoiceNumber: name });
  await Order.create([row(store._id, customer.user._id, 'Default sale'), row(null, customer.user._id, 'Legacy sale'), row(boutique._id, customer.user._id, 'Other boutique sale'), row(store._id, other.user._id, 'Another customer sale')]);
});
test('default sale history and counts include owned legacy orders and exclude foreign store/customer orders', async () => {
  const response = await H.request('/api/orders/my-orders?page=1&limit=12&store=', { token: customer.token });
  assert.equal(response.status, 200); assert.equal(response.data.total, 2);
  assert.deepEqual(response.data.items.map(row => row.invoiceNumber).sort(), ['Default sale', 'Legacy sale']);
});
test('explicit boutique history uses the same store boundary as its detail endpoint', async () => {
  const response = await H.request('/api/orders/my-orders?page=1&limit=12&store=history-other', { token: customer.token });
  assert.equal(response.status, 200); assert.equal(response.data.total, 1);
  assert.equal(response.data.items[0].invoiceNumber, 'Other boutique sale');
  const detail = await H.request('/api/orders/' + response.data.items[0]._id + '?store=history-other', { token: customer.token });
  assert.equal(detail.status, 200);
});
test('search and pagination counts cannot include matching records from a foreign store', async () => {
  const response = await H.request('/api/orders/my-orders?page=1&limit=1&search=sale&status=Delivered&store=', { token: customer.token });
  assert.equal(response.status, 200); assert.equal(response.data.total, 2); assert.equal(response.data.totalPages, 2);
  assert.equal(response.data.items.length, 1);
  const foreign = await H.request('/api/orders/my-orders?page=1&search=Other%20boutique&store=', { token: customer.token });
  assert.equal(foreign.data.total, 0);
});
test('legacy array callers retain ownership and tenant filtering', async () => {
  const response = await H.request('/api/orders/my-orders?store=history-other', { token: customer.token });
  assert.equal(response.status, 200); assert.equal(response.data.length, 1); assert.equal(response.data[0].invoiceNumber, 'Other boutique sale');
});
