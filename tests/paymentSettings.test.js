const test = require('node:test');
const assert = require('node:assert/strict');

const { request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createAdmin, createCustomer, createProduct, setSettings, validAddress } = require('./factories');
const Order = require('../models/Order');

test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(async () => {
  await resetDatabase();
  delete process.env.RAZORPAY_KEY_ID;
  delete process.env.RAZORPAY_KEY_SECRET;
  delete process.env.RAZORPAY_WEBHOOK_SECRET;
});

function orderBody(product, overrides = {}) {
  return {
    orderItems: [{ product: String(product._id), quantity: 1 }],
    shippingAddress: validAddress(),
    paymentMethod: 'COD',
    ...overrides,
  };
}

test('COD disabled in settings hides the method and rejects a crafted COD order', async () => {
  await setSettings({ codEnabled: false });
  const { token } = await createCustomer();
  const product = await createProduct({ stock: 5 });

  const methods = await request('/api/settings/payment-methods');
  assert.equal(methods.data.methods.some((option) => option.key === 'COD'), false);

  const { status, data } = await request('/api/orders/cod', { method: 'POST', token, body: orderBody(product) });
  assert.equal(status, 400);
  assert.equal(data.code, 'PAYMENT_METHOD_UNAVAILABLE');
  assert.equal(await Order.countDocuments(), 0);
});

test('the configured COD charge is added by the backend', async () => {
  await setSettings({ codEnabled: true, codCharge: 49, deliveryCharge: 0, freeShippingMinAmount: 0 });
  const { token } = await createCustomer();
  const product = await createProduct({ price: 700, originalPrice: 700, stock: 5 });

  const { data } = await request('/api/orders/cod', { method: 'POST', token, body: orderBody(product) });

  assert.equal(data.codCharge, 49);
  assert.equal(data.finalAmount, 749);
});

test('no COD charge is applied to an online payment method', async () => {
  await setSettings({ codEnabled: true, codCharge: 49, razorpayEnabled: true, deliveryCharge: 0, freeShippingMinAmount: 0 });
  process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
  process.env.RAZORPAY_KEY_SECRET = 'rzp_test_secret';
  const { token } = await createCustomer();
  const product = await createProduct({ price: 700, originalPrice: 700, stock: 5 });

  const { data } = await request('/api/orders/quote', {
    method: 'POST',
    token,
    body: { orderItems: [{ product: String(product._id), quantity: 1 }], paymentMethod: 'UPI' },
  });

  assert.equal(data.totals.codCharge, 0);
  assert.equal(data.totals.finalAmount, 700);
});

test('COD above the configured maximum is rejected', async () => {
  await setSettings({ codEnabled: true, codMaxAmount: 1000, deliveryCharge: 0, freeShippingMinAmount: 0 });
  const { token } = await createCustomer();
  const product = await createProduct({ price: 1500, originalPrice: 1500, stock: 5 });

  const { status, data } = await request('/api/orders/cod', { method: 'POST', token, body: orderBody(product) });
  assert.equal(status, 400);
  assert.equal(data.code, 'PAYMENT_METHOD_UNAVAILABLE');
  assert.match(data.message, /1000/);
});

test('COD within the configured maximum is accepted', async () => {
  await setSettings({ codEnabled: true, codMaxAmount: 5000, deliveryCharge: 0, freeShippingMinAmount: 0 });
  const { token } = await createCustomer();
  const product = await createProduct({ price: 1500, originalPrice: 1500, stock: 5 });

  const { status } = await request('/api/orders/cod', { method: 'POST', token, body: orderBody(product) });
  assert.equal(status, 201);
});

test('an online method is refused when Razorpay is disabled in settings', async () => {
  await setSettings({ razorpayEnabled: false, codEnabled: true });
  const { token } = await createCustomer();
  const product = await createProduct({ stock: 5 });

  const { status, data } = await request('/api/orders', {
    method: 'POST',
    token,
    body: orderBody(product, { paymentMethod: 'UPI' }),
  });

  assert.equal(status, 400);
  assert.equal(data.code, 'PAYMENT_METHOD_UNAVAILABLE');
});

