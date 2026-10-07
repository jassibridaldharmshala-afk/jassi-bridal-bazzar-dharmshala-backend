const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../services/smsService');
const adapters = {
  twilio: require('../services/providers/twilioSmsProvider'),
  msg91: require('../services/providers/msg91Provider'),
  twofactor: require('../services/providers/twoFactorProvider'),
  fast2sms: require('../services/providers/fast2smsProvider'),
};
const env = {
  NODE_ENV: 'production', OTP_MODE: 'production', SMS_PROVIDER: 'twilio',
  SMS_ACCOUNT_SID: 'AC-test', SMS_AUTH_TOKEN: 'private-twilio', SMS_SENDER_ID: '+15005550006',
  MSG91_AUTH_KEY: 'private-msg91', MSG91_TEMPLATE_ID: 'msg91-template',
  TWOFACTOR_API_KEY: 'private-twofactor', TWOFACTOR_TEMPLATE_NAME: 'Brand OTP & login',
  FAST2SMS_API_KEY: 'private-fast2sms',
};
const accepted = {
  twilio: { sid: 'SM-test', status: 'queued' }, msg91: { type: 'success', message: 'request-id' },
  twofactor: { Status: 'Success', Details: 'session-id' }, fast2sms: { return: true, request_id: 'request-id' },
};
const jsonResponse = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });

test.beforeEach(t => {
  const keys = new Set([...Object.keys(env), 'SMS_API_KEY', 'SMS_TEMPLATE_ID', 'FAST2SMS_SENDER_ID', 'ALLOW_HOSTED_OWNER_DEMO', 'LOCAL_OWNER_DEMO']);
  const previous = Object.fromEntries([...keys].map(key => [key, process.env[key]]));
  keys.forEach(key => delete process.env[key]);
  Object.assign(process.env, env);
  t.after(() => keys.forEach(key => { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }));
  t.mock.method(global, 'fetch', async () => assert.fail('Unexpected outbound request'));
  t.mock.method(console, 'warn', () => {});
});

test('production rejects unknown, unset and mock providers without sending or leaking OTPs', async () => {
  for (const provider of ['mock', '', 'twillo', 'constructor', '__proto__']) {
    process.env.SMS_PROVIDER = provider;
    for (const requireReal of [false, true]) {
      assert.deepEqual(await service.sendOtp('9876543210', '654321', { requireReal }), { success: false, code: 'OTP_PROVIDER_NOT_CONFIGURED' });
    }
  }
});

test('demo stays local while explicit production mode enables local provider testing', async (t) => {
  process.env.NODE_ENV = 'development'; process.env.OTP_MODE = 'demo';
  t.mock.method(adapters.twilio, 'sendOtp', async () => ({ success: true }));
  t.mock.method(require('../services/providers/mockSmsProvider'), 'sendOtp', async () => ({ success: true, provider: 'mock' }));
  assert.equal((await service.sendOtp('9876543210', '654321')).provider, 'mock');
  assert.equal((await service.sendOtp('9876543210', '654321', { requireReal: true })).provider, 'twilio');
  process.env.OTP_MODE = 'production';
  assert.equal((await service.sendOtp('9876543210', '654321')).provider, 'twilio');
  process.env.SMS_PROVIDER = 'typo';
  process.env.OTP_MODE = 'demo';
  assert.equal((await service.sendOtp('9876543210', '654321')).success, false);
});

test('2Factor aliases and whitespace resolve to one provider for delivery and owner trust', async (t) => {
  const send = t.mock.method(adapters.twofactor, 'sendOtp', async () => ({ success: true }));
  for (const provider of ['twofactor', '2factor', '2factor.in', ' 2FACTOR ']) {
    process.env.SMS_PROVIDER = provider;
    assert.equal(service.getProvider(), 'twofactor');
    assert.equal(service.isRealSmsProvider(provider), true);
    assert.equal((await service.sendOtp('9876543210', '654321', { requireReal: true })).provider, 'twofactor');
  }
  assert.equal(send.mock.callCount(), 4);
});

