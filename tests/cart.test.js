const test = require('node:test');
const assert = require('node:assert/strict');

const { request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createCustomer, createProduct, setSettings } = require('./factories');

test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(async () => {
  await resetDatabase();
  await setSettings({ razorpayEnabled: false, codEnabled: true });
});

test('an authenticated cart validates stock and variant availability', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ stock: 2, price: 800, originalPrice: 1000 });

  const added = await request('/api/cart', {
    method: 'POST',
    token,
    body: { product: String(product._id), quantity: 1, size: 'M', color: 'Red' },
  });
  assert.equal(added.status, 201);
  assert.equal(added.data.items.length, 1);
  assert.equal(added.data.items[0].quantity, 1);

  const oversold = await request('/api/cart', {
    method: 'POST',
    token,
    body: { product: String(product._id), quantity: 5, size: 'M', color: 'Red' },
  });
  assert.equal(oversold.status, 409);
  assert.equal(oversold.data.code, 'OUT_OF_STOCK');

  const missingSize = await request('/api/cart', {
    method: 'POST',
    token,
    body: { product: String(product._id), quantity: 1, color: 'Red' },
  });
  assert.equal(missingSize.status, 409);
  assert.equal(missingSize.data.code, 'VARIANT_UNAVAILABLE');
});

test('a free-size product can be added without inventing a clothing size', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ name: 'Ivory silk saree', sizingMode: 'free-size', sizes: [], colors: [] });
  const added = await request('/api/cart', {
    method: 'POST',
    token,
    body: { product: String(product._id), quantity: 1 },
  });
  assert.equal(added.status, 201);
  assert.equal(added.data.items[0].size, '');
});

test('cart refuses an inactive product', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ stock: 4, isActive: false });
  const added = await request('/api/cart', {
    method: 'POST',
    token,
    body: { product: String(product._id), quantity: 1 },
  });
  assert.ok(added.status >= 400);
});
