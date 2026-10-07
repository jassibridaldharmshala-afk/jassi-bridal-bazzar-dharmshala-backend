const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const mongoose = require('mongoose');
const AuditLog = require('../models/AuditLog');
const User = require('../models/User');
const { sanitizeAudit, auditSnapshot, changedFields, isPrivateAudit } = require('../utils/auditData');
const { logAudit, hasAuditWriteFailures } = require('../services/auditService');
const { buildAuditQuery, scopeFor, auditView } = require('../services/auditQuery');
const { auditAdminRequests } = require('../middleware/auditMiddleware');
const controller = require('../controllers/auditController');

const ID = '0123456789abcdef01234567';
const STORE = new mongoose.Types.ObjectId('0123456789abcdef01234568');
const NOW = new Date('2026-09-05T12:00:00.000Z');
const admin = () => ({ user: { _id: ID, name: 'Store manager', role: 'admin', activeMode: 'admin' }, query: {}, baseUrl: '/api/admin/audit-logs' });
const owner = () => ({ ...admin(), user: { ...admin().user, phone: '9816978086', systemRole: 'MASTER_OWNER', isPhoneVerified: true, $locals: { masterAuthenticated: true } } });
const seller = () => ({ ...admin(), baseUrl: '/api/seller', store: { _id: STORE }, storeMember: { role: 'STAFF' }, tenantFilter: { storeId: STORE } });
function response() { return { setHeader() {}, json(value) { this.body = value; return this; } }; }
function queryResult(value, calls = []) {
  const chain = { then: (resolve, reject) => Promise.resolve(value).then(resolve, reject) };
  for (const method of ['select', 'populate', 'sort', 'skip', 'limit', 'maxTimeMS', 'lean', 'option']) chain[method] = (...args) => { calls.push([method, ...args]); return chain; };
  return chain;
}
test('sanitizes nested secrets, PII, buffers and identifiers without losing falsy values', () => {
  const raw = { stock: 0, enabled: false, role: null, nested: { deeper: { access_token: 'secret-value', accountSid: 'sensitive', mobile: '9876543210' } }, privateKey: 'private', id: STORE, when: NOW, attachment: Buffer.from('secret') };
  const data = sanitizeAudit(raw);
  assert.equal(data.stock, 0); assert.equal(data.enabled, false); assert.equal(data.role, null);
  assert.equal(data.nested.deeper.access_token, '[redacted]');
  assert.equal(data.nested.deeper.mobile, '[redacted]');
  assert.equal(data.id, String(STORE)); assert.equal(data.when, NOW.toISOString());
  assert.equal(data.attachment, '[binary omitted]');
  assert.ok(!JSON.stringify(data).includes('secret-value'));
});
test('truncates deeply nested and circular payloads instead of returning original secrets', () => {
  const raw = {}; let node = raw;
  for (let i = 0; i < 20; i++) { node.next = {}; node = node.next; }
  node.password = 'do-not-leak'; raw.circular = raw;
  const text = JSON.stringify(sanitizeAudit(raw));
  assert.ok(text.includes('[truncated]')); assert.ok(text.includes('[circular]')); assert.ok(!text.includes('do-not-leak'));
  assert.ok(JSON.stringify(sanitizeAudit(Array(500).fill('x'))).length < 500);
});
test('redacts common credential patterns and rejects prototype keys', () => {
  const data = sanitizeAudit(JSON.parse('{"__proto__":{"polluted":true},"note":"Bearer testvalue contact test@example.test","price":42}'));
  assert.equal(data.__proto__, undefined); assert.equal({}.polluted, undefined);
  assert.equal(data.note, '[redacted] contact [redacted email]');
});
test('snapshots are detached and changed fields exclude database timestamps', () => {
  const item = { stock: 3, sizes: ['S'] };
  const before = auditSnapshot(item, ['stock', 'sizes']);
  item.sizes.push('M'); item.stock = 0;
  assert.deepEqual(before.sizes, ['S']);
  assert.deepEqual(changedFields({ stock: 3, updatedAt: 'a' }, { stock: 0, updatedAt: 'b' }), ['stock']);
});
test('signed URL parameters and embedded credentials are not retained', () => {
  const data = sanitizeAudit({ url: 'https://user:credential@example.test/file?X-Amz-Signature=private-value' });
  assert.ok(!data.url.includes('credential')); assert.ok(!data.url.includes('private-value'));
  assert.ok(data.url.includes('[parameters omitted]'));
});
test('privileged events are identified even without new visibility metadata', () => {
  for (const action of ['MASTER_CONFIG_UPDATE', 'WEBSITE_THEME_DRAFT_SAVE', 'ROLE_PROMOTE', 'CLIENT_ADMIN_PROVISION']) assert.ok(isPrivateAudit({ action }));
  assert.ok(isPrivateAudit({ path: '/api/master/configuration' }));
  assert.ok(isPrivateAudit({ path: '/api/MASTER/configuration' }));
  assert.ok(!isPrivateAudit({ action: 'PRODUCT_UPDATE', entityType: 'Product' }));
});
test('scope cannot be broadened through query filters, and sellers never see owner events', () => {
  const req = seller(); req.query = { storeId: ID, action: 'MASTER_CONFIG_UPDATE', entityType: 'WebsiteTheme' };
  const built = buildAuditQuery(req, NOW);
  assert.equal(String(built.filter.$and[0].storeId), String(STORE));
  assert.deepEqual(built.filter.$and[0].visibility, { $ne: 'OWNER' });
  assert.ok(built.filter.$and[0].action.$not.test('MASTER_CONFIG_UPDATE'));
  assert.equal(scopeFor(owner()).visibility, undefined);
  assert.throws(() => scopeFor({ ...seller(), store: null }), /membership/);
  assert.throws(() => scopeFor({ user: { role: 'customer' } }), /Admin access/);
});
test('filters escape search regex, validate inputs and use a stable snapshot', () => {
  const req = admin(); req.query = { q: '.*(a)', page: '2', limit: '25', asOf: NOW.toISOString(), from: '2026-09-01T00:00:00.000Z' };
  const built = buildAuditQuery(req, NOW);
  assert.equal(built.skip, 25); assert.equal(built.asOf, NOW.toISOString());
  const pattern = built.filter.$and.find((part) => part.$or).$or[0].action;
  assert.ok(pattern.test('.*(a)')); assert.ok(!pattern.test('aaaa'));
  for (const query of [{ q: { $gt: '' } }, { action: ['x'] }, { limit: '100000' }, { page: '-1' }, { page: '1.5' }, { from: 'invalid' }, { from: '2026-09-04T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z' }, { actor: 'bad' }, { outcome: 'PENDING' }, { asOf: '2026-10-01T00:00:00.000Z' }]) {
    assert.throws(() => buildAuditQuery({ ...admin(), query }, NOW), undefined, JSON.stringify(query));
  }
});
test('legacy records do not invent actors, sources or success statuses', () => {
  const result = auditView({ _id: ID, actor: null, action: 'PRODUCT_UPDATE', entityType: 'Product', ip: 'private', before: { password: 'old-secret' } }, true);
  assert.equal(result.actor.name, 'Actor unavailable'); assert.equal(result.source, 'LEGACY'); assert.equal(result.outcome, 'LEGACY'); assert.equal(result.ip, undefined);
  assert.equal(result.before.password, '[redacted]');
});
test('deleted or renamed users retain the event-time snapshot', () => {
  const result = auditView({ _id: ID, actor: { _id: ID, name: 'New name', phone: 'private' }, actorSnapshot: { name: 'Original name', role: 'admin', kind: 'USER' } });
  assert.equal(result.actor.name, 'Original name'); assert.equal(result.actor.phone, undefined);
});
test('writer persists safe snapshots with real actor, store and request correlation', async (t) => {
  let saved;
  t.mock.method(AuditLog, 'create', async (value) => { saved = value; return value; });
  const req = { ...seller(), requestId: 'request-123', ip: 'private', body: { password: 'do-not-capture' } };
  await logAudit({ req, action: 'STOCK_UPDATE', entityType: 'Product', entityId: ID, before: { stock: 2 }, after: { stock: 0 } });
  assert.equal(saved.actor, ID); assert.equal(saved.storeId, STORE); assert.equal(saved.source, 'SELLER');
  assert.equal(saved.requestId, 'request-123'); assert.equal(saved.ip, undefined); assert.equal(saved.body, undefined);
  assert.deepEqual(saved.changedFields, ['stock']); assert.equal(req.auditEventRecorded, true);
});
test('invalid store scope is not silently turned into an unscoped event', async (t) => {
  const spy = t.mock.method(AuditLog, 'create', async () => ({}));
  t.mock.method(console, 'error', () => {});
  assert.equal(await logAudit({ action: 'PRODUCT_UPDATE', entityType: 'Product', storeId: 'bad-store' }), null);
  assert.equal(spy.mock.callCount(), 0);
});
test('audit write failures are reported safely without throwing at checkout', async (t) => {
  t.mock.method(AuditLog, 'create', async () => { throw new Error('secret database URI'); });
  const output = t.mock.method(console, 'error', () => {});
  assert.equal(await logAudit({ req: admin(), action: 'ORDER_CREATE', entityType: 'Order' }), null);
  assert.equal(hasAuditWriteFailures(), true);
  const message = output.mock.calls[0].arguments[0];
  assert.ok(message.includes('AUDIT_WRITE_FAILED')); assert.ok(!message.includes('secret database URI'));
});
test('request fallback distinguishes rejected requests and avoids duplicate success events', async (t) => {
  const records = []; t.mock.method(AuditLog, 'create', async (value) => { records.push(value); return value; });
  const req = { ...admin(), originalUrl: '/api/admin/categories/' + ID + '?token=secret', method: 'PATCH', route: { path: '/:id' }, params: { id: ID }, body: { password: 'secret' } };
  const res = new EventEmitter(); res.statusCode = 403;
  let next = false; auditAdminRequests(req, res, () => { next = true; }); res.emit('finish');
  assert.ok(next); assert.equal(records.length, 1); assert.equal(records[0].outcome, 'REJECTED');
  assert.equal(records[0].http.route, '/api/admin/categories/:id'); assert.ok(!JSON.stringify(records).includes('secret'));
  const duplicate = new EventEmitter(); duplicate.statusCode = 200;
  auditAdminRequests({ ...req, auditEventRecorded: true }, duplicate, () => {}); duplicate.emit('finish');
  assert.equal(records.length, 1);
});
test('request fallback ignores reads, OTP endpoints and unauthenticated requests', (t) => {
  const records = []; t.mock.method(AuditLog, 'create', async (value) => { records.push(value); return value; });
  for (const fields of [{ method: 'GET' }, { originalUrl: '/api/admin/login' }, { user: null }]) {
    const res = new EventEmitter(); res.statusCode = 200;
    auditAdminRequests({ ...admin(), method: 'POST', originalUrl: '/api/admin/orders', ...fields }, res, () => {});
    res.emit('finish');
  }
  assert.equal(records.length, 0);
});
test('list loads only bounded summary fields, returning pagination and no-store', async (t) => {
  const calls = []; let filter;
  t.mock.method(AuditLog, 'find', (value) => { filter = value; return queryResult([{ _id: ID, action: 'STOCK_UPDATE', entityType: 'Product', source: 'ADMIN', outcome: 'SUCCESS' }], calls); });
  t.mock.method(AuditLog, 'countDocuments', () => queryResult(51));
  const res = response(); const req = { ...admin(), query: { page: '2', limit: '25' } };
  await controller.list(req, res, (error) => { throw error; });
  assert.equal(res.body.totalPages, 3); assert.equal(res.body.items.length, 1);
  assert.ok(calls.some(([name, value]) => name === 'select' && value.includes('-before')));
  assert.ok(calls.some(([name, value]) => name === 'skip' && value === 25));
  assert.ok(calls.some(([name, value]) => name === 'maxTimeMS' && value === 5000));
  assert.ok(filter.$and[0].action.$not);
});
test('detail lookup enforces identical permissions and redacts legacy secrets', async (t) => {
  let filter;
  t.mock.method(AuditLog, 'findOne', (value) => { filter = value; return queryResult({ _id: ID, action: 'SETTINGS_UPDATE', before: { apiKey: 'secret' }, actor: { _id: ID, name: 'Manager', phone: 'private' } }); });
  const res = response();
  await controller.get({ ...seller(), params: { id: ID } }, res, (error) => { throw error; });
  assert.equal(filter.$and[0].storeId, STORE);
  assert.equal(res.body.before.apiKey, '[redacted]'); assert.equal(res.body.actor.phone, undefined);
  assert.equal(res.body.canDelete, false);
});
test('missing or inaccessible event yields not found rather than empty fabricated details', async (t) => {
  t.mock.method(AuditLog, 'findOne', () => queryResult(null));
  let error; await controller.get({ ...admin(), params: { id: ID } }, response(), (value) => { error = value; });
  assert.equal(error.statusCode, 404);
});
test('options use the same store and owner visibility filters as history', async (t) => {
  const pipelines = []; t.mock.method(AuditLog, 'aggregate', (pipeline) => { pipelines.push(pipeline); return queryResult([{ _id: 'Product' }]); });
  const res = response(); await controller.options(seller(), res, (error) => { throw error; });
  assert.equal(pipelines.length, 2); assert.equal(pipelines[0][0].$match.storeId, STORE);
  assert.ok(pipelines[0][0].$match.action.$not); assert.equal(pipelines[0].at(-1).$limit, 200);
});