test('MSG91 and Fast2SMS keep legacy credentials while dedicated values take precedence', () => {
  process.env.SMS_API_KEY = 'legacy-key'; process.env.SMS_TEMPLATE_ID = 'legacy-template';
  assert.equal(adapters.msg91.getConfiguration().apiKey, 'private-msg91');
  assert.equal(adapters.fast2sms.getConfiguration().apiKey, 'private-fast2sms');
  delete process.env.MSG91_AUTH_KEY; delete process.env.MSG91_TEMPLATE_ID; delete process.env.FAST2SMS_API_KEY;
  assert.equal(adapters.msg91.getConfiguration().apiKey, 'legacy-key');
  assert.equal(adapters.msg91.getConfiguration().templateId, 'legacy-template');
  assert.equal(adapters.fast2sms.getConfiguration().apiKey, 'legacy-key');
});

test('configuration diagnostics contain missing variable names but no secret values', async () => {
  process.env.SMS_PROVIDER = 'msg91';
  assert.deepEqual(service.getSmsProviderStatus(), { provider: 'msg91', supported: true, configured: true, missing: [] });
  delete process.env.MSG91_TEMPLATE_ID;
  assert.deepEqual(service.getSmsProviderStatus().missing, ['MSG91_TEMPLATE_ID']);
  assert.equal(service.getSmsProviderStatus().configured, false);
  assert.equal((await service.sendOtp('9876543210', '654321')).code, 'OTP_PROVIDER_NOT_CONFIGURED');
  assert.doesNotMatch(JSON.stringify(service.getSmsProviderStatus()), /private-|msg91-template/);
});

