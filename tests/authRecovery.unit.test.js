const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { getJwtRefreshSecret, getJwtSecret } = require('../config/env');
const { protect } = require('../middleware/authMiddleware');
const { refresh } = require('../controllers/authController');
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const token = (refreshToken = false, extra = {}) => jwt.sign({ id: '0123456789abcdef01234567', ...(refreshToken ? { tokenType: 'refresh' } : {}), ...extra }, refreshToken ? getJwtRefreshSecret() : getJwtSecret());

test('temporary database failure keeps valid access and refresh credentials recoverable', async (t) => {
  t.mock.method(User, 'findById', () => ({ select: async () => { throw new Error('Database unavailable'); } }));
  const access = response();
  await protect({ headers: { authorization: `Bearer ${token()}` } }, access, () => assert.fail('Must not authorize'));
  assert.equal(access.statusCode, 503);
  const renewed = response();
  await refresh({ body: { refreshToken: token(true) } }, renewed);
  assert.equal(renewed.statusCode, 503);
  assert.equal(renewed.body.code, 'SERVICE_UNAVAILABLE');
  assert.equal(JSON.stringify(renewed.body).includes('Database unavailable'), false);
});

test('invalid and expired credentials remain unauthorized, while missing accounts cannot refresh', async (t) => {
  t.mock.method(User, 'findById', () => ({ select: async () => null }));
  for (const value of ['bad-token', token(true, { exp: 1 }), token(true)]) {
    const res = response(); await refresh({ body: { refreshToken: value } }, res);
    assert.equal(res.statusCode, 401);
  }
  const res = response();
  await protect({ headers: { authorization: `Bearer ${token(true)}` } }, res, () => assert.fail('Must not authorize'));
  assert.equal(res.statusCode, 401);
});

function configureSmsTest(t) {
  const values = {
    // This unit fixture uses environment credentials and has no configuration
    // database. Do not buffer a real settings lookup when emulating readyState.
    NODE_ENV: 'production', OTP_MODE: 'production', SMS_PROVIDER: 'twilio', SMS_CONFIG_SOURCE: 'environment',
    SMS_ACCOUNT_SID: 'AC-unit-account', SMS_AUTH_TOKEN: 'unit-token', SMS_SENDER_ID: '+15005550006',
    JWT_SECRET: 'isolated-auth-test-secret', JWT_REFRESH_SECRET: 'isolated-refresh-test-secret',
  };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => Object.keys(values).forEach(key => {
    if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  }));
}

test('Twilio rejects invalid credentials with a stable code and no raw account data', async (t) => {
  configureSmsTest(t);
  const request = t.mock.method(global, 'fetch', async () => ({
    ok: false, status: 401, json: async () => ({ code: 20003, message: 'Rejected private-account-identifier private-token' }),
  }));
  await assert.rejects(require('../services/providers/twilioSmsProvider').sendOtp('9876543210', '654321'), error => {
    assert.equal(error.errorCode, 'OTP_PROVIDER_AUTH_FAILED');
    assert.equal(error.providerCode, 20003);
    assert.equal(error.statusCode, 503);
    assert.equal(error.message.includes('private-'), false);
    return true;
  });
  assert.ok(request.mock.calls[0].arguments[1].signal instanceof AbortSignal);
});

test('SMS configuration and timeouts return safe, distinct delivery errors', async (t) => {
  configureSmsTest(t);
  const request = t.mock.method(global, 'fetch', async () => { throw new DOMException('private-provider-data', 'TimeoutError'); });
  const log = t.mock.method(console, 'warn', () => {});
  const service = require('../services/smsService');
  process.env.SMS_AUTH_TOKEN = '';
  assert.deepEqual(await service.sendOtp('9876543210', '654321', { requireReal: true }), { success: false, code: 'OTP_PROVIDER_NOT_CONFIGURED' });
  assert.equal(request.mock.callCount(), 0);
  process.env.SMS_AUTH_TOKEN = 'unit-token';
  assert.deepEqual(await service.sendOtp('9876543210', '654321', { requireReal: true }), { success: false, code: 'OTP_DELIVERY_UNAVAILABLE' });
  assert.equal(JSON.stringify(log.mock.calls).includes('private-provider-data'), false);
});

test('failed owner and customer delivery invalidate the OTP and permit retry after credentials are repaired', async (t) => {
  for (const phone of ['9816978086', '9876543210']) {
    await t.test(phone === '9816978086' ? 'owner' : 'customer', async (subtest) => {
      configureSmsTest(subtest);
      const mongoose = require('mongoose');
      const Otp = require('../models/Otp');
      const previousState = mongoose.connection.readyState;
      mongoose.connection.readyState = 1;
      subtest.after(() => { mongoose.connection.readyState = previousState; });
      let record;
      subtest.mock.method(Otp, 'findOne', () => ({ sort: async () => record && !record.isUsed ? record : null }));
      subtest.mock.method(Otp, 'updateMany', async () => {});
      subtest.mock.method(Otp, 'create', async value => {
        record = { ...value, createdAt: new Date(), isUsed: false, save: async () => record };
        return record;
      });
      let available = false;
      subtest.mock.method(global, 'fetch', async () => ({
        ok: available, status: available ? 201 : 401,
        json: async () => available ? { sid: 'unit-message' } : { code: 20003, message: 'private-provider-data' },
      }));
      subtest.mock.method(console, 'warn', () => {});
      const controller = require('../controllers/authController');
      const failed = response();
      const req = { body: { phone }, ip: 'isolated-delivery-recovery' };
      await controller.sendOtp(req, failed);
      assert.equal(failed.statusCode, 503);
      assert.equal(failed.body.code, 'OTP_PROVIDER_AUTH_FAILED');
      assert.equal(record.isUsed, true);
      assert.notEqual(record.trustedDelivery, true);
      assert.equal(failed.body.demoOtp, undefined);
      assert.equal(failed.body.devOtp, undefined);
      assert.equal(failed.body.token, undefined);
      assert.equal(JSON.stringify(failed.body).includes('private-provider-data'), false);
      available = true;
      const retried = response();
      await controller.resendOtp(req, retried);
      assert.equal(retried.statusCode, 200);
      assert.equal(retried.body.success, true);
      assert.equal(retried.body.otpMode, 'production');
      assert.equal(record.isUsed, false);
      assert.equal(retried.body.demoOtp, undefined);
      if (phone === '9816978086') assert.equal(record.trustedDelivery, true);
    });
  }
});
