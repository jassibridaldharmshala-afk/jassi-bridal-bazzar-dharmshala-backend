const test = require('node:test');
const assert = require('node:assert/strict');

const { request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createAdmin, createCustomer, createProduct, setSettings, validAddress } = require('./factories');
const ContactMessage = require('../models/ContactMessage');
const Subscriber = require('../models/Subscriber');

test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(async () => {
  await resetDatabase();
  await setSettings();
});

test('a contact form message is stored for admin review', async () => {
  const { status, data } = await request('/api/contact', {
    method: 'POST',
    body: {
      name: 'Asha',
      email: 'asha@test.local',
      message: 'Please help with my order size.',
    },
  });

  assert.equal(status, 201);
  assert.equal(await ContactMessage.countDocuments(), 1);
  assert.equal(data.success, true);

  const { token } = await createAdmin();
  const inbox = await request('/api/admin/contact', { token });
  assert.equal(inbox.status, 200);
  assert.equal(inbox.data.length, 1);
  assert.equal(inbox.data[0].name, 'Asha');
});

test('newsletter subscribe is stored and duplicate emails are not faked as new', async () => {
  const first = await request('/api/newsletter/subscribe', {
    method: 'POST',
    body: { email: 'style@test.local' },
  });
  assert.equal(first.status, 201);

  const second = await request('/api/newsletter/subscribe', {
    method: 'POST',
    body: { email: 'style@test.local' },
  });
  assert.equal(second.status, 200);
  assert.equal(second.data.alreadySubscribed, true);
  assert.equal(await Subscriber.countDocuments(), 1);
});

test('reports use real order data for the selected range', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ price: 1000, originalPrice: 1000, stock: 5 });
  await request('/api/orders/cod', {
    method: 'POST',
    token,
    body: {
      orderItems: [{ product: String(product._id), quantity: 1 }],
      shippingAddress: validAddress(),
      paymentMethod: 'COD',
    },
  });

  const { token: adminToken } = await createAdmin();
  const sales = await request('/api/admin/reports/sales?range=30d', { token: adminToken });
  assert.equal(sales.status, 200);
  assert.equal(sales.data.totals.orders, 1);
  assert.ok(Array.isArray(sales.data.series));

  const products = await request('/api/admin/reports/products?range=30d', { token: adminToken });
  assert.equal(products.status, 200);
  assert.equal(products.data.bestSellers[0].sold, 1);
});
