const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createAdmin, createCustomer, createProduct, validAddress } = require('./factories');
const Store = require('../models/Store');
const StoreMember = require('../models/StoreMember');
const Order = require('../models/Order');
const { Configuration, Visitor, Event, Session, Slice } = require('../models/TrafficAnalytics');
const { tick, ensureIndexes } = require('../services/trafficWorker');
const { trafficReport } = require('../services/trafficReportingService');
const { DAY, dateKey, shiftDate, midnight } = require('../services/trafficAlgorithms');
const { buildReportCsv } = require('../services/reportExportService');
test.before(async () => { await startTestEnvironment(); await ensureIndexes(); });
test.after(stopTestEnvironment); test.beforeEach(resetDatabase);
const id = () => crypto.randomUUID();
async function store(slug = 'traffic-test') { return Store.create({ name: 'Traffic boutique', slug, status: 'PUBLISHED', timezone: 'Asia/Kolkata' }); }
const row = (visitorId, sessionId, name = 'PAGE_VIEW', extra = {}) => ({ eventId: id(), visitorId, sessionId, name, occurredAt: new Date(Date.now() - 100).toISOString(), path: '/', source: 'instagram', medium: 'social', device: 'mobile', browser: 'Safari', os: 'iOS', ...extra });
const collect = (shop, events, overrides = {}) => request(`/api/analytics/collect?store=${shop.slug}`, { method: 'POST', body: { events, deletionToken: 'deletion_token_123456789012345', consent: true, privacyGeneration: 1, ...overrides } });
const report = (shop, query = { range: '7d' }) => trafficReport({ store: shop, tenantFilter: { storeId: shop._id }, query, timezone: shop.timezone });
test('one visitor, three visits and ten page views survive duplicate delivery and worker replay', async () => {
  const shop = await store(); const visitorId = id(); const sessions = [id(), id(), id()];
  const events = Array.from({ length: 10 }, (_, i) => row(visitorId, sessions[i % 3]));
  const first = await collect(shop, events); assert.equal(first.status, 202, JSON.stringify(first.data)); assert.equal(first.data.accepted, 10);
  assert.equal((await collect(shop, events)).data.accepted, 0);
  await tick(); await tick(); const stats = await report(shop);
  assert.equal(stats.metrics.visitors.value, 1); assert.equal(stats.metrics.sessions.value, 3); assert.equal(stats.metrics.pageViews.value, 10);
  assert.equal(await Event.countDocuments(), 10); assert.equal(await Session.countDocuments(), 3); assert.equal(stats.metrics.newVisitors.value, 1);
});
test('consent, disabled collection, known bots, invalid identity and forged purchases are guarded', async () => {
  const shop = await store(); const events = [row(id(), id())];
  assert.equal((await collect(shop, events, { consent: false })).data.reason, 'consent_required');
  assert.equal((await collect(shop, [row(id(), id(), 'PURCHASE')])).status, 400);
  assert.equal((await collect(shop, [row('short', id())])).status, 400);
  const bot = await request(`/api/analytics/collect?store=${shop.slug}`, { method: 'POST', headers: { 'User-Agent': 'Googlebot' }, body: { events, consent: true } }); assert.equal(bot.data.reason, 'excluded');
  await Configuration.create({ storeId: shop._id, enabled: false });
  assert.equal((await collect(shop, events)).data.reason, 'disabled'); assert.equal(await Event.countDocuments(), 0);
  const legacy = await request(`/api/analytics/events?store=${shop.slug}`, { method: 'POST', body: { name: 'PURCHASE' } }); assert.equal(legacy.data.reason, 'server_only_event');
});
test('withdrawal requires its privacy token, survives worker restart and leaves other stores intact', async () => {
  const a = await store('traffic-a'); const b = await store('traffic-b'); const visitorId = id();
  await collect(a, [row(visitorId, id())]); await collect(b, [row(id(), id())]); await tick();
  assert.equal((await request(`/api/analytics/forget?store=${a.slug}`, { method: 'POST', body: { visitorId, deletionToken: id() } })).status, 403);
  assert.equal((await request(`/api/analytics/forget?store=${a.slug}`, { method: 'POST', body: { visitorId, deletionToken: 'deletion_token_123456789012345' } })).status, 202);
  assert.equal((await collect(a, [row(visitorId, id())])).data.reason, 'withdrawn');
  await tick(); assert.equal(await Event.countDocuments({ storeId: a._id }), 0); assert.equal(await Slice.countDocuments({ storeId: a._id }), 0);
  assert.equal((await report(b)).metrics.visitors.value, 1);
});
test('range uniques deduplicate across days and IST midnight excludes the prior day', async () => {
  const shop = await store(); const visitorId = id(); const receivedAt = new Date();
  const day = shiftDate(dateKey(receivedAt, shop.timezone), -1); const boundary = midnight(day, shop.timezone);
  const times = [new Date(+boundary - 3600000), new Date(+boundary - 60000), new Date(+boundary + 60000)];
  await Visitor.create({ storeId: shop._id, visitorId, deletionHash: 'fixture', firstSeenAt: times[0], expiresAt: new Date(+receivedAt + DAY) });
  for (const at of times) await Event.create({ ...row(visitorId, id()), storeId: shop._id, privacyGeneration: 1, occurredAt: at, receivedAt, expiresAt: new Date(+receivedAt + DAY) });
  await tick();
  assert.equal((await report(shop, { from: day, to: day })).metrics.pageViews.value, 1);
  const range = await report(shop, { from: shiftDate(day, -1), to: day });
  assert.equal(range.metrics.visitors.value, 1); assert.equal(range.metrics.sessions.value, 3); assert.equal(range.metrics.pageViews.value, 3);
});
test('compact facts remain after raw events expire', async () => {
  const shop = await store(); await collect(shop, [row(id(), id())]); await tick();
  await Event.deleteMany({ storeId: shop._id });
  await Slice.updateMany({ storeId: shop._id }, { $set: { hour: new Date(Math.floor((Date.now() - 3600000) / 900000) * 900000) } });
  const stats = await report(shop); assert.equal(stats.metrics.visitors.value, 1); assert.equal(stats.metrics.pageViews.value, 1);
});
test('settings enforce store access, optimistic revision and retention confirmation', async () => {
  const shop = await store(); const admin = await createAdmin(); const path = `/api/admin/settings/traffic?store=${shop.slug}`;
  assert.equal((await request(path, { token: admin.token })).status, 403);
  await StoreMember.create({ store: shop._id, user: admin.user._id, role: 'OWNER', status: 'ACTIVE' });
  const current = await request(path, { token: admin.token }); assert.equal(current.status, 200);
  const saved = await request(path, { method: 'PUT', token: admin.token, body: { expectedRevision: current.data.revision, enabled: false } }); assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal((await request(path, { method: 'PUT', token: admin.token, body: { expectedRevision: current.data.revision, enabled: true } })).status, 409);
  assert.equal((await request(path, { method: 'PUT', token: admin.token, body: { expectedRevision: saved.data.revision, rawRetentionDays: 7 } })).status, 400);
});
test('history deletion is confirmed, tenant scoped and fences stale browser batches', async () => {
  const a = await store('clear-a'); const b = await store('clear-b'); const admin = await createAdmin();
  await StoreMember.create({ store: a._id, user: admin.user._id, role: 'OWNER' });
  const events = [row(id(), id())]; await collect(a, events); await collect(b, [row(id(), id())]); await tick();
  const path = `/api/admin/settings/traffic/clear?store=${a.slug}`;
  assert.equal((await request(path, { method: 'POST', token: admin.token, body: {} })).status, 400);
  const removed = await request(path, { method: 'POST', token: admin.token, body: { confirmation: 'DELETE ANALYTICS' } }); assert.equal(removed.status, 200, JSON.stringify(removed.data));
  assert.equal((await collect(a, events)).data.reason, 'settings_changed');
  assert.equal(await Event.countDocuments({ storeId: a._id }), 0); assert.equal(await Event.countDocuments({ storeId: b._id }), 1);
});
test('ordered funnel verifies backend orders and does not treat COD placed as online paid', async () => {
  const shop = await store(); const visitorId = id(); const sessionId = id(); const base = Date.now() - 60000;
  await collect(shop, ['PAGE_VIEW', 'PRODUCT_VIEW', 'ADD_TO_CART', 'BEGIN_CHECKOUT'].map((name, i) => row(visitorId, sessionId, name, { occurredAt: new Date(base + i * 1000).toISOString() })));
  await tick(); const { user } = await createCustomer(); const product = await createProduct({ storeId: shop._id });
  await Order.create({ storeId: shop._id, user: user._id, orderItems: [{ product: product._id, name: product.name, quantity: 1, price: product.price }], shippingAddress: validAddress(), paymentMethod: 'COD', paymentStatus: 'Pending', orderStatus: 'Confirmed', finalAmount: 1000, traffic: { visitorId, sessionId } });
  const stats = await report(shop); assert.equal(stats.funnel.steps[4].value, 1); assert.equal(stats.funnel.steps[5].value, 0); assert.equal(stats.commerce.codPlaced, 1);
  const csv = buildReportCsv({ sections: { traffic: { data: stats } } }); assert.match(csv, /Verified traffic funnel/); assert.match(csv, /Traffic & visitors/);
});
test('withdrawal before an offline first batch creates a tombstone instead of resurrecting tracking', async () => {
  const shop = await store(); const visitorId = id();
  const response = await request(`/api/analytics/forget?store=${shop.slug}`, { method: 'POST', body: { visitorId, deletionToken: 'deletion_token_123456789012345' } });
  assert.equal(response.status, 202); assert.equal((await collect(shop, [row(visitorId, id())])).data.reason, 'withdrawn');
  await tick(); assert.equal(await Event.countDocuments({ storeId: shop._id }), 0);
});
test('concurrent visitors cannot claim the same visit identity', async () => {
  const shop = await store(); const sessionId = id();
  const results = await Promise.all([collect(shop, [row(id(), sessionId)]), collect(shop, [row(id(), sessionId)])]);
  assert.deepEqual(results.map(result => result.status).sort(), [202, 400]); await tick();
  assert.equal((await report(shop)).metrics.visitors.value, 1);
});
test('search analytics retains catalogue topics rather than arbitrary names and addresses', async () => {
  const shop = await store(); await createProduct({ storeId: shop._id, name: 'Gold Wedding Earrings' });
  await collect(shop, [row(id(), id(), 'SEARCH', { searchQuery: 'John Doe 12 Main Street gold earrings' })]);
  const saved = await Event.findOne({ storeId: shop._id, name: 'SEARCH' }).lean();
  assert.equal(saved.searchQuery, 'gold earrings'); assert.doesNotMatch(JSON.stringify(saved), /John|Doe|Main Street/);
});
test('partial comparison bucket excludes later events and agrees with session acquisition filters', async () => {
  const shop = await store(); const visitorId = id(); const sessionId = id(); const hour = new Date(Math.floor((Date.now() - 3600000) / 900000) * 900000);
  await Visitor.create({ storeId: shop._id, visitorId, deletionHash: 'fixture', firstSeenAt: hour, firstSource: 'instagram', expiresAt: new Date(Date.now() + DAY) });
  for (const minutes of [1, 5, 12]) await Event.create({ ...row(visitorId, sessionId), storeId: shop._id, privacyGeneration: 1, source: minutes === 1 ? 'instagram' : 'facebook', occurredAt: new Date(+hour + minutes * 60000), expiresAt: new Date(Date.now() + DAY) });
  await tick(); const { overview } = require('../services/trafficReportingService');
  const stats = await overview({ storeId: shop._id }, { source: 'instagram' }, { from: hour, to: new Date(+hour + 8 * 60000), days: 1 }, shop.timezone);
  assert.equal(stats.totals.pageViews, 2); assert.equal(stats.firstSources[0].label, 'instagram');
});
test('an older worker cannot overwrite a newer materialization or acknowledge its pending events', async () => {
  const shop = await store(); const visitorId = id(); const sessionId = id(); await collect(shop, [row(visitorId, sessionId)]); await tick();
  await Session.updateOne({ storeId: shop._id, sessionId }, { materializationVersion: 500 });
  await collect(shop, [row(visitorId, sessionId)]);
  const config = await require('../services/trafficConfigurationService').configuration(shop);
  await assert.rejects(require('../services/trafficWorker').materialize(shop._id, sessionId, config, { version: 1, guard: async () => {} }));
  assert.equal((await Session.findOne({ storeId: shop._id, sessionId })).pageViews, 1);
  assert.equal(await Event.countDocuments({ storeId: shop._id, processedAt: { $exists: false } }), 1);
});
