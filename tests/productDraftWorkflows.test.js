const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createAdmin, createCustomer } = require('./factories');
const Category = require('../models/Category');
const Product = require('../models/Product');
const ProductDraft = require('../models/ProductDraft');
const InventoryTransaction = require('../models/InventoryTransaction');
const { publishPreparedDraft } = require('../controllers/productDraftController');

test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(resetDatabase);
async function draftFixture(overrides = {}) {
  const hasCategoryOverride = Object.prototype.hasOwnProperty.call(overrides, 'category');
  const category = hasCategoryOverride ? null : await Category.findOne({ slug: 'draft-sarees' }) || await Category.create({ name: 'Sarees', slug: 'draft-sarees' });
  return ProductDraft.create({ name: 'Rose cotton saree', category: hasCategoryOverride ? overrides.category : category._id, images: [{ url: '/uploads/test.jpg', primary: true }],
    price: 1299, sellingPrice: 1299, originalPrice: 1599, stock: 4, sizingMode: 'free-size', ...overrides });
}
const publish = (token, ids) => request('/api/admin/product-drafts/publish-selected', { method: 'POST', token, body: { ids } });

test('missing or invalid selected drafts fail before any product is published', async () => {
  const { token } = await createAdmin(), draft = await draftFixture();
  const missing = await publish(token, [String(draft._id), String(new mongoose.Types.ObjectId())]);
  assert.equal(missing.status, 404);
  assert.equal(await Product.countDocuments(), 0);
  const invalid = await publish(token, ['not-an-id']);
  assert.equal(invalid.status, 400);
  assert.equal(await Product.countDocuments(), 0);
});

