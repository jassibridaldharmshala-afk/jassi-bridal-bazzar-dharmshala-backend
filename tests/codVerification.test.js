const test = require('node:test');
const assert = require('node:assert/strict');
const { request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createAdmin, createCustomer, createProduct, setSettings, validAddress } = require('./factories');
const Order = require('../models/Order');
const Otp = require('../models/Otp');
const Store = require('../models/Store');
const { createTargetOtp, verifyTargetOtp } = require('../services/otpService');
const { assertCodDispatchable, customerHistory, evaluateCodVerification } = require('../services/codVerificationService');

test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(async () => { await resetDatabase(); await setSettings({ smartCodVerificationEnabled: true, codRtoRestrictionLimit: 2 }); });

function body(product, suffix = '') {
  return { orderItems: [{ product: String(product._id), quantity: 1, size: 'M', color: 'Red' }], shippingAddress: validAddress(), paymentMethod: 'COD', checkoutAttemptId: `cod_verify_${suffix}_${Date.now()}` };
}

test('first COD order requires OTP and the correct code confirms it', async () => {
  const customer = await createCustomer(); const product = await createProduct();
  const created = await request('/api/orders/cod', { method: 'POST', token: customer.token, body: body(product, 'correct') });
  assert.equal(created.status, 201); assert.equal(created.data.codVerification.required, true); assert.equal(created.data.codVerification.status, 'PENDING');
  assert.equal(created.data.codVerification.trustState, undefined);
  const verified = await request(`/api/orders/${created.data._id}/cod-verification/verify`, { method: 'POST', token: customer.token, body: { otp: '123456' } });
  assert.equal(verified.status, 200); assert.equal(verified.data.orderStatus, 'Confirmed'); assert.equal(verified.data.codVerification.status, 'VERIFIED');
});

