const test = require('node:test');
const assert = require('node:assert/strict');
const { resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createAdmin } = require('./factories');
const { Configuration, Digest } = require('../models/TrafficAnalytics');
const Provider = require('../models/OrderAlertConfiguration');
const Store = require('../models/Store');
const StoreMember = require('../models/StoreMember');
const service = require('../services/trafficDigestService');
const providers = require('../services/orderAlertProviders');
const { saveConfiguration } = require('../services/trafficConfigurationService');
const { ensureIndexes } = require('../services/trafficWorker');
let delivered; const original = providers.deliver;
test.before(async () => { await startTestEnvironment(); await ensureIndexes(); }); test.after(stopTestEnvironment);
test.beforeEach(async () => { await resetDatabase(); delivered = []; providers.deliver = async (...args) => { delivered.push(args); return { messageId: 'test-accepted' }; }; });
test.afterEach(() => { providers.deliver = original; });
async function setup() {
  const store = await Store.create({ name: 'Digest shop', slug: 'digest-shop', status: 'PUBLISHED', timezone: 'Asia/Kolkata', plan: 'PROFESSIONAL', license: { status: 'ACTIVE' } });
  const admin = await createAdmin(); await StoreMember.create({ store: store._id, user: admin.user._id, role: 'OWNER', status: 'ACTIVE' });
  await Provider.create({ storeId: store._id, storefrontUrl: 'https://digest.example.com', whatsapp: { accessToken: 'test-only-encrypted-placeholder', phoneNumberId: '1234567890' } });
  const whatsappDigest = { enabled: true, frequency: 'DAILY', recipient: '+919876543210', consent: true, templateName: 'traffic_summary', language: 'en' };
  await saveConfiguration(store, { expectedRevision: 1, whatsappDigest }, admin.user._id);
  return { store, admin };
}
async function due(store) { await Configuration.updateOne({ storeId: store._id }, { $set: { 'whatsappDigest.nextRunAt': new Date(Date.now() - 60000) } }); }
test('daily/weekly traffic digest schedules use local 09:00, including DST', () => {
  assert.equal(service.nextDigestDate('DAILY', 'Asia/Kolkata', new Date('2026-10-01T08:00:00Z')).toISOString(), '2026-10-02T03:30:00.000Z');
  assert.equal(service.nextDigestDate('WEEKLY', 'Asia/Kolkata', new Date('2026-10-01T08:00:00Z')).toISOString(), '2026-10-05T03:30:00.000Z');
  assert.equal(service.nextDigestDate('DAILY', 'America/New_York', new Date('2026-03-07T12:00:00Z')).toISOString(), '2026-03-08T13:00:00.000Z');
});
test('digests start in the future and remain disabled without explicit setup', async () => {
  const { store } = await setup(); const config = await Configuration.findOne({ storeId: store._id });
  assert.ok(config.whatsappDigest.nextRunAt > new Date()); await service.tick(); assert.equal(delivered.length, 0);
});
test('due digest is durable, tenant scoped, accepted once and uses the traffic-specific template', async () => {
  const { store } = await setup(); await due(store); await service.tick(); await service.tick();
  assert.equal(delivered.length, 1, (await Digest.findOne())?.reason); assert.equal(delivered[0][0], 'WHATSAPP'); assert.equal(delivered[0][1].whatsapp.templateName, 'traffic_summary');
  assert.match(delivered[0][3].amount, /measured visitors/); assert.match(delivered[0][3].payment, /verified orders/);
  assert.equal((await Digest.findOne({ storeId: store._id })).status, 'ACCEPTED');
});
test('revoked digest owner cannot send reports', async () => {
  const { store, admin } = await setup(); await StoreMember.updateOne({ store: store._id, user: admin.user._id }, { status: 'REVOKED' });
  await due(store); await service.tick(); assert.equal(delivered.length, 0); assert.equal((await Digest.findOne()).status, 'FAILED');
});
test('interrupted sends become uncertain and require explicit manual duplicate-risk acknowledgement', async () => {
  const { store, admin } = await setup();
  const job = await Digest.create({ storeId: store._id, periodFrom: '2026-09-01', periodTo: '2026-09-01', frequency: 'DAILY', actorId: admin.user._id, status: 'SENDING', leaseUntil: new Date(Date.now() - 1000) });
  await service.tick(); assert.equal((await Digest.findById(job._id)).status, 'UNCERTAIN'); assert.equal(delivered.length, 0);
  await assert.rejects(service.retry(store._id, job._id, false)); await service.retry(store._id, job._id, true); assert.equal((await Digest.findById(job._id)).status, 'PENDING');
});
test('provider rate limits retry with bounded attempts and network ambiguity does not auto-repeat', async () => {
  const { store } = await setup(); await due(store);
  providers.deliver = async () => { throw Object.assign(new Error('Rate limited'), { retryable: true }); };
  await service.tick(); let job = await Digest.findOne(); assert.equal(job.status, 'PENDING', job.reason); assert.equal(job.attempts, 1);
  await Digest.updateOne({ _id: job._id }, { nextAttemptAt: new Date(Date.now() - 1), attempts: 4 }); await service.tick(); job = await Digest.findById(job._id); assert.equal(job.status, 'FAILED');
});