test('manual product draft preserves commercial, fulfilment and scheduling details when published', async () => {
  const { token } = await createAdmin();
  const category = await Category.create({ name: 'Kurtis', slug: 'manual-kurtis' });
  const created = await request('/api/admin/product-drafts', {
    method: 'POST', token, body: {
      name: 'Manual cotton kurti', sku: 'MANUAL-1', category: String(category._id),
      images: [{ url: '/uploads/manual.jpg', primary: true }], price: 999, originalPrice: 1499,
      costPrice: 500, gstRate: 5, hsnCode: '6204', stock: 6, lowStockAlert: 2,
      reorderQuantity: 12, shippingWeightKg: 0.45, packageDimensions: { lengthCm: 30, widthCm: 24, heightCm: 4 },
      countryOfOrigin: 'India', supplierName: 'Local artisan', supplierSku: 'ART-22',
      publishAt: '2030-01-01T10:00:00.000Z', saleStartAt: '2030-01-02T10:00:00.000Z', saleEndAt: '2030-01-03T10:00:00.000Z',
      description: 'A breathable cotton kurti prepared as a complete manual catalog draft.', sizingMode: 'free-size',
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.data.sourceType, 'manual');

  const published = await publish(token, [created.data.data._id]);
  assert.equal(published.status, 200, JSON.stringify(published.data));
  const product = await Product.findById(published.data.data.products[0]._id);
  assert.equal(product.costPrice, 500);
  assert.equal(product.gstRate, 5);
  assert.equal(product.hsnCode, '6204');
  assert.equal(product.reorderQuantity, 12);
  assert.equal(product.packageDimensions.lengthCm, 30);
  assert.equal(product.supplierName, 'Local artisan');
  assert.equal(product.publishAt.toISOString(), '2030-01-01T10:00:00.000Z');
  const opening = await InventoryTransaction.find({ product: product._id, type: 'IMPORT' });
  assert.equal(opening.length, 1);
  assert.equal(opening[0].stockBefore, 0);
  assert.equal(opening[0].stockAfter, 6);
});

test('manual add-product autosave is isolated per user and updates one cross-device draft', async () => {
  const owner = await createAdmin();
  const other = await createAdmin();
  const first = await request('/api/admin/product-drafts/autosave', { method: 'PUT', token: owner.token, body: { autosaveKey: 'active-add-product:admin', name: 'Cloud draft one', sku: 'CLOUD-1', description: 'Work in progress' } });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const firstId = first.data.data.id;

  const second = await request('/api/admin/product-drafts/autosave', { method: 'PUT', token: owner.token, body: { autosaveKey: 'active-add-product:admin', name: 'Cloud draft updated', sku: 'CLOUD-1', description: 'Work in progress' } });
  assert.equal(second.status, 200);
  assert.equal(second.data.data.id, firstId);
  assert.equal(await ProductDraft.countDocuments({ autosaveKey: 'active-add-product:admin' }), 1);

  const restored = await request('/api/admin/product-drafts/autosave?key=active-add-product%3Aadmin', { token: owner.token });
  assert.equal(restored.data.data.name, 'Cloud draft updated');
  const ordinaryDraftList = await request('/api/admin/product-drafts', { token: owner.token });
  assert.equal(ordinaryDraftList.data.data.length, 0);
  const publishAutosave = await publish(owner.token, [firstId]);
  assert.equal(publishAutosave.status, 404);
  const isolated = await request('/api/admin/product-drafts/autosave?key=active-add-product%3Aadmin', { token: other.token });
  assert.equal(isolated.data.data, null);
});

test('concurrent ordinary draft publications and retry create exactly one product', async () => {
  const { token } = await createAdmin(), draft = await draftFixture();
  await Product.init();
  const responses = await Promise.all([publish(token, [String(draft._id)]), publish(token, [String(draft._id)])]);
  responses.forEach(response => assert.equal(response.status, 200, JSON.stringify(response.data)));
  const retry = await publish(token, [String(draft._id), String(draft._id)]);
  assert.equal(retry.status, 200);
  assert.equal(await Product.countDocuments({ sourceDraftId: draft._id }), 1);
  assert.equal(retry.data.data.products.length, 1);
  const saved = await ProductDraft.findById(draft._id);
  assert.equal(saved.status, 'published');
  assert.equal(String(saved.publishedProductId), String(retry.data.data.products[0]._id));
});

test('publication rolls back product creation if saving draft state is interrupted and retry succeeds', async () => {
  const draft = await draftFixture();
  const actualSave = draft.save.bind(draft);
  draft.save = async () => { throw new Error('Synthetic local write interruption'); };
  await assert.rejects(publishPreparedDraft(draft), /write interruption/);
  assert.equal(await Product.countDocuments({ sourceDraftId: draft._id }), 0);
  assert.equal(await InventoryTransaction.countDocuments(), 0);
  assert.equal((await ProductDraft.findById(draft._id).select('+publishingToken')).publishingToken, undefined);
  const retryDraft = await ProductDraft.findById(draft._id);
  assert.equal(retryDraft.status, 'draft');
  const result = await publishPreparedDraft(retryDraft);
  assert.equal(await Product.countDocuments({ sourceDraftId: draft._id }), 1);
  assert.equal(String((await ProductDraft.findById(draft._id)).publishedProductId), String(result._id));
  draft.save = actualSave;
});

test('draft updates preserve publication identity/provenance and published drafts link to product edits', async () => {
  const { token, user } = await createAdmin(), draft = await draftFixture({ createdBy: user._id });
  const response = await request(`/api/admin/product-drafts/${draft._id}`, { method: 'PUT', token, body: {
    name: 'Reviewed rose saree', status: 'published', publishedProductId: String(new mongoose.Types.ObjectId()),
    sourceType: 'social-import', sourceUrl: 'https://example.test/forged', createdBy: String(new mongoose.Types.ObjectId()),
  } });
  assert.equal(response.status, 200);
  assert.equal(response.data.data.name, 'Reviewed rose saree');
  assert.equal(response.data.data.status, 'draft');
  assert.equal(response.data.data.sourceType, undefined);
  assert.equal(response.data.data.publishedProductId, undefined);
  assert.equal(String(response.data.data.createdBy), String(user._id));
  assert.equal((await publish(token, [String(draft._id)])).status, 200);
  const edit = await request(`/api/admin/product-drafts/${draft._id}`, { method: 'PUT', token, body: { name: 'Wrong editor' } });
  assert.equal(edit.status, 409);
  assert.match(edit.data.message, /published product/);
});

test('draft edits reject fractional stock and invalid prices without changing persisted fields', async () => {
  const { token } = await createAdmin(), draft = await draftFixture();
  for (const body of [{ stock: 1.5 }, { stock: -1 }, { price: 'not-a-number' }, { sellingPrice: -50 }]) {
    assert.equal((await request(`/api/admin/product-drafts/${draft._id}`, { method: 'PUT', token, body })).status, 400);
  }
  const saved = await ProductDraft.findById(draft._id);
  assert.equal(saved.stock, 4); assert.equal(saved.sellingPrice, 1299);
});

test('manual draft creation rejects malformed commercial and schedule values with clear validation errors', async () => {
  const { token } = await createAdmin();
  for (const body of [
    { stock: 1.5 }, { reorderQuantity: -1 }, { lowStockAlert: 2.2 }, { gstRate: 101 },
    { packageDimensions: { lengthCm: 1001 } }, { saleStartAt: '2030-02-02', saleEndAt: '2030-02-01' },
  ]) {
    const response = await request('/api/admin/product-drafts', { method: 'POST', token, body });
    assert.equal(response.status, 400, JSON.stringify({ body, response: response.data }));
  }
  assert.equal(await ProductDraft.countDocuments(), 0);
});

test('draft routes reject unauthorized edits and return errors for missing records', async () => {
  const { token } = await createAdmin(), customer = await createCustomer(), draft = await draftFixture();
  assert.equal((await request('/api/admin/product-drafts', { token: customer.token })).status, 403);
  assert.equal((await request(`/api/admin/product-drafts/${draft._id}`, { method: 'PUT', token: customer.token, body: { name: 'Unauthorized' } })).status, 403);
  assert.equal((await request('/api/admin/product-drafts/not-an-id', { token })).status, 400);
  assert.equal((await request(`/api/admin/product-drafts/${new mongoose.Types.ObjectId()}`, { method: 'DELETE', token })).status, 404);
  assert.equal((await request(`/api/admin/product-drafts/${draft._id}`, { method: 'DELETE', token })).status, 409);
  assert.equal((await request(`/api/admin/product-drafts/${draft._id}/archive`, { method: 'PATCH', token })).status, 200);
  assert.equal((await request(`/api/admin/product-drafts/${draft._id}`, { method: 'DELETE', token })).status, 400);
  assert.equal((await request(`/api/admin/product-drafts/${draft._id}?confirm=${encodeURIComponent(draft.name)}`, { method: 'DELETE', token })).status, 200);
  assert.equal(await ProductDraft.countDocuments(), 0);
});

test('draft revisions reject stale saves and preserve the newer editor values', async () => {
  const { token } = await createAdmin(), draft = await draftFixture();
  const first = await request(`/api/admin/product-drafts/${draft._id}`, { method: 'PUT', token, body: { name: 'First reviewed title', baseRevision: 0 } });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.data.revision, 1);
  const stale = await request(`/api/admin/product-drafts/${draft._id}`, { method: 'PUT', token, body: { name: 'Stale overwrite', baseRevision: 0 } });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.code, 'DRAFT_STALE');
  assert.equal((await ProductDraft.findById(draft._id)).name, 'First reviewed title');
});