test('admin event details expose deletion capability while customer access remains forbidden', async (t) => {
  const read = t.mock.method(AuditLog, 'findOne', () => queryResult({ _id: ID, action: 'STOCK_UPDATE' }));
  const res = response();
  await controller.get({ ...admin(), params: { id: ID } }, res, (error) => { throw error; });
  assert.equal(res.body.canDelete, true);
  let error;
  await controller.get({ ...admin(), user: { role: 'customer' }, params: { id: ID } }, response(), (value) => { error = value; });
  assert.equal(error.statusCode, 403);
  assert.equal(read.mock.callCount(), 1);
});

test('deletion targets one scoped event and records its removal without retaining original snapshots', async (t) => {
  let filter; const calls = []; let removal;
  t.mock.method(AuditLog, 'findOneAndDelete', (value) => {
    filter = value;
    return queryResult({ _id: ID, storeId: STORE, action: 'STOCK_UPDATE', entityType: 'Product', before: { stock: 5 }, after: { stock: 0 } }, calls);
  });
  t.mock.method(AuditLog, 'create', async (value) => { removal = value; return value; });
  const req = { ...admin(), tenantFilter: { storeId: STORE }, params: { id: ID }, requestId: 'delete-request', query: { storeId: 'different-store' } };
  const res = response();
  await controller.remove(req, res, (error) => { throw error; });
  assert.deepEqual(filter.$and[1], { _id: ID });
  assert.equal(filter.$and[0].storeId, STORE);
  assert.deepEqual(filter.$and[0].visibility, { $ne: 'OWNER' });
  assert.ok(filter.$and[0].action.$not.test('MASTER_CONFIG_UPDATE'));
  assert.ok(calls.some(([name, value]) => name === 'maxTimeMS' && value === 5000));
  assert.deepEqual(res.body, { success: true, id: ID });
  assert.equal(removal.action, 'AUDIT_LOG_DELETE'); assert.equal(removal.entityType, 'AuditLog');
  assert.equal(removal.entityId, ID); assert.equal(removal.actor, ID); assert.equal(removal.storeId, STORE);
  assert.equal(removal.requestId, 'delete-request'); assert.equal(removal.before, undefined); assert.equal(removal.after, undefined);
  assert.equal(removal.visibility, 'STORE'); assert.equal(req.auditEventRecorded, true);
});

