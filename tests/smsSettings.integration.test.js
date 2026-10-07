const test = require('node:test');
const assert = require('node:assert/strict');
const { request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createAdmin, createCustomer } = require('./factories');
const SmsConfiguration = require('../models/SmsConfiguration');
const { providers } = require('../services/smsProviderRegistry');
const sms = require('../services/smsService');
const { decryptSecret } = require('../utils/secretBox');
const Otp = require('../models/Otp');
const { MASTER_OWNER_PHONE } = require('../config/masterOwner');
const Store = require('../models/Store');
const base = '/api/admin/settings/sms';
const draft = (revision = 0, provider = 'twofactor', credentials = { apiKey: 'private-client-twofactor-key' }) => ({ revision, source: 'settings', provider, credentials });
const call = (path, token, body, method = 'POST') => request(`${base}${path}`, { token, body, method });
test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(async t => {
  await resetDatabase();
  const values = { SMS_PROVIDER: 'twilio', SMS_ACCOUNT_SID: 'AC-test', SMS_AUTH_TOKEN: 'env-private-token', SMS_SENDER_ID: '+15005550006', OTP_MODE: 'production', DATA_ENCRYPTION_KEY: 'test-only-encryption-key', SMS_CONFIG_SOURCE: '', ALLOW_HOSTED_OWNER_DEMO: 'false', LOCAL_OWNER_DEMO: 'false' };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => Object.keys(values).forEach(key => { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }));
  const original = global.fetch;
  t.mock.method(global, 'fetch', (url, options) => {
    assert.equal(new URL(url).hostname, '127.0.0.1', 'No real provider request is permitted in tests');
    return original(url, options);
  });
  t.mock.method(console, 'warn', () => {});
});
function mockDelivery(t, provider = 'twofactor') {
  const messages = [];
  t.mock.method(providers[provider], 'sendOtp', async (phone, otp, credentials) => { messages.push({ phone, otp, credentials }); return { success: true, provider }; });
  return messages;
}
async function prepare(t, provider = 'twofactor', credentials) {
  const admin = await createAdmin();
  const sent = mockDelivery(t, provider);
  const saved = await call('', admin.token, credentials ? draft(0, provider, credentials) : draft(), 'PUT');
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const tested = await call('/test', admin.token, { revision: saved.data.revision });
  assert.equal(tested.status, 200, JSON.stringify(tested.data));
  return { ...admin, sent, tested };
}
async function activate(admin) {
  return call('/activate', admin.token, { revision: admin.tested.data.revision, challengeId: admin.tested.data.challenge.id, otp: admin.sent.at(-1).otp });
}

test('settings default to existing environment and cannot be read or changed by customers, guests or store-scoped admins', async () => {
  const admin = await createAdmin(); const customer = await createCustomer();
  assert.equal((await request(base)).status, 401);
  assert.equal((await request(base, { token: customer.token })).status, 403);
  assert.equal((await call('', customer.token, draft(), 'PUT')).status, 403);
  const initial = await request(base, { token: admin.token });
  assert.equal(initial.status, 200, JSON.stringify(initial.data));
  assert.equal(initial.data.active.provider, 'twilio'); assert.equal(initial.data.active.source, 'environment');
  assert.equal(initial.data.pending, null); assert.equal(initial.data.revision, 0);
  assert.doesNotMatch(JSON.stringify(initial.data), /env-private-token|AC-test|15005550006/);
  await Store.create({ name: 'Another tenant', slug: 'another-tenant', owner: customer.user._id, status: 'PUBLISHED' });
  assert.equal((await request(`${base}?store=another-tenant`, { token: admin.token })).status, 403);
  const unverified = await createAdmin({ isPhoneVerified: false });
  assert.equal((await request(base, { token: unverified.token })).status, 403);
});

test('encrypted draft never changes delivery; test and one-time activation select new credentials without mutating process env', async t => {
  const admin = await prepare(t);
  const encrypted = await SmsConfiguration.findById('deployment').select('+pending.credentialsEncrypted +challenge').lean();
  assert.ok(encrypted.pending.credentialsEncrypted.startsWith('v2:'));
  assert.doesNotMatch(encrypted.pending.credentialsEncrypted, /private-client/);
  assert.equal(JSON.parse(decryptSecret(encrypted.pending.credentialsEncrypted)).apiKey, 'private-client-twofactor-key');
  assert.notEqual(encrypted.challenge.codeHash, admin.sent[0].otp);
  assert.equal(admin.sent[0].phone, admin.user.phone);
  assert.equal(admin.tested.data.active.provider, 'twilio');
  assert.doesNotMatch(JSON.stringify(admin.tested.data), new RegExp(`private-client|credentialsEncrypted|codeHash|${admin.sent[0].otp}`));
  assert.equal((await SmsConfiguration.findById('deployment').lean()).pending.credentialsEncrypted, undefined);
  const active = await activate(admin);
  assert.equal(active.status, 200, JSON.stringify(active.data)); assert.equal(active.data.active.provider, 'twofactor');
  assert.equal(active.data.pending, null); assert.equal(active.data.challenge, null);
  assert.equal((await activate(admin)).status, 409);
  assert.equal((await sms.sendOtp('9876543201', '654321', { requireReal: true })).provider, 'twofactor');
  assert.equal(admin.sent.at(-1).credentials.apiKey, 'private-client-twofactor-key');
  assert.equal(process.env.SMS_PROVIDER, 'twilio'); assert.equal(process.env.TWOFACTOR_API_KEY, undefined);
  const publicSettings = await request('/api/settings');
  assert.doesNotMatch(JSON.stringify(publicSettings.data), /private-client|smsConfiguration|credentialsEncrypted|codeHash/);
});