test('draft list supports pagination, search, readiness metadata and archived isolation', async () => {
  const { token } = await createAdmin();
  const first = await draftFixture({ name: 'Ready rose saree', description: 'A complete product description for the store.', shippingWeightKg: 0.5, sku: 'READY-1' });
  await draftFixture({ name: '', slug: 'missing-details', category: undefined, images: [], price: 0, sellingPrice: 0, originalPrice: 0, stock: 0 });
  const archived = await draftFixture({ name: 'Archived saree' });
  archived.status = 'archived'; archived.archivedAt = new Date(); await archived.save();

  const active = await request('/api/admin/product-drafts?page=1&limit=1&status=active', { token });
  assert.equal(active.status, 200);
  assert.equal(active.data.data.length, 1);
  assert.equal(active.data.meta.total, 2);
  assert.equal(active.data.meta.totalPages, 2);
  assert.equal(active.data.meta.summary.archived, 1);
  assert.ok(active.data.meta.summary.incomplete >= 1);

  const searched = await request('/api/admin/product-drafts?q=Ready%20rose', { token });
  assert.equal(searched.data.data.length, 1);
  assert.equal(String(searched.data.data[0]._id), String(first._id));
  const archivedList = await request('/api/admin/product-drafts?status=archived', { token });
  assert.equal(archivedList.data.data.length, 1);
  assert.equal(archivedList.data.data[0].status, 'archived');
});

test('batch publish returns per-draft results and publishes valid drafts when another needs attention', async () => {
  const { token } = await createAdmin();
  const valid = await draftFixture({ name: 'Valid batch saree' });
  const invalid = await draftFixture({ name: '', slug: 'invalid-batch', category: undefined, images: [], sellingPrice: 0, price: 0, originalPrice: 0 });
  const response = await publish(token, [String(valid._id), String(invalid._id)]);
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.data.data.summary.published, 1);
  assert.equal(response.data.data.summary.failed, 1);
  assert.equal(response.data.data.results.length, 2);
  assert.equal(await Product.countDocuments({ sourceDraftId: valid._id }), 1);
  assert.equal(await Product.countDocuments({ sourceDraftId: invalid._id }), 0);
});

test('publication blocks archived categories and duplicate commercial identifiers', async () => {
  const { token } = await createAdmin();
  const first = await draftFixture({ name: 'Original catalog saree', sku: 'CATALOG-SKU-1' });
  assert.equal((await publish(token, [String(first._id)])).status, 200);

  const duplicate = await draftFixture({ name: 'Duplicate SKU saree', sku: 'CATALOG-SKU-1' });
  const duplicateResponse = await publish(token, [String(duplicate._id)]);
  assert.equal(duplicateResponse.status, 400);
  assert.match(duplicateResponse.data.message, /SKU.*already used/i);
  assert.equal(await Product.countDocuments({ sku: 'CATALOG-SKU-1' }), 1);

  const archivedCategory = await Category.create({ name: 'Old category', slug: 'old-category', isArchived: true, archivedAt: new Date() });
  const archivedDraft = await draftFixture({ name: 'Archived category product', category: archivedCategory._id });
  const archivedResponse = await publish(token, [String(archivedDraft._id)]);
  assert.equal(archivedResponse.status, 400);
  assert.match(archivedResponse.data.message, /archived category/i);
});
