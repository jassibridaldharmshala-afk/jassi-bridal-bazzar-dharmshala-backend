const test = require('node:test');
const assert = require('node:assert/strict');
const { request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createAdmin, createCustomer } = require('./factories');
const Configuration = require('../models/OrderAlertConfiguration');
const Delivery = require('../models/OrderAlertDelivery');
const Order = require('../models/Order');
const Store = require('../models/Store');
const StoreMember = require('../models/StoreMember');
const service = require('../services/orderAlertService');
const providers = require('../services/orderAlertProviders');
const { decryptSecret } = require('../utils/secretBox');
const base = '/api/admin/settings/order-alerts';
const draft = (revision = 0) => ({ revision, storefrontUrl: 'https://store.example',
  email: { enabled: true, recipient: 'owner@example.com', senderEmail: 'orders@example.com', senderName: 'Store', apiKey: 'private-email-key' },
  whatsapp: { enabled: true, recipient: '+919876543210', phoneNumberId: '123456789', templateName: 'store_order', language: 'en', consent: true, accessToken: 'private-wa-key' } });
test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(async t => {
  await resetDatabase();
  const fetch = global.fetch;
  t.mock.method(global, 'fetch', (url, options) => {
    assert.equal(new URL(url).hostname, '127.0.0.1', 'No real provider traffic allowed');
    return fetch(url, options);
  });
});
async function setup() {
  const admin = await createAdmin();
  const response = await request(base, { method: 'PUT', token: admin.token, body: draft() });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  const config = await Configuration.findOne().lean();
  return { ...admin, config, data: response.data };
}
async function order(config, overrides = {}) {
  return Order.create({ user: (await createCustomer()).user._id, storeId: config.storeId,
    orderItems: [], paymentMethod: 'COD', finalAmount: 1499, ...overrides });
}
test('only verified owner/admin can configure; public settings never expose credentials', async () => {
  const guest = await request(base); assert.equal(guest.status, 401);
  const customer = await createCustomer();
  assert.equal((await request(base, { token: customer.token })).status, 403);
  const unverified = await createAdmin({ isPhoneVerified: false });
  assert.equal((await request(base, { token: unverified.token })).status, 403);
  const admin = await createAdmin();
  const initial = await request(base, { token: admin.token });
  assert.equal(initial.status, 200); assert.equal(initial.data.email.enabled, false);
  const { data, config } = await setup();
  assert.doesNotMatch(JSON.stringify(data), /private-email-key|private-wa-key|v2:/);
  const stored = await Configuration.findById(config._id).select('+email.apiKey +whatsapp.accessToken');
  assert.match(stored.email.apiKey, /^v2:/); assert.equal(decryptSecret(stored.whatsapp.accessToken), 'private-wa-key');
  assert.equal((await Configuration.findById(config._id).lean()).email.apiKey, undefined);
  assert.doesNotMatch(JSON.stringify((await request('/api/settings')).data), /private-email-key|private-wa-key|accessToken|hasApiKey/);
});
test('stale revisions and malformed settings rejected; blank credentials retain encrypted keys', async () => {
  const { token, config } = await setup();
  assert.equal((await request(base, { token, method: 'PUT', body: draft() })).status, 409);
  for (const body of [ { ...draft(1), storefrontUrl: 'javascript:bad' }, { ...draft(1), email: { ...draft().email, apiKey: {} } }, { ...draft(1), whatsapp: { ...draft().whatsapp, consent: false } }, { ...draft(1), email: { ...draft().email, senderName: 'bad\nheader' } } ]) {
    assert.equal((await request(base, { token, method: 'PUT', body })).status, 400);
  }
  const body = draft(1); body.email.apiKey = ''; body.whatsapp.accessToken = '';
  assert.equal((await request(base, { token, method: 'PUT', body })).status, 200);
  assert.equal(decryptSecret((await Configuration.findById(config._id).select('+email.apiKey')).email.apiKey), 'private-email-key');
});
test('COD enqueues once per channel; online waits for payment; crash recovery catches missed callbacks', async () => {
  const { config } = await setup();
  const cod = await order(config), online = await order(config, { paymentMethod: 'Razorpay' });
  await Promise.all(Array.from({ length: 5 }, () => service.queueOrder(cod._id)));
  assert.equal(await Delivery.countDocuments({ orderId: cod._id }), 2);
  await service.queueOrder(online._id); assert.equal(await Delivery.countDocuments({ orderId: online._id }), 0);
  await Order.updateOne({ _id: online._id }, { $set: { paymentStatus: 'Paid' } });
  await service.recover(); assert.equal(await Delivery.countDocuments({ orderId: online._id }), 2);
  await service.recover(); assert.equal(await Delivery.countDocuments(), 4);
  const old = await order(config, { createdAt: new Date(0) }); await service.queueOrder(old._id);
  assert.equal(await Delivery.countDocuments({ orderId: old._id }), 0);
});
test('atomic worker claims prevent parallel sends and produce secure minimal messages', async t => {
  const sent = []; t.mock.method(providers, 'deliver', async (...args) => { sent.push(args); return { messageId: 'provider-id' }; });
  const { config } = await setup(); const placed = await order(config);
  await service.queueOrder(placed._id);
  await Promise.all([service.processOne(), service.processOne(), service.processOne()]);
  assert.equal(sent.length, 2); assert.equal(await Delivery.countDocuments({ status: 'ACCEPTED' }), 2);
  assert.match(sent[0][3].link, /https:\/\/store.example\/admin\/orders\/detail\?id=/);
  assert.equal(sent[0][3].amount, 'INR 1499.00');
  assert.doesNotMatch(JSON.stringify(sent[0][3]), /customer.*@|houseNo|pincode|fullName/);
  assert.doesNotMatch(JSON.stringify(await service.read(config.storeId)), /provider-id|private-email|leaseToken/);
});

