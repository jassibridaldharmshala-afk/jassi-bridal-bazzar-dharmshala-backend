const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers'), F = require('./factories');
const Order = require('../models/Order'), User = require('../models/User');

test.before(H.startTestEnvironment);
test.after(H.stopTestEnvironment);
test.beforeEach(async () => {
  await H.resetDatabase(); await F.setSettings({ razorpayEnabled: true });
  process.env.RAZORPAY_KEY_ID = 'rzp_test_identity';
  process.env.RAZORPAY_KEY_SECRET = 'identity_test_secret';
});

const enteredAddress = () => F.validAddress({ fullName: 'Rohit Shekhawat', email: ' ROHIT@EXAMPLE.COM ', mobile: '9876543210' });
const generatedUser = () => F.createCustomer({ name: 'Jassi User 0907', phone: '9000000907', email: 'phone+9000000907@samira.local' });

for (const paymentMethod of ['COD', 'UPI']) test(`${paymentMethod} orders keep the entered customer identity in admin and receipts after profile changes`, async () => {
  const { user, token } = await generatedUser(), admin = await F.createAdmin(), product = await F.createProduct();
  const saved = await H.request('/api/user/addresses', { method: 'POST', token, body: enteredAddress() });
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  assert.equal(saved.data[0].email, 'rohit@example.com');
  const result = await H.request(paymentMethod === 'COD' ? '/api/orders/cod' : '/api/payments/create-order', {
    method: 'POST', token, body: { paymentMethod, shippingAddress: saved.data[0], orderItems: [{ product: String(product._id), quantity: 1 }] },
  });
  assert.ok([200, 201].includes(result.status), JSON.stringify(result.data));
  const id = paymentMethod === 'COD' ? result.data._id : result.data.orderId;
  const identity = { name: 'Rohit Shekhawat', email: 'rohit@example.com', phone: '9876543210' };
  assert.deepEqual((await Order.findById(id).lean()).customer, identity);
  await User.updateOne({ _id: user._id }, { $set: { name: 'Changed account name', email: 'changed@example.com' } });
  const detail = await H.request(`/api/admin/orders/${id}`, { token: admin.token });
  assert.equal(detail.status, 200); assert.deepEqual(detail.data.customer, identity);
  const dashboard = await H.request('/api/admin/dashboard/overview?range=30d', { token: admin.token });
  assert.equal(dashboard.status, 200, JSON.stringify(dashboard.data));
  assert.deepEqual(dashboard.data.recentOrders.find(order => String(order._id) === String(id)).customer, identity);
  const receipt = await H.request(`/api/orders/${id}/receipt`, { token });
  assert.equal(receipt.status, 200, JSON.stringify(receipt.data)); assert.deepEqual(receipt.data.customer, identity);
  const searched = await H.request('/api/admin/orders?search=rohit%40example.com', { token: admin.token });
  const rows = Array.isArray(searched.data) ? searched.data : searched.data.items;
  assert.equal(searched.status, 200); assert.ok(rows.some(row => String(row._id) === String(id)));
});

test('blank order email stays blank and cannot fall back to an internal login email', async () => {
  const { token } = await generatedUser(), product = await F.createProduct();
  const result = await H.request('/api/orders/cod', { method: 'POST', token, body: { paymentMethod: 'COD', shippingAddress: enteredAddress(), orderItems: [{ product: String(product._id), quantity: 1 }] } });
  assert.equal(result.status, 201);
  const blank = await H.request('/api/orders/cod', { method: 'POST', token, body: { paymentMethod: 'COD', shippingAddress: { ...enteredAddress(), email: '' }, orderItems: [{ product: String(product._id), quantity: 1 }] } });
  assert.equal(blank.status, 201); assert.equal(blank.data.customer.email, '');
  const receipt = await H.request(`/api/orders/${blank.data._id}/receipt`, { token });
  assert.equal(receipt.data.customer.email, '');
});

test('old orders use their saved recipient and hide internal account email in receipts', async () => {
  const { user, token } = await generatedUser();
  const legacy = await Order.create({ user: user._id, shippingAddress: F.validAddress({ fullName: 'Priya Sharma' }), orderItems: [], paymentMethod: 'COD', finalAmount: 100 });
  const receipt = await H.request(`/api/orders/${legacy._id}/receipt`, { token });
  assert.equal(receipt.status, 200); assert.equal(receipt.data.customer.name, 'Priya Sharma'); assert.equal(receipt.data.customer.email, '');
});

test('changing entered email cannot replay an old checkout attempt or create a duplicate order', async () => {
  const { token } = await generatedUser(), product = await F.createProduct();
  const body = { checkoutAttemptId: 'customer_identity_attempt_001', paymentMethod: 'COD', shippingAddress: enteredAddress(), orderItems: [{ product: String(product._id), quantity: 1 }] };
  const first = await H.request('/api/orders/cod', { method: 'POST', token, body }); assert.equal(first.status, 201);
  const changed = await H.request('/api/orders/cod', { method: 'POST', token, body: { ...body, shippingAddress: { ...body.shippingAddress, email: 'other@example.com' } } });
  assert.equal(changed.status, 409); assert.equal(await Order.countDocuments(), 1);
});

test('checkout rejects a generated recipient name or invalid optional email', async () => {
  const { token } = await generatedUser(), product = await F.createProduct();
  for (const shippingAddress of [{ ...enteredAddress(), fullName: 'Jassi User 0907' }, { ...enteredAddress(), email: 'invalid-email' }]) {
    const result = await H.request('/api/orders/cod', { method: 'POST', token, body: { paymentMethod: 'COD', shippingAddress, orderItems: [{ product: String(product._id), quantity: 1 }] } });
    assert.equal(result.status, 400, JSON.stringify(result.data));
  }
  assert.equal(await Order.countDocuments(), 0);
});