test('owner-only and legacy private event deletions remain owner-only', async (t) => {
  let record; const removals = []; const filters = [];
  t.mock.method(AuditLog, 'findOneAndDelete', (filter) => { filters.push(filter); return queryResult(record); });
  t.mock.method(AuditLog, 'create', async (value) => { removals.push(value); return value; });
  for (const privateFields of [{ visibility: 'OWNER' }, { action: 'MASTER_CONFIG_UPDATE' }, { entityType: 'WebsiteTheme' }]) {
    record = { _id: ID, action: 'CONFIG_UPDATE', ...privateFields };
    await controller.remove({ ...owner(), params: { id: ID } }, response(), (error) => { throw error; });
  }
  assert.ok(filters.every((filter) => filter.$and[0].visibility === undefined));
  assert.ok(removals.every((value) => value.action === 'MASTER_AUDIT_LOG_DELETE' && value.visibility === 'OWNER'));
});

test('customers, inactive admins and seller readers cannot delete even by calling the controller directly', async (t) => {
  const remove = t.mock.method(AuditLog, 'findOneAndDelete', () => queryResult({ _id: ID }));
  for (const req of [seller(), { ...admin(), user: null }, { ...admin(), user: { role: 'customer', activeMode: 'customer' } }, { ...admin(), user: { role: 'admin', activeMode: 'customer' } }]) {
    let error;
    await controller.remove({ ...req, params: { id: ID } }, response(), (value) => { error = value; });
    assert.equal(error.statusCode, 403);
  }
  assert.equal(remove.mock.callCount(), 0);
});