test('every configured provider uses explicit credentials, never another provider environment secrets', async t => {
  const admin = await prepare(t, 'msg91', { apiKey: 'client-msg91', templateId: 'client-template' });
  assert.equal(admin.sent[0].credentials.apiKey, 'client-msg91');
  assert.equal((await activate(admin)).status, 200);
  assert.equal((await sms.sendOtp('9876543202', '654321', { requireReal: true })).provider, 'msg91');
  assert.equal(admin.sent.at(-1).credentials.templateId, 'client-template');
});

test('bad draft fields, incomplete credentials and stale revisions are rejected without overwriting active configuration', async () => {
  const admin = await createAdmin();
  for (const body of [draft(0, 'unknown'), draft(0, 'msg91', { apiKey: 'only-key' }), { ...draft(), phone: '9876543299' }, draft(0, 'twofactor', { apiKey: { leak: 'x' } }), draft(0, 'twofactor', { apiKey: 'x', endpoint: 'https://evil.invalid' }), { ...draft(), revision: '0' }]) {
    assert.equal((await call('', admin.token, body, 'PUT')).status, 400);
  }
  assert.equal((await call('', admin.token, draft(), 'PUT')).status, 200);
  assert.equal((await call('', admin.token, draft(), 'PUT')).status, 409);
  assert.equal((await request(base, { token: admin.token })).data.active.provider, 'twilio');
});

test('test delivery failures do not activate, leak provider errors or fall back to Twilio', async t => {
  const admin = await createAdmin();
  t.mock.method(providers.twofactor, 'sendOtp', async () => { throw new Error('https://2factor.in/private-key/654321'); });
  t.mock.method(providers.twilio, 'sendOtp', async () => assert.fail('No fallback SMS'));
  await call('', admin.token, draft(), 'PUT');
  const sent = await call('/test', admin.token, { revision: 1 });
  assert.equal(sent.status, 503); assert.doesNotMatch(JSON.stringify(sent.data), /private-key|654321/);
  const status = await request(base, { token: admin.token });
  assert.equal(status.data.active.provider, 'twilio'); assert.equal(status.data.challenge, null);
});

test('test uses random real SMS in demo mode and cannot be redirected or used as a login OTP', async t => {
  process.env.OTP_MODE = 'demo';
  const admin = await prepare(t);
  assert.match(admin.sent[0].otp, /^\d{6}$/);
  assert.equal(await Otp.countDocuments({ phone: admin.user.phone }), 0);
  assert.equal((await call('/test', admin.token, { revision: 1, phone: '9876543299' })).status, 400);
  assert.equal((await call('/test', admin.token, { revision: 1 })).status, 429);
  assert.equal((await activate(admin)).status, 200);
  assert.equal(process.env.OTP_MODE, 'demo');
});

test('activation is bound to administrator, verified phone, draft version, expiry and five attempts', async t => {
  const admin = await prepare(t); const other = await createAdmin();
  const payload = { revision: 1, challengeId: admin.tested.data.challenge.id, otp: admin.sent[0].otp };
  assert.equal((await call('/activate', other.token, payload)).status, 400);
  assert.equal((await request(base, { token: other.token })).data.challenge, null);
  for (let i = 0; i < 5; i += 1) assert.equal((await call('/activate', admin.token, { ...payload, otp: '000000' })).status, 400);
  assert.equal((await activate(admin)).status, 400);
  assert.equal((await request(base, { token: admin.token })).data.active.provider, 'twilio');
  await SmsConfiguration.updateOne({}, { $set: { 'challenge.attempts': 0, 'challenge.expiresAt': new Date(0) } });
  assert.equal((await activate(admin)).status, 400);
});

