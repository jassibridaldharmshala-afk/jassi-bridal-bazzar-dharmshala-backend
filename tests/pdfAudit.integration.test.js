const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const fs = require('node:fs/promises');
const path = require('node:path');
const { request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createAdmin, createCustomer, createProduct, setSettings, validAddress } = require('./factories');
const Store = require('../models/Store');
const Product = require('../models/Product');
const Order = require('../models/Order');
const Evidence = require('../models/VerificationEvidence');
const PrivateFile = require('../models/PrivateEvidenceFile');
const { createProvisionedSeller } = require('./accessFixtures');
let base;
test.before(async () => { base = (await startTestEnvironment()).baseUrl; });
test.after(stopTestEnvironment);
test.beforeEach(async () => { await resetDatabase(); await setSettings(); });
const privateFields = ['costPrice', 'supplierName', 'supplierSku', 'inventoryLocation', 'binLocation', 'nonSellableStock', 'lastInventoryChangedBy'];
function safe(row) { for (const field of privateFields) assert.equal(row[field], undefined, field); }
async function fixture() {
  const account = await createCustomer();
  const product = await createProduct({ costPrice: 123, supplierName: 'Private supplier', supplierSku: 'PRIVATE-SKU', inventoryLocation: 'Back room', binLocation: 'Rack secret', nonSellableStock: { damaged: 3 } });
  return { ...account, product, body: { orderItems: [{ product: product._id, quantity: 1, size: 'M', color: 'Red' }], shippingAddress: validAddress(), paymentMethod: 'COD', checkoutAttemptId: 'audit_same_checkout_attempt' } };
}
test('customer catalog, cart, wishlist and sale quote hide commercial internals; staff retains them', async () => {
  const { token, product, body } = await fixture();
  const detail = await request('/api/products/' + product._id); assert.equal(detail.status, 200); safe(detail.data);
  const list = await request('/api/products?page=1'); safe(list.data.items[0]);
  const admin = await createAdmin();
  const managed = await request('/api/admin/products/' + product._id, { token: admin.token }); assert.equal(managed.data.costPrice, 123);
  const cart = await request('/api/cart', { method: 'POST', token, body: { product: product._id, quantity: 2, size: 'M', color: 'Red' } }); assert.equal(cart.status, 201); safe(cart.data.items[0].product);
  const wish = await request('/api/wishlist/' + product._id, { method: 'POST', token }); assert.equal(wish.status, 200); safe(wish.data[0]);
  const quote = await request('/api/orders/quote', { method: 'POST', token, body }); assert.equal(quote.status, 200); safe(quote.data.items[0]);
});
test('customer COD, history and receipt snapshots hide costs without erasing accounting values', async () => {
  const { token, body, product } = await fixture();
  const created = await request('/api/orders/cod', { method: 'POST', token, body }); assert.equal(created.status, 201); safe(created.data.orderItems[0]);
  assert.equal((await Product.findById(product._id).lean()).costPrice, 123);
  // Historical imported snapshots may contain costs: serialization must still protect them.
  await Order.collection.updateOne({ _id: new (require('mongoose').Types.ObjectId)(created.data._id) }, { $set: { 'orderItems.0.costPrice': 123 } });
  const history = await request('/api/orders/my-orders', { token }); safe(history.data[0].orderItems[0]);
  const receipt = await request('/api/orders/' + created.data._id + '/receipt', { token }); assert.equal(receipt.status, 200); safe(receipt.data.items[0]);
  const cancelled = await request('/api/orders/' + created.data._id + '/cancel', { method: 'POST', token, body: { reason: 'OTHER', comment: 'Changed plans' } }); assert.equal(cancelled.status, 200); safe(cancelled.data.orderItems[0]);
});
test('new sale quote/COD/prepaid reject all closed-store states; COD replay survives closure', async () => {
  const { token, body } = await fixture();
  await request('/api/products');
  const store = await Store.findOne({ isDefault: true });
  const created = await request('/api/orders/cod', { method: 'POST', token, body }); assert.equal(created.status, 201);
  const states = [
    { salesEnabled: false }, { checkoutEnabled: false }, { status: 'SUSPENDED' }, { archivedAt: new Date() },
    { catalogStructure: { commerce: { mode: 'RENTAL_ONLY' } } }, { license: { status: 'EXPIRED', startsAt: new Date(), endsAt: new Date(0) } },
  ];
  for (const state of states) {
    await Store.updateOne({ _id: store._id }, { $set: { salesEnabled: true, checkoutEnabled: true, status: 'PUBLISHED', archivedAt: null, catalogStructure: {}, license: { status: 'ACTIVE', startsAt: new Date(), billingCycle: 'LIFETIME' }, ...state } });
    for (const [endpoint, method] of [['/api/orders/quote', 'COD'], ['/api/orders/cod', 'COD'], ['/api/payments/create-order', 'UPI']]) {
      const denied = await request(endpoint, { method: 'POST', token, body: { ...body, paymentMethod: method, checkoutAttemptId: 'new_' + Math.random().toString(36).slice(2) } });
      assert.ok([403, 402].includes(denied.status), JSON.stringify({ state, endpoint, response: denied }));
    }
    const replay = await request('/api/orders/cod', { method: 'POST', token, body }); assert.equal(replay.status, 200); assert.equal(replay.data._id, created.data._id);
  }
  assert.equal(await Order.countDocuments(), 1);
});
test('legacy public arrays respect a requested limit and a bounded default; admin remains complete', async () => {
  const { product } = await fixture();
  await Product.insertMany(Array.from({ length: 35 }, (_, index) => ({ name: 'Audit item ' + index, slug: 'audit-item-' + index, category: product.category, stock: 1, price: 100, isActive: true })));
  const limited = await request('/api/products?limit=8'); assert.equal(limited.data.length, 8);
  const legacy = await request('/api/products'); assert.equal(legacy.data.length, 24);
  const page = await request('/api/products?page=2&limit=8'); assert.equal(page.data.items.length, 8); assert.equal(page.data.total, 36);
  const admin = await createAdmin(); const full = await request('/api/admin/products', { token: admin.token }); assert.equal(full.data.length, 36);
});
async function upload(token, url = '/api/returns/evidence/uploads', bytes) {
  const data = bytes || await sharp({ create: { width: 20, height: 20, channels: 3, background: '#efbabe' } }).png().toBuffer();
  const form = new FormData(); form.append('files', new Blob([data], { type: 'image/png' }), 'shipping-label.png');
  const response = await fetch(base + url, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: form });
  return { status: response.status, data: await response.json() };
}
test('new sale evidence is private, survives API retrieval and refuses foreign users and public URLs', async () => {
  const user = await createCustomer(), foreign = await createCustomer();
  const uploaded = await upload(user.token); assert.equal(uploaded.status, 201);
  const file = uploaded.data.files[0]; assert.equal(file.provider, 'private'); assert.match(file.fileUrl, /^\/api\/evidence\/[a-f0-9]{24}$/);
  assert.equal(await PrivateFile.countDocuments(), 1);
  const own = await fetch(base + file.fileUrl, { headers: { Authorization: 'Bearer ' + user.token } }); assert.equal(own.status, 200); assert.match(own.headers.get('cache-control'), /private.*no-store/); assert.equal((await own.arrayBuffer()).byteLength, file.sizeBytes);
  assert.equal((await fetch(base + file.fileUrl)).status, 401);
  assert.equal((await fetch(base + file.fileUrl, { headers: { Authorization: 'Bearer ' + foreign.token } })).status, 404);
  const service = require('../services/privateEvidenceService');
  const records = await service.attachments({ user: user.user, tenantFilter: {} }, [{ ...file, type: 'CUSTOMER_PHOTO', mimeType: 'spoofed' }], ['CUSTOMER_PHOTO']);
  assert.equal(records[0].mimeType, 'image/png');
  await assert.rejects(service.attachments({ user: foreign.user, tenantFilter: {} }, [{ ...file, type: 'CUSTOMER_PHOTO' }], ['CUSTOMER_PHOTO']), /belong/);
  await assert.rejects(service.attachments({ user: user.user, tenantFilter: {} }, [{ fileUrl: '/uploads/public-label.png', type: 'CUSTOMER_PHOTO' }], ['CUSTOMER_PHOTO']), /privately/);
  const publicNames = await fs.readdir(path.join(__dirname, '../uploads')); assert.ok(!publicNames.some(name => name.endsWith('shipping-label.png')));
});
test('private upload validates decoded content, and revoked staff lose access to their uploaded labels', async () => {
  const customer = await createCustomer();
  const invalid = await upload(customer.token, undefined, Buffer.from('not an image')); assert.equal(invalid.status, 400); assert.equal(await PrivateFile.countDocuments(), 0);
  const seller = await createProvisionedSeller('Private Staff');
  const row = await Store.findById(seller.store.id);
  const service = require('../services/privateEvidenceService');
  const photo = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#00000000' } }).png().toBuffer();
  const saved = await service.save({ buffer: photo, mimetype: 'image/png', size: photo.length }, { user: seller.user, store: row, storeMember: { role: 'OWNER' } });
  assert.equal((await fetch(base + saved.fileUrl, { headers: { Authorization: 'Bearer ' + seller.token } })).status, 200);
  await require('../models/StoreMember').updateOne({ store: row._id, user: seller.user._id }, { status: 'REVOKED' });
  assert.equal((await fetch(base + saved.fileUrl, { headers: { Authorization: 'Bearer ' + seller.token } })).status, 404);
});


