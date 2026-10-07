const test = require('node:test');
const assert = require('node:assert/strict');
const { request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createAdmin, createCustomer, createProduct, setSettings } = require('./factories');
const { createProvisionedSeller } = require('./accessFixtures');
const CustomerCrm = require('../models/CustomerCrm');
const Order = require('../models/Order');
const ReturnExchange = require('../models/ReturnExchange');
const Shipment = require('../models/Shipment');
const Store = require('../models/Store');
const { assertCustomerCanCheckout } = require('../services/customerAccessService');
const { applyCustomerRtoToPaymentOptions } = require('../services/paymentSettingsService');

test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(async () => { await resetDatabase(); await setSettings(); });

async function call(method, path, body, token, expected = 200, headers = {}) {
  const result = await request(path, { method, body, token, headers });
  assert.equal(result.status, expected, `${method} ${path}: ${JSON.stringify(result.data)}`);
  return result.data;
}

test('customer 360 is store isolated and calculates paid net revenue, approved returns and courier RTO separately', async () => {
  const seller = await createProvisionedSeller('Customer Intelligence');
  await Store.updateOne({ _id: seller.store.id }, { status: 'PUBLISHED' });
  const headers = { 'x-store-id': seller.store.id };
  const customer = await createCustomer();
  const product = await createProduct({ storeId: seller.store.id, sizingMode: 'free-size', sizes: [] });
  const deliveredCod = await Order.create({
    storeId: seller.store.id, user: customer.user._id, orderItems: [{ product: product._id, name: product.name, quantity: 1, price: 2000, size: 'Free Size', color: 'Wine' }],
    finalAmount: 2000, paymentMethod: 'COD', paymentStatus: 'Pending', paymentState: 'PENDING', orderStatus: 'Delivered', deliveredAt: new Date(),
  });
  const paidOnline = await Order.create({
    storeId: seller.store.id, user: customer.user._id, orderItems: [{ product: product._id, name: product.name, quantity: 1, price: 1000, color: 'Wine' }],
    finalAmount: 1000, refundedAmount: 300, refunds: [{ amount: 300, status: 'PROCESSED' }], paymentMethod: 'UPI', paymentStatus: 'Paid', paymentState: 'PARTIALLY_REFUNDED', orderStatus: 'Confirmed',
  });
  await Order.create({ storeId: seller.store.id, user: customer.user._id, orderItems: [{ product: product._id, quantity: 1, price: 5000 }], finalAmount: 5000, paymentMethod: 'UPI', paymentStatus: 'Failed', paymentState: 'FAILED', orderStatus: 'Pending' });
  await ReturnExchange.create({ storeId: seller.store.id, order: deliveredCod._id, product: product._id, user: customer.user._id, type: 'return', status: 'Rejected', quantity: 1 });
  await ReturnExchange.create({ storeId: seller.store.id, order: paidOnline._id, product: product._id, user: customer.user._id, type: 'return', status: 'Approved', quantity: 1 });
  await Shipment.create({ storeId: seller.store.id, order: deliveredCod._id, status: 'RETURNED', provider: 'manual' });

  const list = await call('GET', '/api/seller/crm?page=1&limit=20', undefined, seller.token, 200, headers);
  assert.equal(list.total, 1);
  assert.equal(list.items[0].orders, 2);
  assert.equal(list.items[0].paidOrders, 2);
  assert.equal(list.items[0].grossSpend, 3000);
  assert.equal(list.items[0].refunded, 300);
  assert.equal(list.items[0].netSpend, 2700);
  assert.equal(list.items[0].returns, 1);
  assert.equal(list.items[0].rtoCount, 1);
  assert.ok(list.items[0].phoneMasked.endsWith(customer.user.phone.slice(-4)));
  assert.equal(Object.hasOwn(list.items[0], 'phone'), false);
  const rtoPaymentOptions = await applyCustomerRtoToPaymentOptions([{ key: 'COD', enabled: true }], {
    userId: customer.user._id, tenantFilter: { storeId: seller.store.id },
    settings: { rtoBlockEnabled: true, rtoBlockMinOrders: 2, rtoBlockThreshold: 0.3 },
  });
  assert.equal(rtoPaymentOptions[0].enabled, false);

  const otherSeller = await createProvisionedSeller('Unrelated Customers');
  const isolated = await call('GET', '/api/seller/crm?page=1', undefined, otherSeller.token, 200, { 'x-store-id': otherSeller.store.id });
  assert.equal(isolated.total, 0);

  const detail = await call('GET', `/api/seller/crm/${customer.user._id}`, undefined, seller.token, 200, headers);
  assert.equal(detail.customer.phone, customer.user.phone);
  assert.equal(detail.metrics.netSpend, 2700);
  assert.equal(detail.insights.favoriteProducts[0].product.name, product.name);
});