for (const provider of Object.keys(adapters)) {
  test(`${provider}: explicit Settings credentials do not inherit absent environment values`, async t => {
    const configuration = adapters[provider].getConfiguration({});
    assert.ok(configuration.missing.length > 0);
    await assert.rejects(adapters[provider].sendOtp('9876543210', '654321', {}), error => error.errorCode === 'OTP_PROVIDER_NOT_CONFIGURED');
    const credentials = {
      twilio: { accountSid: 'AC-client', authToken: 'client-token', from: '+15005550007' },
      msg91: { apiKey: 'client-key', templateId: 'client-template' },
      twofactor: { apiKey: 'client-key', templateName: 'client-template' },
      fast2sms: { apiKey: 'client-key', senderId: 'CLIENT' },
    }[provider];
    const outbound = [];
    t.mock.method(global, 'fetch', async (url, options) => { outbound.push({ url, headers: options.headers, body: String(options.body) }); return jsonResponse(accepted[provider]); });
    assert.equal((await adapters[provider].sendOtp('9876543210', '654321', credentials)).success, true);
    assert.equal(outbound.length, 1);
    assert.doesNotMatch(JSON.stringify(outbound), /private-twilio|private-msg91|private-twofactor|private-fast2sms|Brand OTP/);
  });

  test(`${provider}: accepts only a valid response and normalizes the phone/code sent`, async (t) => {
    process.env.SMS_PROVIDER = provider;
    const calls = [];
    t.mock.method(global, 'fetch', async (url, options) => { calls.push({ url, options }); return jsonResponse(accepted[provider]); });
    for (const phone of ['9123456789', '+919123456789', '919123456789']) {
      assert.deepEqual(await service.sendOtp(phone, '654321'), { success: true, provider });
    }
    assert.equal(calls.length, 3);
    for (const { url, options } of calls) {
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.redirect, 'error');
      if (provider === 'twofactor') {
        assert.equal(options.method, 'GET');
        const parts = new URL(url).pathname.split('/').map(decodeURIComponent);
        assert.deepEqual(parts.slice(-4), ['SMS', '+919123456789', '654321', 'Brand OTP & login']);
        assert.doesNotMatch(url, /AUTOGEN|VERIFY/);
      } else if (provider === 'twilio') {
        assert.equal(options.body.get('To'), '+919123456789');
        assert.match(options.body.get('Body'), /654321/);
      } else {
        const body = JSON.parse(options.body);
        if (provider === 'msg91') assert.deepEqual(body, { template_id: 'msg91-template', mobile: '919123456789', otp: '654321' });
        else { assert.equal(body.numbers, '9123456789'); assert.equal(body.variables_values, '654321'); }
      }
    }
  });

  test(`${provider}: HTTP 200 errors, invalid JSON and timeouts fail closed without retries`, async (t) => {
    process.env.SMS_PROVIDER = provider;
    const bodies = [null, {}, { type: 'error', Status: 'Error', return: false, message: 'private-raw-error' }];
    let attempts = 0;
    t.mock.method(global, 'fetch', async () => { attempts++; return jsonResponse(bodies.shift()); });
    for (let i = 0; i < 3; i++) assert.deepEqual(await service.sendOtp('9876543210', '654321'), { success: false, code: 'OTP_DELIVERY_UNAVAILABLE' });
    assert.equal(attempts, 3);
    t.mock.method(global, 'fetch', async () => ({ ...jsonResponse({}), json: async () => { throw new Error('private-json-body'); } }));
    assert.equal((await service.sendOtp('9876543210', '654321')).success, false);
    t.mock.method(global, 'fetch', async () => { throw new DOMException('private-url/key/654321', 'TimeoutError'); });
    assert.equal((await service.sendOtp('9876543210', '654321')).code, 'OTP_DELIVERY_UNAVAILABLE');
    assert.doesNotMatch(JSON.stringify(console.warn.mock.calls), /private|9876543210|654321/);
  });

  test(`${provider}: credential failures map to a safe authentication error`, async (t) => {
    process.env.SMS_PROVIDER = provider;
    t.mock.method(global, 'fetch', async () => jsonResponse({ message: 'private-key', Details: 'Invalid API Key' }, provider === 'twofactor' ? 400 : 401));
    assert.deepEqual(await service.sendOtp('9876543210', '654321'), { success: false, code: 'OTP_PROVIDER_AUTH_FAILED' });
  });

  test(`${provider}: missing configuration and malformed OTP never contact the gateway`, async () => {
    process.env.SMS_PROVIDER = provider;
    assert.equal((await service.sendOtp('9876543210', 'AUTOGEN')).success, false);
    const field = { twilio: 'SMS_AUTH_TOKEN', msg91: 'MSG91_AUTH_KEY', twofactor: 'TWOFACTOR_API_KEY', fast2sms: 'FAST2SMS_API_KEY' }[provider];
    delete process.env[field];
    assert.equal((await service.sendOtp('9876543210', '654321')).code, 'OTP_PROVIDER_NOT_CONFIGURED');
  });
}

test('2Factor optional template and international country codes are preserved', async (t) => {
  delete process.env.TWOFACTOR_TEMPLATE_NAME;
  const send = t.mock.method(global, 'fetch', async () => jsonResponse(accepted.twofactor));
  await adapters.twofactor.sendOtp('+447700900123', '654321');
  const url = new URL(send.mock.calls[0].arguments[0]);
  assert.equal(decodeURIComponent(url.pathname), '/API/V1/private-twofactor/SMS/+447700900123/654321');
});

test('MSG91 keeps international country codes and Fast2SMS rejects unsupported destinations', async (t) => {
  const send = t.mock.method(global, 'fetch', async () => jsonResponse(accepted.msg91));
  await adapters.msg91.sendOtp('+447700900123', '654321');
  assert.equal(JSON.parse(send.mock.calls[0].arguments[1].body).mobile, '447700900123');
  await assert.rejects(() => adapters.fast2sms.sendOtp('+447700900123', '654321'));
  assert.equal(send.mock.callCount(), 1);
});
