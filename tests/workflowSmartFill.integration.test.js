const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createAdmin, createCustomer, createProduct, setSettings } = require('./factories');
const Store = require('../models/Store');
const StoreMember = require('../models/StoreMember');
const Product = require('../models/Product');
const Order = require('../models/Order');
const Shipment = require('../models/Shipment');
const ReturnExchange = require('../models/ReturnExchange');
const Category = require('../models/Category');
const Settings = require('../models/Settings');
const base = '/api/admin/smart-fill';
const pdf = { mimeType: 'application/pdf', data: Buffer.from('%PDF-1.4\nexample test data').toString('base64'), consent: true };
test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(async t => {
  await resetDatabase(); delete process.env.GEMINI_API_KEY;
  const realFetch = global.fetch;
  t.mock.method(global, 'fetch', (url, options) => {
    assert.equal(new URL(url).hostname, '127.0.0.1', 'Real AI/provider calls must never occur');
    return realFetch(url, options);
  });
});
const preview = (token, body, prefix = base, headers) => request(prefix + '/preview', { method: 'POST', token, body, headers });
const bulk = (token, productIds, prefix = base, headers) => request(prefix + '/catalog/preview', { method: 'POST', token, headers, body: { workflow: 'catalog', context: { productIds } } });
const save = (token, body, prefix = base, headers) => request(prefix + '/catalog/save', { method: 'POST', token, body, headers });
async function tenant(role = 'OWNER', storeOverrides = {}) {
  const owner = await createCustomer({ activeMode: 'seller', availableModes: ['customer', 'seller'] });
  const store = await Store.create({ name: 'Tenant jewellery', slug: 'tenant-' + new mongoose.Types.ObjectId(), owner: owner.user._id, status: 'PUBLISHED', ...storeOverrides });
  const membership = await StoreMember.create({ store: store._id, user: owner.user._id, role, status: 'ACTIVE' });
  return { ...owner, store, membership, headers: { 'x-store-id': String(store._id) } };
}
test('preview requires authenticated verified admin or store membership', async () => {
  const body = { workflow: 'category', notes: 'Category: Earrings' };
  assert.equal((await preview(null, body)).status, 401);
  assert.equal((await preview((await createCustomer()).token, body)).status, 403);
  assert.equal((await preview((await createAdmin({ isPhoneVerified: false })).token, body)).status, 403);
  const response = await preview((await createAdmin()).token, body);
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
});
test('ordinary previews are deterministic, scoped to the brand and do not persist data', async () => {
  const admin = await createAdmin(); await setSettings({ storeName: 'Nishaya Jewellery' });
  const product = await createProduct(), before = await Product.findById(product._id).lean();
  const counts = await Promise.all([Category.countDocuments(), Settings.countDocuments(), Order.countDocuments()]);
  for (const workflow of ['category', 'banner', 'campaign', 'coupon', 'website', 'shipment', 'store']) {
    const response = await preview(admin.token, { workflow, notes: 'Category: Earrings\nTitle: Festive edit\nBrand: Nishaya\nLuxury jewellery\n10% above ₹1000' });
    assert.equal(response.status, 200, workflow + ': ' + JSON.stringify(response.data));
    assert.equal(response.data.mode, 'algorithm'); assert.doesNotMatch(JSON.stringify(response.data), /Jassi General Store/);
  }
  assert.deepEqual(await Product.findById(product._id).lean(), before);
  assert.deepEqual(await Promise.all([Category.countDocuments(), Settings.countDocuments(), Order.countDocuments()]), counts);
});
test('seller role permissions and platform capability switches govern every workflow', async () => {
  const catalog = await tenant('CATALOG_MANAGER');
  assert.equal((await preview(catalog.token, { workflow: 'category', notes: 'Category: Rings' }, '/api/seller/smart-fill', catalog.headers)).status, 200);
  for (const workflow of ['coupon', 'store', 'purchase', 'support', 'returns', 'website']) assert.equal((await preview(catalog.token, { workflow }, '/api/seller/smart-fill', catalog.headers)).status, 403, workflow);
  await Store.updateOne({ _id: catalog.store._id }, { 'catalogStructure.clientPermissions.catalog': false });
  assert.equal((await preview(catalog.token, { workflow: 'category' }, '/api/seller/smart-fill', catalog.headers)).status, 403);
});
test('warehouse roles cannot access supplier cost extraction even with AI documents', async () => {
  const warehouse = await tenant('WAREHOUSE', { plan: 'PROFESSIONAL' });
  for (const document of [undefined, pdf]) {
    const response = await preview(warehouse.token, { workflow: 'purchase', notes: 'SKU1, 5, 10', ...(document ? { document } : {}) }, '/api/seller/smart-fill', warehouse.headers);
    assert.equal(response.status, 403);
  }
});
test('expired store licence blocks previews and writes on seller and admin store overrides', async () => {
  const owner = await tenant('OWNER', { license: { status: 'EXPIRED' } });
  assert.equal((await preview(owner.token, { workflow: 'category' }, '/api/seller/smart-fill', owner.headers)).status, 402);
  const admin = await createAdmin();
  await StoreMember.create({ user: admin.user._id, store: owner.store._id, role: 'OWNER', status: 'ACTIVE' });
  assert.equal((await request(base + '/preview?storeId=' + owner.store._id, { method: 'POST', token: admin.token, body: { workflow: 'category' } })).status, 402);
});
test('cross-store products, orders, returns, overrides and private category names are inaccessible', async () => {
  const owner = await tenant(), foreign = await tenant();
  const product = await createProduct({ storeId: foreign.store._id });
  const order = await Order.create({ storeId: foreign.store._id, user: foreign.user._id, orderItems: [] });
  const item = await ReturnExchange.create({ storeId: foreign.store._id, user: foreign.user._id, product: product._id, order: order._id, type: 'return' });
  for (const body of [{ workflow: 'support', context: { orderId: String(order._id) } }, { workflow: 'returns', context: { caseId: String(item._id) } }]) assert.equal((await preview(owner.token, body, '/api/seller/smart-fill', owner.headers)).status, 404);
  assert.equal((await bulk(owner.token, [String(product._id)], '/api/seller/smart-fill', owner.headers)).status, 404);
  assert.equal((await request(base + '/preview?storeId=' + foreign.store._id, { method: 'POST', token: (await createAdmin()).token, body: { workflow: 'store' } })).status, 403);
  const category = await Category.create({ storeId: foreign.store._id, name: 'Foreign private category', slug: 'foreign' });
  const local = await createProduct({ storeId: owner.store._id, category: category._id });
  const response = await bulk(owner.token, [String(local._id)], '/api/seller/smart-fill', owner.headers);
  assert.equal(response.status, 200); assert.doesNotMatch(JSON.stringify(response.data), /Foreign private category/);
});
test('support/return drafts read real scoped shipment/payment facts, not client promises or private customer data', async () => {
  const admin = await createAdmin(), customer = await createCustomer(), product = await createProduct();
  const order = await Order.create({ user: customer.user._id, orderItems: [], invoiceNumber: 'INV-99', orderStatus: 'Shipped', paymentStatus: 'Paid', shippingAddress: { fullName: 'private name', mobile: 'private phone' } });
  const shipment = await Shipment.create({ order: order._id, trackingNumber: 'TRACK-99' });
  await Order.updateOne({ _id: order._id }, { shipment: shipment._id });
  const item = await ReturnExchange.create({ user: customer.user._id, product: product._id, order: order._id, type: 'return', status: 'Requested', caseNumber: 'RET-99' });
  for (const body of [{ workflow: 'support', context: { orderId: String(order._id) } }, { workflow: 'returns', context: { caseId: String(item._id) } }]) {
    const response = await preview(admin.token, { ...body, current: { orderStatus: 'Delivered', paymentStatus: 'Refunded' }, notes: 'refund 5000 tomorrow' });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    const source = JSON.stringify(response.data);
    assert.match(source, /TRACK-99/); assert.match(source, /Shipped/); assert.doesNotMatch(source, /private name|private phone|5000|tomorrow|Delivered/);
  }
  assert.equal((await Order.findById(order._id)).orderStatus, 'Shipped'); assert.equal((await ReturnExchange.findById(item._id)).status, 'Requested');
});
test('purchase matches store-specific simple/variant SKUs without changing stock', async () => {
  const owner = await tenant();
  const plain = await createProduct({ storeId: owner.store._id, sku: 'PLAIN-1', stock: 10 });
  const variant = await createProduct({ storeId: owner.store._id, sku: 'PARENT', variants: [{ sku: 'VAR-1', size: 'M', stock: 6, price: 500 }] });
  await createProduct({ storeId: (await tenant()).store._id, sku: 'FOREIGN-1' });
  const response = await preview(owner.token, { workflow: 'purchase', notes: 'Supplier: Test\nPLAIN-1, 5, 100\nVAR-1, 2, 150\nFOREIGN-1, 2, 90' }, '/api/seller/smart-fill', owner.headers);
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.deepEqual(response.data.suggestions.find(row => row.path === 'items').value, [{ selection: String(plain._id), quantity: 5, unitCost: 100 }, { selection: String(variant._id) + ':' + variant.variants[0]._id, quantity: 2, unitCost: 150 }]);
  assert.deepEqual(response.data.purchaseOptions.map(option => option.productId).sort(), [String(plain._id), String(variant._id)].sort());
  assert.ok(response.data.purchaseOptions.every(option => !Object.hasOwn(option, 'costPrice') && !Object.hasOwn(option, 'stock')));
  assert.equal((await Product.findById(plain._id)).stock, 10); assert.equal((await Product.findById(variant._id)).variants[0].stock, 6);
});
test('bulk catalog requires explicit safe-field saves and protects prices/stock/revisions', async () => {
  const admin = await createAdmin(), product = await createProduct({ sku: 'SAFE-1', stock: 10, fabric: 'Cotton', description: '' });
  const before = await Product.findById(product._id).lean();
  const response = await bulk(admin.token, [String(product._id)]);
  assert.equal(response.status, 200, JSON.stringify(response.data)); assert.deepEqual(await Product.findById(product._id).lean(), before);
  const row = response.data.records[0];
  for (const changes of [{ price: 1 }, { stock: 999 }, { category: String(product.category) }, { isActive: false }, { variants: [] }, { description: {} }]) assert.equal((await save(admin.token, { id: row.id, expectedUpdatedAt: row.updatedAt, changes })).status, 400);
  const saved = await save(admin.token, { id: row.id, expectedUpdatedAt: row.updatedAt, changes: { description: 'Reviewed cotton listing', tags: ['Cotton', 'Cotton'] } });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const after = await Product.findById(product._id).lean();
  assert.equal(after.description, 'Reviewed cotton listing'); assert.deepEqual(after.tags, ['Cotton']);
  for (const field of ['price', 'stock', 'sizes', 'colors', 'variants', 'sku', 'isActive', 'category', 'inventoryRevision']) assert.deepEqual(after[field], before[field], field);
  assert.ok(after.updatedAt > before.updatedAt);
  assert.equal((await save(admin.token, { id: row.id, expectedUpdatedAt: row.updatedAt, changes: { description: 'Stale overwrite' } })).status, 409);
});
test('concurrent reviewed catalog saves admit exactly one revision', async () => {
  const admin = await createAdmin(), product = await createProduct();
  const body = { id: String(product._id), expectedUpdatedAt: product.updatedAt.toISOString(), changes: { metaTitle: 'Reviewed' } };
  const results = await Promise.all([save(admin.token, body), save(admin.token, { ...body, changes: { metaTitle: 'Other review' } })]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
});
test('catalog rejects duplicate, oversized, archived and out-of-store batches', async () => {
  const admin = await createAdmin(), product = await createProduct({ isArchived: true });
  for (const ids of [[], Array(21).fill(String(product._id)), [String(product._id), String(product._id)], ['invalid']]) assert.equal((await bulk(admin.token, ids)).status, 400);
  assert.equal((await bulk(admin.token, [String(product._id)])).status, 404);
});
test('document extraction requires consent, signatures, bounded data and enabled AI feature', async () => {
  const admin = await createAdmin();
  for (const document of [{ ...pdf, consent: false }, { ...pdf, mimeType: 'image/png' }, { ...pdf, data: Buffer.from('not a pdf').toString('base64') }, { ...pdf, data: Buffer.alloc(512 * 1024 + 1).toString('base64') }]) assert.equal((await preview(admin.token, { workflow: 'shipment', document })).status, 400);
  assert.equal((await preview(admin.token, { workflow: 'coupon', document: pdf })).status, 400);
  const missing = await preview(admin.token, { workflow: 'shipment', document: pdf });
  assert.equal(missing.status, 503); assert.equal(missing.data.code, 'AI_KEY_MISSING');
  const owner = await tenant('OWNER', { plan: 'BASIC' });
  assert.equal((await preview(owner.token, { workflow: 'shipment', document: pdf }, '/api/seller/smart-fill', owner.headers)).status, 403);
  assert.equal((await preview(owner.token, { workflow: 'shipment', notes: 'AWB: TRACK12345' }, '/api/seller/smart-fill', owner.headers)).status, 200);
});
test('mocked document AI transcribes only text; no media, shipment or order is persisted', async t => {
  process.env.GEMINI_API_KEY = 'unit-test-key-only';
  const localFetch = global.fetch; let calls = 0;
  t.mock.method(global, 'fetch', async (url, options) => {
    if (new URL(url).hostname !== 'generativelanguage.googleapis.com') return localFetch(url, options);
    calls += 1; const body = JSON.parse(options.body);
    assert.equal(body.contents[0].parts[1].inlineData.mimeType, 'application/pdf');
    assert.equal(options.headers['x-goog-api-key'], 'unit-test-key-only');
    return { ok: true, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ text: 'Courier: Blue Dart\nAWB: TRACK12345\nstock: 999\npaymentStatus: Paid' }) }] } }] }) };
  });
  const response = await preview((await createAdmin()).token, { workflow: 'shipment', document: pdf });
  assert.equal(response.status, 200, JSON.stringify(response.data)); assert.equal(calls, 1);
  assert.equal(response.data.suggestions.find(row => row.path === 'trackingNumber').value, 'TRACK12345');
  assert.ok(!response.data.suggestions.some(row => ['stock', 'paymentStatus'].includes(row.path)));
  assert.equal(await Shipment.countDocuments(), 0); assert.equal(await Order.countDocuments(), 0);
});
test('malformed/prototype input is a 400 without changing server objects or revealing secrets', async () => {
  const admin = await createAdmin();
  for (const body of [{ workflow: 'constructor' }, { workflow: 'store', notes: {} }, { workflow: 'category', current: [] }, JSON.parse('{"workflow":"store","current":{"__proto__":{"polluted":true}}}')]) assert.equal((await preview(admin.token, body)).status, 400);
  assert.equal({}.polluted, undefined);
  const status = await request(base + '/status', { token: admin.token });
  assert.equal(status.data.documentExtraction, false); assert.doesNotMatch(JSON.stringify(status.data), /key|token/i);
});
test('inbox drafts must use the linked customer order, not another customer in the same store', async () => {
  const owner = await tenant(), first = await createCustomer(), other = await createCustomer();
  const { Thread } = require('../modules/social-workspace/models');
  const thread = await Thread.create({ storeId: owner.store._id, connectionId: new mongoose.Types.ObjectId(), participantId: 'participant', customer: first.user._id });
  const correct = await Order.create({ storeId: owner.store._id, user: first.user._id, orderItems: [], invoiceNumber: 'CUSTOMER-ONE' });
  const wrong = await Order.create({ storeId: owner.store._id, user: other.user._id, orderItems: [], invoiceNumber: 'CUSTOMER-TWO' });
  const body = id => ({ workflow: 'support', context: { threadId: String(thread._id), orderId: String(id) } });
  assert.equal((await preview(owner.token, body(wrong._id), '/api/seller/smart-fill', owner.headers)).status, 404);
  const response = await preview(owner.token, body(correct._id), '/api/seller/smart-fill', owner.headers);
  assert.equal(response.status, 200); assert.match(JSON.stringify(response.data), /CUSTOMER-ONE/);
  await Thread.updateOne({ _id: thread._id }, { $unset: { customer: 1 } });
  assert.equal((await preview(owner.token, body(correct._id), '/api/seller/smart-fill', owner.headers)).status, 404);
});
test('duplicate document analysis cannot incur a second provider call', async t => {
  process.env.GEMINI_API_KEY = 'unit-test-key-only';
  const localFetch = global.fetch;
  let release, announce; const entered = new Promise(done => { announce = done; });
  const held = new Promise(done => { release = done; });
  t.mock.method(global, 'fetch', async (url, options) => {
    if (new URL(url).hostname !== 'generativelanguage.googleapis.com') return localFetch(url, options);
    announce(); await held;
    return { ok: true, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"text":"AWB: TRACK12345"}' }] } }] }) };
  });
  const admin = await createAdmin(); const body = { workflow: 'shipment', document: pdf };
  const first = preview(admin.token, body); await entered;
  const second = await preview(admin.token, body); assert.equal(second.status, 409);
  release(); assert.equal((await first).status, 200);
});
