const test = require('node:test');
const assert = require('node:assert/strict');
const { request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createCustomer, createAdmin, createProduct, setSettings, validAddress } = require('./factories');
const Otp = require('../models/Otp');
const { MASTER_OWNER_PHONE } = require('../config/masterOwner');
const { hashOtp } = require('../services/otpService');

test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(resetDatabase);

function gateway(t, provider) {
  const values = {
    OTP_MODE: 'production', SMS_PROVIDER: provider, ALLOW_HOSTED_OWNER_DEMO: 'false', LOCAL_OWNER_DEMO: 'false',
    SMS_ACCOUNT_SID: 'AC-test', SMS_AUTH_TOKEN: 'test-token', SMS_SENDER_ID: '+15005550006',
    MSG91_AUTH_KEY: 'msg91-test', MSG91_TEMPLATE_ID: 'otp-test', TWOFACTOR_API_KEY: 'twofactor-test', FAST2SMS_API_KEY: 'fast2sms-test',
  };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => Object.keys(values).forEach(key => { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }));
  const originalFetch = global.fetch;
  const messages = [];
  const state = { reject: false, messages };
  t.mock.method(console, 'warn', () => {});
  t.mock.method(global, 'fetch', async (value, options = {}) => {
    const url = new URL(value);
    if (url.hostname === '127.0.0.1') return originalFetch(value, options);
    let phone; let otp; let data;
    if (provider === 'twilio' && url.hostname === 'api.twilio.com') {
      phone = options.body.get('To'); otp = options.body.get('Body').match(/OTP is (\d{6})/)[1]; data = { sid: 'SM-test' };
    } else if (provider === 'msg91' && url.hostname === 'control.msg91.com') {
      const body = JSON.parse(options.body); phone = `+${body.mobile}`; otp = body.otp; data = { type: 'success', message: 'request-test' };
    } else if (provider === 'twofactor' && url.hostname === '2factor.in') {
      const parts = url.pathname.split('/').map(decodeURIComponent); phone = parts[5]; otp = parts[6]; data = { Status: 'Success', Details: 'session-test' };
    } else if (provider === 'fast2sms' && url.hostname === 'www.fast2sms.com') {
      const body = JSON.parse(options.body); phone = `+91${body.numbers}`; otp = body.variables_values; data = { return: true, request_id: 'request-test' };
    } else assert.fail('Unexpected external request');
    messages.push({ phone, otp });
    return { ok: !state.reject, status: state.reject ? 401 : 200, json: async () => state.reject ? { message: 'rejected-test-key' } : data };
  });
  return state;
}

function noExposedOtp(result) {
  assert.equal(result.data.demoOtp, undefined);
  assert.equal(result.data.devOtp, undefined);
  assert.equal(result.data.otp, undefined);
}

for (const [index, provider] of ['twilio', 'msg91', 'twofactor', 'fast2sms'].entries()) {
  test(`${provider}: customer/admin login, resend, phone changes and COD use the existing verification flow`, async t => {
    const sms = gateway(t, provider);
    const phone = `98765432${10 + index}`;
    const send = await request('/api/auth/send-otp', { method: 'POST', body: { phone } });
    assert.equal(send.status, 200, JSON.stringify(send.data)); noExposedOtp(send);
    const first = await Otp.findOne({ phone, isUsed: false });
    assert.equal(first.otpHash, hashOtp(phone, sms.messages.at(-1).otp));
    const resent = await request('/api/auth/resend-otp', { method: 'POST', body: { phone } });
    assert.equal(resent.status, 200); noExposedOtp(resent);
    assert.equal((await Otp.findById(first._id)).isUsed, true);
    assert.equal((await request('/api/auth/verify-otp', { method: 'POST', body: { phone, otp: '000000' } })).status, 400);
    const login = await request('/api/auth/verify-otp', { method: 'POST', body: { phone, otp: sms.messages.at(-1).otp } });
    assert.equal(login.status, 200); assert.ok(login.data.token);

    const admin = await createAdmin();
    assert.equal((await request('/api/auth/send-otp', { method: 'POST', body: { phone: admin.user.phone } })).status, 200);
    const adminLogin = await request('/api/auth/verify-otp', { method: 'POST', body: { phone: admin.user.phone, otp: sms.messages.at(-1).otp } });
    assert.equal(adminLogin.status, 200); assert.ok(adminLogin.data.token);

    const changedPhone = `97654321${10 + index}`;
    const changed = await request('/api/auth/profile/send-phone-change-otp', { method: 'POST', token: login.data.token, body: { phone: changedPhone } });
    assert.equal(changed.status, 200); noExposedOtp(changed);
    const verified = await request('/api/auth/profile/verify-phone-change-otp', { method: 'POST', token: login.data.token, body: { phone: changedPhone, otp: sms.messages.at(-1).otp } });
    assert.equal(verified.status, 200); assert.ok(verified.data.verificationToken);

    await setSettings({ smartCodVerificationEnabled: true });
    const customer = await createCustomer(); const product = await createProduct();
    const created = await request('/api/orders/cod', { method: 'POST', token: customer.token, body: {
      orderItems: [{ product: String(product._id), quantity: 1, size: 'M', color: 'Red' }],
      shippingAddress: validAddress({ mobile: customer.user.phone }), paymentMethod: 'COD', checkoutAttemptId: `provider_${provider}`,
    } });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.equal(created.data.codVerification.status, 'PENDING');
    const cod = await request(`/api/orders/${created.data._id}/cod-verification/verify`, { method: 'POST', token: customer.token, body: { otp: sms.messages.at(-1).otp } });
    assert.equal(cod.status, 200, JSON.stringify(cod.data));
    assert.equal(cod.data.codVerification.status, 'VERIFIED'); assert.equal(cod.data.orderStatus, 'Confirmed');
  });

  test(`${provider}: trusted owner OTP and failure recovery keep their security guarantees`, async t => {
    const sms = gateway(t, provider);
    sms.reject = true;
    const failed = await request('/api/auth/send-otp', { method: 'POST', body: { phone: MASTER_OWNER_PHONE } });
    assert.equal(failed.status, 503); noExposedOtp(failed);
    assert.equal(await Otp.countDocuments({ phone: MASTER_OWNER_PHONE, isUsed: false }), 0);
    assert.doesNotMatch(JSON.stringify(failed.data), /rejected-test-key/);
    sms.reject = false;
    const retried = await request('/api/auth/resend-otp', { method: 'POST', body: { phone: MASTER_OWNER_PHONE } });
    assert.equal(retried.status, 200); noExposedOtp(retried);
    const record = await Otp.findOne({ phone: MASTER_OWNER_PHONE, isUsed: false });
    assert.equal(record.trustedDelivery, true); assert.equal(record.provider, provider);
    const otp = sms.messages.at(-1).otp;
    const verified = await request('/api/auth/verify-otp', { method: 'POST', body: { phone: MASTER_OWNER_PHONE, otp } });
    assert.equal(verified.status, 200, JSON.stringify(verified.data));
    assert.ok(verified.data.token);
    assert.equal((await request('/api/auth/verify-otp', { method: 'POST', body: { phone: MASTER_OWNER_PHONE, otp } })).status, 400);
  });
}