for (const channel of ['EMAIL', 'WHATSAPP']) {
  test(`${channel} can run independently without sending through the other provider`, async t => {
    const { config } = await setup();
    const body = draft(1);
    body.email.enabled = channel === 'EMAIL'; body.whatsapp.enabled = channel === 'WHATSAPP';
    await service.save(config.storeId, body);
    const placed = await order(config); await service.queueOrder(placed._id);
    const sent = [];
    t.mock.method(providers, 'deliver', async selected => { sent.push(selected); return { messageId: 'single-channel' }; });
    await service.tick();
    assert.deepEqual(sent, [channel]);
    assert.equal(await Delivery.countDocuments({ orderId: placed._id, status: 'ACCEPTED' }), 1);
  });
}

test('a failed email does not block WhatsApp or roll back a committed order', async t => {
  const { config } = await setup(); const placed = await order(config);
  await service.queueOrder(placed._id);
  t.mock.method(providers, 'deliver', async channel => {
    if (channel === 'EMAIL') throw new Error('Email provider unavailable');
    return { messageId: 'whatsapp-accepted' };
  });
  await service.tick();
  assert.equal((await Delivery.findOne({ channel: 'EMAIL' })).status, 'FAILED');
  assert.equal((await Delivery.findOne({ channel: 'WHATSAPP' })).status, 'ACCEPTED');
  assert.equal((await Order.findById(placed._id)).orderStatus, 'Pending');
});
test('rate limits retry but uncertain sends require explicit manual confirmation', async t => {
  const { config } = await setup(); const placed = await order(config); await service.queueOrder(placed._id);
  t.mock.method(providers, 'deliver', async () => { throw Object.assign(new Error('Rate limited'), { retryable: true }); });
  await service.processOne(); let job = await Delivery.findOne({ status: 'RETRY' });
  assert.ok(job.nextAttemptAt > new Date());
  t.mock.method(providers, 'deliver', async () => { throw Object.assign(new Error('Check provider'), { uncertain: true }); });
  await service.processOne(); job = await Delivery.findOne({ status: 'UNCERTAIN' }); assert.ok(job);
  assert.equal(await service.processOne(job._id), false);
  await assert.rejects(service.retry(config.storeId, job._id, false), /confirm/);
  await service.retry(config.storeId, job._id, true);
  assert.equal((await Delivery.findById(job._id)).status, 'QUEUED');
});
test('cancelled orders, disabled channels and changed recipients are not sent', async t => {
  t.mock.method(providers, 'deliver', () => assert.fail('Must not send'));
  const { config } = await setup(); const placed = await order(config); await service.queueOrder(placed._id);
  await Order.updateOne({ _id: placed._id }, { orderStatus: 'Cancelled' });
  await service.tick(); assert.equal(await Delivery.countDocuments({ status: 'SKIPPED' }), 2);
  const next = await order(config); await service.queueOrder(next._id);
  await Configuration.updateOne({ _id: config._id }, { 'email.enabled': false, 'whatsapp.recipient': '+919999999999' });
  await service.tick(); assert.equal(await Delivery.countDocuments({ status: 'SKIPPED' }), 4);
});
test('tests are saved-channel only, rate-limited and do not create orders', async t => {
  const { token } = await setup(); t.mock.method(providers, 'deliver', async () => ({ messageId: 'test-id' }));
  const sent = await request(`${base}/test`, { token, method: 'POST', body: { channel: 'EMAIL' } });
  assert.equal(sent.status, 200); assert.equal(sent.data.deliveries[0].status, 'ACCEPTED');
  assert.equal(await Order.countDocuments(), 0);
  assert.equal((await request(`${base}/test`, { token, method: 'POST', body: { channel: 'EMAIL' } })).status, 400);
});
test('store owner configuration and worker delivery cannot cross tenant boundaries', async t => {
  const { token, config } = await setup(); const other = await createCustomer({ activeMode: 'seller', availableModes: ['customer', 'seller'] });
  const tenant = await Store.create({ name: 'Other store', slug: 'other-alert-store', owner: other.user._id, status: 'PUBLISHED' });
  await StoreMember.create({ store: tenant._id, user: other.user._id, role: 'OWNER', status: 'ACTIVE' });
  assert.equal((await request(`${base}?store=other-alert-store`, { token })).status, 403);
  const own = await request('/api/seller/settings/order-alerts', { token: other.token, headers: { 'x-store-id': String(tenant._id) } });
  assert.equal(own.status, 200, JSON.stringify(own.data)); assert.equal(own.data.revision, 0);
  const foreign = await order(config, { storeId: tenant._id });
  await Delivery.create({ storeId: config.storeId, orderId: foreign._id, channel: 'EMAIL', recipient: 'owner@example.com', dedupeKey: 'mismatched-job' });
  t.mock.method(providers, 'deliver', () => assert.fail('Cross-tenant job must not send'));
  await service.processOne(); assert.equal((await Delivery.findOne()).status, 'SKIPPED');
});
test('expired sending leases become uncertain and are never automatically duplicated', async t => {
  const { config } = await setup(); const placed = await order(config); await service.queueOrder(placed._id);
  await Delivery.updateMany({}, { status: 'SENDING', leaseUntil: new Date(0), leaseToken: 'abandoned' });
  t.mock.method(providers, 'deliver', () => assert.fail('Ambiguous sends need review'));
  await service.tick(); assert.equal(await Delivery.countDocuments({ status: 'UNCERTAIN' }), 2);
});