test('invalid IDs are rejected before deletion; missing, inaccessible or already-deleted events return 404', async (t) => {
  const remove = t.mock.method(AuditLog, 'findOneAndDelete', () => queryResult(null));
  const record = t.mock.method(AuditLog, 'create', async () => ({}));
  let error;
  await controller.remove({ ...admin(), params: { id: 'invalid' } }, response(), (value) => { error = value; });
  assert.equal(error.statusCode, 400); assert.equal(remove.mock.callCount(), 0);
  await controller.remove({ ...admin(), params: { id: ID } }, response(), (value) => { error = value; });
  assert.equal(error.statusCode, 404); assert.equal(record.mock.callCount(), 0);
  assert.equal(error.errorCode, 'AUDIT_EVENT_NOT_FOUND');
});

test('database deletion failures report an error without claiming a successful deletion', async (t) => {
  t.mock.method(AuditLog, 'findOneAndDelete', () => { throw new Error('Database unavailable'); });
  const record = t.mock.method(AuditLog, 'create', async () => ({}));
  let error; const res = response();
  await controller.remove({ ...admin(), params: { id: ID } }, res, (value) => { error = value; });
  assert.equal(error.message, 'Database unavailable'); assert.equal(res.body, undefined);
  assert.equal(record.mock.callCount(), 0);
});