test('customer profile revisions prevent lost updates and store restrictions enforce checkout without globally blocking login', async () => {
  const seller = await createProvisionedSeller('Customer Controls');
  await Store.updateOne({ _id: seller.store.id }, { status: 'PUBLISHED' });
  const headers = { 'x-store-id': seller.store.id };
  const customer = await createCustomer();
  await Order.create({ storeId: seller.store.id, user: customer.user._id, finalAmount: 800, paymentMethod: 'COD', orderStatus: 'Delivered' });

  const anniversaryDate = new Date();
  anniversaryDate.setDate(anniversaryDate.getDate() + 5);
  anniversaryDate.setFullYear(2020);
  const saved = await call('PUT', `/api/seller/crm/${customer.user._id}`, { revision: 0, manualTags: ['Priority Support'], notes: 'Call after 5 pm', anniversaryDate, channelConsents: { whatsapp: { granted: true, source: 'CUSTOMER', reference: 'Support call' } } }, seller.token, 200, headers);
  assert.equal(saved.revision, 1);
  assert.equal(saved.channelConsents.whatsapp.granted, true);
  assert.equal(new Date(saved.anniversaryDate).getMonth(), anniversaryDate.getMonth());
  assert.equal((await call('GET', '/api/seller/crm?page=1&segment=Anniversary%20upcoming', undefined, seller.token, 200, headers)).total, 1);
  await call('PUT', `/api/seller/crm/${customer.user._id}`, { revision: 0, notes: 'Stale edit' }, seller.token, 409, headers);

  const restricted = await call('PUT', `/api/seller/crm/${customer.user._id}/restrictions`, { revision: 1, checkoutRestricted: false, codRestricted: true, marketingSuppressed: true, supportWatchlist: true, reason: 'Repeated delivery refusal' }, seller.token, 200, headers);
  assert.equal(restricted.restrictions.codRestricted, true);
  assert.equal((await CustomerCrm.findOne({ storeId: seller.store.id, user: customer.user._id })).restrictions.checkoutRestricted, false);
  await assert.rejects(() => assertCustomerCanCheckout({ storeId: seller.store.id, userId: customer.user._id, paymentMethod: 'COD' }), (error) => error.errorCode === 'COD_RESTRICTED');
  await assert.doesNotReject(() => assertCustomerCanCheckout({ storeId: seller.store.id, userId: customer.user._id, paymentMethod: 'UPI' }));
  assert.equal((await call('GET', '/api/auth/me', undefined, customer.token)).phone, customer.user.phone);

  const privacy = await call('POST', `/api/seller/crm/${customer.user._id}/privacy-requests`, { type: 'DATA_EXPORT' }, seller.token, 201, headers);
  assert.equal(privacy.status, 'OPEN');
  await call('POST', `/api/seller/crm/${customer.user._id}/privacy-requests`, { type: 'DATA_EXPORT' }, seller.token, 409, headers);
  const customerRequests = await call('GET', '/api/auth/privacy-requests', undefined, customer.token, 200, { 'x-store-slug': seller.store.slug });
  assert.equal(customerRequests.length, 1);
  const completed = await call('PATCH', `/api/seller/crm/${customer.user._id}/privacy-requests/${privacy._id}`, { status: 'COMPLETED', resolution: 'Secure export delivered to the verified customer.' }, seller.token, 200, headers);
  assert.equal(completed.status, 'COMPLETED');
});

test('global identity listing and blocking are reserved for the authenticated master owner', async () => {
  const admin = await createAdmin();
  const customer = await createCustomer();
  const unrelated = await createProvisionedSeller('Protected Tenant');
  await Store.updateOne({ _id: unrelated.store.id }, { status: 'PUBLISHED' });
  await call('GET', '/api/admin/customers', undefined, admin.token, 403);
  await call('GET', `/api/admin/customer-crm?page=1&store=${encodeURIComponent(unrelated.store.slug)}`, undefined, admin.token, 403);
  await call('PATCH', `/api/admin/customers/${customer.user._id}/block`, { isBlocked: true }, admin.token, 403);
  assert.equal((await call('GET', '/api/auth/me', undefined, customer.token)).phone, customer.user.phone);
});