test('changing or discarding the draft invalidates its test without erasing active provider', async t => {
  const admin = await prepare(t);
  assert.equal((await call('', admin.token, draft(1, 'twofactor', { apiKey: 'replacement-secret' }), 'PUT')).status, 200);
  assert.equal((await activate(admin)).status, 409);
  assert.equal((await call('/discard', admin.token, { revision: 2 })).status, 200);
  const status = await request(base, { token: admin.token });
  assert.equal(status.data.pending, null); assert.equal(status.data.active.provider, 'twilio');
});

test('blank secret edits keep same-provider keys; optional fields clear explicitly; switching provider cannot reuse keys', async () => {
  const admin = await createAdmin();
  await call('', admin.token, draft(0, 'twofactor', { apiKey: 'private-key', templateName: 'brand-template' }), 'PUT');
  const result = await call('', admin.token, draft(1, 'twofactor', { apiKey: '', templateName: null }), 'PUT');
  assert.equal(result.status, 200); assert.deepEqual(result.data.pending.savedFields, ['apiKey']);
  const saved = await SmsConfiguration.findById('deployment').select('+pending.credentialsEncrypted');
  assert.deepEqual(JSON.parse(decryptSecret(saved.pending.credentialsEncrypted)), { apiKey: 'private-key', templateName: '' });
  assert.equal((await call('', admin.token, draft(2, 'msg91', { apiKey: '', templateId: 'different-template' }), 'PUT')).status, 400);
});

test('simultaneous draft writes and activations have a single winner', async t => {
  const admin = await createAdmin(); const sent = mockDelivery(t);
  const drafts = await Promise.all([call('', admin.token, draft(), 'PUT'), call('', admin.token, draft(), 'PUT')]);
  assert.deepEqual(drafts.map(row => row.status).sort(), [200, 409]);
  const tested = await call('/test', admin.token, { revision: 1 });
  const actor = { ...admin, sent, tested };
  const results = await Promise.all([activate(actor), activate(actor)]);
  assert.deepEqual(results.map(row => row.status).sort(), [200, 409]);
});

test('encrypted active configuration fails closed; emergency environment override explicitly restores backend settings', async t => {
  const admin = await prepare(t); await activate(admin);
  t.mock.method(providers.twilio, 'sendOtp', async () => ({ success: true }));
  await SmsConfiguration.updateOne({}, { $set: { 'active.credentialsEncrypted': 'corrupt-value' } });
  assert.equal((await sms.sendOtp('9876543203', '654321', { requireReal: true })).success, false);
  process.env.SMS_CONFIG_SOURCE = 'environment';
  assert.equal((await sms.sendOtp('9876543203', '654321', { requireReal: true })).provider, 'twilio');
  const status = await request(base, { token: admin.token }); assert.equal(status.data.environmentOverride, true);
  assert.equal(status.data.active.source, 'environment');
});

test('Settings provider serves actual customer and owner login; outstanding login codes survive provider change', async t => {
  const oldMessages = mockDelivery(t, 'twilio');
  const phone = '9876543239';
  assert.equal((await request('/api/auth/send-otp', { method: 'POST', body: { phone } })).status, 200);
  const oldCode = oldMessages.at(-1).otp;
  const admin = await prepare(t); await activate(admin);
  assert.equal((await request('/api/auth/verify-otp', { method: 'POST', body: { phone, otp: oldCode } })).status, 200);
  for (const target of ['9876543240', MASTER_OWNER_PHONE]) {
    const result = await request('/api/auth/send-otp', { method: 'POST', body: { phone: target } });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    const record = await Otp.findOne({ phone: target, isUsed: false }); assert.equal(record.provider, 'twofactor');
    if (target === MASTER_OWNER_PHONE) assert.equal(record.trustedDelivery, true);
    assert.equal((await request('/api/auth/verify-otp', { method: 'POST', body: { phone: target, otp: admin.sent.at(-1).otp } })).status, 200);
  }
});

test('switching back to environment is tested and rejects environment changes after sending', async t => {
  const admin = await prepare(t); await activate(admin);
  const twilio = mockDelivery(t, 'twilio');
  const saved = await call('', admin.token, { revision: 2, source: 'environment' }, 'PUT'); assert.equal(saved.status, 200);
  await SmsConfiguration.updateOne({}, { $unset: { lastTestAt: 1 } });
  const tested = await call('/test', admin.token, { revision: 3 }); assert.equal(tested.status, 200);
  process.env.SMS_AUTH_TOKEN = 'changed-after-test';
  const payload = { revision: 3, challengeId: tested.data.challenge.id, otp: twilio.at(-1).otp };
  assert.equal((await call('/activate', admin.token, payload)).status, 400);
  process.env.SMS_AUTH_TOKEN = 'env-private-token';
  assert.equal((await call('/activate', admin.token, payload)).status, 200);
  assert.equal((await sms.sendOtp('9876543241', '654321', { requireReal: true })).provider, 'twilio');
});