test('wrong and expired codes leave a first COD order unverified', async () => {
  const customer = await createCustomer(); const product = await createProduct();
  const created = await request('/api/orders/cod', { method: 'POST', token: customer.token, body: body(product, 'wrong') });
  const wrong = await request(`/api/orders/${created.data._id}/cod-verification/verify`, { method: 'POST', token: customer.token, body: { otp: '654321' } });
  assert.equal(wrong.status, 400); assert.equal((await Order.findById(created.data._id)).orderStatus, 'Pending');
  await Otp.updateOne({ contextId: String(created.data._id) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  const expired = await request(`/api/orders/${created.data._id}/cod-verification/verify`, { method: 'POST', token: customer.token, body: { otp: '123456' } });
  assert.equal(expired.status, 400); assert.match(expired.data.message, /expired/i);
});

test('trusted delivery bypasses OTP, but a later RTO requires it again', async () => {
  const customer = await createCustomer(); const product = await createProduct();
  await request('/api/settings');
  const store = await Store.findOne({ isDefault: true });
  await Order.create({ user: customer.user._id, storeId: store?._id, paymentMethod: 'COD', orderStatus: 'Delivered', deliveredAt: new Date(Date.now() - 20000) });
  let decision = await evaluateCodVerification({ paymentMethod: 'COD', userId: customer.user._id, storeId: store?._id, settings: { smartCodVerificationEnabled: true, codRtoRestrictionLimit: 2 }, phoneVerified: true });
  assert.equal(decision.verificationRequired, false); assert.equal(decision.customerTrustState, 'TRUSTED');
  const bypassed = await request('/api/orders/cod', { method: 'POST', token: customer.token, body: body(product, 'trusted') });
  assert.equal(bypassed.status, 201); assert.equal(bypassed.data.codVerification.required, false);
  await Order.create({ user: customer.user._id, storeId: store?._id, paymentMethod: 'COD', orderStatus: 'Shipped', rto: { status: 'IN_TRANSIT', triggeredAt: new Date() } });
  decision = await evaluateCodVerification({ paymentMethod: 'COD', userId: customer.user._id, storeId: store?._id, settings: { smartCodVerificationEnabled: true, codRtoRestrictionLimit: 2 }, phoneVerified: true });
  assert.equal(decision.verificationRequired, true); assert.equal(decision.verificationReason, 'RTO_HISTORY');
});

test('repeated RTO restricts only COD and counts an order once', async () => {
  const customer = await createCustomer();
  await Order.create({ user: customer.user._id, paymentMethod: 'COD', rto: { status: 'IN_TRANSIT', triggeredAt: new Date() } });
  const duplicateEventOrder = await Order.create({ user: customer.user._id, paymentMethod: 'COD', rto: { status: 'QC_PENDING', triggeredAt: new Date() } });
  await Order.updateOne({ _id: duplicateEventOrder._id }, { $set: { 'rto.status': 'RESTOCKED' } });
  const history = await customerHistory({ userId: customer.user._id });
  assert.equal(history.rtoCount, 2);
  const cod = await evaluateCodVerification({ paymentMethod: 'COD', userId: customer.user._id, settings: { smartCodVerificationEnabled: true, codRtoRestrictionLimit: 2 }, phoneVerified: true });
  const prepaid = await evaluateCodVerification({ paymentMethod: 'UPI', userId: customer.user._id, settings: { smartCodVerificationEnabled: true, codRtoRestrictionLimit: 2 }, phoneVerified: true });
  assert.equal(cod.codAllowed, false); assert.equal(prepaid.codAllowed, true); assert.equal(prepaid.verificationRequired, false);
});

test('admin and courier APIs cannot bypass pending COD verification', async () => {
  const customer = await createCustomer(); const admin = await createAdmin(); const product = await createProduct();
  const created = await request('/api/orders/cod', { method: 'POST', token: customer.token, body: body(product, 'dispatch') });
  const confirm = await request(`/api/admin/orders/${created.data._id}/status`, { method: 'PUT', token: admin.token, body: { orderStatus: 'Confirmed', revision: 0 } });
  assert.equal(confirm.status, 409); assert.equal(confirm.data.code, 'COD_VERIFICATION_REQUIRED');
  const book = await request(`/api/admin/orders/${created.data._id}/delivery/book`, { method: 'POST', token: admin.token, body: {} });
  assert.equal(book.status, 409); assert.equal(book.data.code, 'COD_VERIFICATION_REQUIRED');
});

test('order OTP is scoped, single-use and cannot cross orders or customers', async () => {
  const priorMode = process.env.OTP_MODE; process.env.OTP_MODE = 'production';
  try {
    const a = await createTargetOtp('9000000001', { purpose: 'order_cod_verification', contextId: 'order-a' });
    const b = await createTargetOtp('9000000001', { purpose: 'order_cod_verification', contextId: 'order-b' });
    await assert.rejects(() => verifyTargetOtp('9000000001', a.otp, { purpose: 'order_cod_verification', contextId: 'order-b' }), /Invalid OTP/);
    await assert.rejects(() => verifyTargetOtp('9000000002', a.otp, { purpose: 'order_cod_verification', contextId: 'order-a' }), /not found|expired/i);
    await verifyTargetOtp('9000000001', a.otp, { purpose: 'order_cod_verification', contextId: 'order-a' });
    await assert.rejects(() => verifyTargetOtp('9000000001', a.otp, { purpose: 'order_cod_verification', contextId: 'order-a' }), /not found|expired/i);
    assert.ok(b.otp);
  } finally { process.env.OTP_MODE = priorMode; }
});

test('old orders remain dispatch-compatible while explicitly pending new orders do not', () => {
  assert.doesNotThrow(() => assertCodDispatchable({ paymentMethod: 'COD' }));
  assert.throws(() => assertCodDispatchable({ paymentMethod: 'COD', codVerification: { required: true, status: 'PENDING' } }), /verification/i);
});