test('legacy evidence migration is a read-only dry run, then rewrites privately and purges only unshared originals', async () => {
  const admin = await createAdmin(), { token, body } = await fixture();
  const created = await request('/api/orders/cod', { method: 'POST', token, body });
  const name = 'audit-legacy-' + Date.now() + '.png', original = await sharp({ create: { width: 30, height: 40, channels: 3, background: '#f5ddcc' } }).png().toBuffer();
  const source = path.join(__dirname, '../uploads', name), url = '/uploads/' + name;
  await fs.writeFile(source, original);
  try {
    const record = await Evidence.create({ order: created.data._id, phase: 'PACKING', type: 'SHIPPING_LABEL_PHOTO', uploadedBy: admin.user._id, fileUrl: url });
    const migrate = require('../services/privateEvidenceMigration').migrate;
    const dry = await migrate(); assert.equal(dry.mode, 'dry-run'); assert.equal(dry.found, 1); assert.equal(await PrivateFile.countDocuments(), 0); assert.equal((await Evidence.findById(record._id)).fileUrl, url);
    const applied = await migrate({ apply: true, deletePublic: true }); assert.deepEqual(applied.errors, []); assert.equal(applied.migrated, 1); assert.equal(applied.purged, 1);
    const stored = await Evidence.findById(record._id).lean(); assert.match(stored.fileUrl, /^\/api\/evidence\//);
    await assert.rejects(fs.access(source), error => error.code === 'ENOENT');
    assert.notDeepEqual(Buffer.from(await (await fetch(base + url)).arrayBuffer()), original);
    const download = await fetch(base + stored.fileUrl, { headers: { Authorization: 'Bearer ' + admin.token } }); assert.equal(download.status, 200); assert.deepEqual(await sharp(Buffer.from(await download.arrayBuffer())).raw().toBuffer(), await sharp(original).raw().toBuffer());
    const replay = await migrate({ apply: true, deletePublic: true }); assert.equal(replay.found, 0); assert.equal(await PrivateFile.countDocuments(), 1);
  } finally { await fs.unlink(source).catch(() => {}); }
});
test('photo grouping is a bounded, reviewed proposal with every original preserved and no draft creation', async t => {
  const admin = await createAdmin(), gemini = require('../services/geminiJson.service'), previous = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'isolated-grouping-fixture'; t.after(() => { if (previous === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = previous; });
  t.mock.method(gemini, 'generateGeminiJson', async ({ parts }) => {
    assert.equal(parts.filter(p => p.inlineData).length, 3);
    for (const p of parts.filter(p => p.inlineData)) { const photo = Buffer.from(p.inlineData.data, 'base64'); assert.ok(photo.length <= 192 * 1024); const metadata = await sharp(photo).metadata(); assert.ok(Math.max(metadata.width, metadata.height) <= 768); }
    return { raw: { groups: [{ indices: [0, 2], name: 'Red outfit', confidence: 0.9 }] } };
  });
  const source = await sharp({ create: { width: 1200, height: 1000, channels: 3, background: '#a12344' } }).png().toBuffer();
  const form = new FormData(); for (let i = 0; i < 3; i++) form.append('images', new Blob([source], { type: 'image/png' }), 'view-' + i + '.png');
  const response = await fetch(base + '/api/admin/products/photo-grouping', { method: 'POST', body: form, headers: { Authorization: 'Bearer ' + admin.token } });
  const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); assert.equal(result.reviewRequired, true); assert.deepEqual(result.groups.flatMap(g => g.indices).sort(), [0, 1, 2]); assert.equal(await require('../models/ProductDraft').countDocuments(), 0);
  const grouping = require('../services/photoGroupingService'); assert.throws(() => grouping.normalize({ groups: [{ indices: [0, 0] }] }, 2), /more than one/);
});
test('readiness queue flags permanently missing pieces but keeps temporarily cleaning offers configured', async () => {
  const Rental = require('../models/Rental'), admin = await createAdmin(); await request('/api/products'); const store = await Store.findOne({ isDefault: true });
  await Rental.Configuration.create({ storeId: store._id, mode: 'SALE_AND_RENTAL' }); await Store.updateOne({ _id: store._id }, { 'catalogStructure.commerce.mode': 'SALE_AND_RENTAL' });
  const products = [];
  for (const name of ['Missing pieces', 'Cleaning only']) {
    const product = await createProduct({ name, commerceMode: 'RENTAL_ONLY', stock: 0 }); products.push(product);
    await Rental.Listing.create({ storeId: store._id, productId: product._id, title: name, active: true, dailyRatePaise: 10000, depositPaise: 0, requirements: [{ poolKey: String(product._id), productId: product._id, quantity: 1, label: name }] });
  }
  await Rental.Asset.create({ storeId: store._id, productId: products[1]._id, poolKey: String(products[1]._id), code: 'CLEANING-001', label: 'Cleaning only', status: 'CLEANING' });
  const queue = await request('/api/admin/rentals/readiness-queue', { token: admin.token }); assert.equal(queue.status, 200, JSON.stringify(queue.data));
  const missing = queue.data.rows.find(row => row.product.name === 'Missing pieces'); assert.ok(missing.offers[0].reasons.some(reason => reason.code === 'PIECES_MISSING' || /piece/i.test(reason.message)));
  const cleaning = queue.data.rows.find(row => row.product.name === 'Cleaning only'); assert.ok(!cleaning?.offers[0].reasons.some(reason => /actual matching pieces/i.test(reason.message)));
  const invalid = await request('/api/admin/rentals/readiness-queue?limit=1.5', { token: admin.token }); assert.equal(invalid.status, 400);
});

test('legacy migration scopes a shared uploader and URL to each store without cross-store rewrites', async () => {
  const sellerA = await createProvisionedSeller('Migration A'), sellerB = await createProvisionedSeller('Migration B');
  const admin = await createAdmin(), user = admin.user._id;
  const original = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#aacccc' } }).png().toBuffer();
  const name = 'audit-scoped-legacy-' + Date.now() + '.png', source = path.join(__dirname, '../uploads', name), url = '/uploads/' + name;
  await fs.writeFile(source, original);
  try {
    const legacyOrder = new (require('mongoose').Types.ObjectId)();
    await Order.collection.insertOne({ _id: legacyOrder, storeId: new (require('mongoose').Types.ObjectId)(sellerA.store.id) });
    const a = await Evidence.create({ order: legacyOrder, phase: 'PACKING', type: 'PRODUCT_PHOTO', uploadedBy: user, fileUrl: url });
    const b = await Evidence.create({ order: new (require('mongoose').Types.ObjectId)(), storeId: sellerB.store.id, phase: 'PACKING', type: 'PRODUCT_PHOTO', uploadedBy: user, fileUrl: url });
    const result = await require('../services/privateEvidenceMigration').migrate({ apply: true, deletePublic: true });
    assert.deepEqual(result.errors, []); assert.equal(result.migrated, 2);
    const first = await Evidence.findById(a._id).lean(), second = await Evidence.findById(b._id).lean();
    assert.notEqual(first.fileUrl, second.fileUrl);
    assert.equal(String((await PrivateFile.findById(first.privateFileId)).storeId), sellerA.store.id);
    assert.equal(String((await PrivateFile.findById(second.privateFileId)).storeId), sellerB.store.id);
    await assert.rejects(fs.access(source), error => error.code === 'ENOENT');
    const orphan = await Evidence.create({ order: new (require('mongoose').Types.ObjectId)(), phase: 'PACKING', type: 'PRODUCT_PHOTO', uploadedBy: user, fileUrl: url });
    for (const apply of [false, true]) {
      const unresolved = await require('../services/privateEvidenceMigration').migrate({ apply });
      assert.deepEqual(unresolved.errors, [{ id: String(orphan._id), code: 'EVIDENCE_SCOPE_UNKNOWN' }]);
      assert.equal((await Evidence.findById(orphan._id)).fileUrl, url);
      assert.equal(await PrivateFile.countDocuments(), 2);
    }
  } finally { await fs.unlink(source).catch(() => {}); }
});