test('an online method is refused when Razorpay is enabled but not configured', async () => {
  await setSettings({ razorpayEnabled: true, codEnabled: true });
  const { token } = await createCustomer();
  const product = await createProduct({ stock: 5 });

  const methods = await request('/api/settings/payment-methods');
  const upi = methods.data.methods.find((option) => option.key === 'UPI');
  assert.equal(upi.enabled, false);

  const { status } = await request('/api/orders', { method: 'POST', token, body: orderBody(product, { paymentMethod: 'UPI' }) });
  assert.equal(status, 400);
});

test('all configured online methods are offered and admin readiness exposes no secrets', async () => {
  await setSettings({
    razorpayEnabled: true,
    upiEnabled: true,
    cardPaymentEnabled: true,
    netBankingEnabled: true,
    walletEnabled: true,
  });
  process.env.RAZORPAY_KEY_ID = 'rzp_test_safe_key';
  process.env.RAZORPAY_KEY_SECRET = 'server-only-secret';
  process.env.RAZORPAY_WEBHOOK_SECRET = 'server-only-webhook-secret';
  const { token } = await createAdmin();

  const methods = await request('/api/settings/payment-methods');
  const online = methods.data.methods.filter((option) => option.key !== 'COD');
  assert.deepEqual(online.map((option) => option.key), ['UPI', 'CARD', 'NETBANKING', 'WALLET']);
  assert.equal(online.every((option) => option.enabled), true);
  assert.equal(methods.data.gateway.ready, true);

  const readiness = await request('/api/admin/settings/payment-readiness', { token });
  assert.equal(readiness.status, 200);
  assert.deepEqual(readiness.data, {
    provider: 'Razorpay',
    enabled: true,
    configured: true,
    ready: true,
    mode: 'test',
    webhookConfigured: true,
    disabledReason: '',
  });
  assert.equal(JSON.stringify(readiness.data).includes('server-only'), false);
});

test('an individually disabled online method is not offered and is rejected', async () => {
  await setSettings({ razorpayEnabled: true, codEnabled: true, walletEnabled: false });
  process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
  process.env.RAZORPAY_KEY_SECRET = 'rzp_test_secret';
  const { token } = await createCustomer();
  const product = await createProduct({ stock: 5 });

  const methods = await request('/api/settings/payment-methods');
  assert.equal(methods.data.methods.some((option) => option.key === 'WALLET'), false);
  assert.equal(methods.data.methods.some((option) => option.key === 'UPI' && option.enabled), true);

  const { status, data } = await request('/api/orders', { method: 'POST', token, body: orderBody(product, { paymentMethod: 'WALLET' }) });
  assert.equal(status, 400);
  assert.equal(data.code, 'PAYMENT_METHOD_UNAVAILABLE');
});

test('an unknown payment method is rejected', async () => {
  await setSettings({ codEnabled: true });
  const { token } = await createCustomer();
  const product = await createProduct({ stock: 5 });

  const { status, data } = await request('/api/orders', { method: 'POST', token, body: orderBody(product, { paymentMethod: 'CRYPTO' }) });
  assert.equal(status, 400);
  assert.equal(data.code, 'PAYMENT_METHOD_UNAVAILABLE');
});

test('free shipping applies above the configured threshold', async () => {
  await setSettings({ codEnabled: true, codCharge: 0, deliveryCharge: 99, freeShippingMinAmount: 999 });
  const { token } = await createCustomer();
  const cheap = await createProduct({ price: 500, originalPrice: 500, stock: 5 });
  const pricey = await createProduct({ price: 1500, originalPrice: 1500, stock: 5 });

  const below = await request('/api/orders/quote', { method: 'POST', token, body: { orderItems: [{ product: String(cheap._id), quantity: 1 }], paymentMethod: 'COD' } });
  assert.equal(below.data.totals.deliveryCharge, 99);

  const above = await request('/api/orders/quote', { method: 'POST', token, body: { orderItems: [{ product: String(pricey._id), quantity: 1 }], paymentMethod: 'COD' } });
  assert.equal(above.data.totals.deliveryCharge, 0);
});
