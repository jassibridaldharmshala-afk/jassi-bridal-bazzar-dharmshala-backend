const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createAdmin, createCustomer, createProduct } = require('./factories');
const Product = require('../models/Product');
const ProductDraft = require('../models/ProductDraft');
const DeletedProductDraft = require('../models/DeletedProductDraft');
const Cart = require('../models/Cart');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const InventoryTransaction = require('../models/InventoryTransaction');
const Store = require('../models/Store');
const StoreMember = require('../models/StoreMember');
const SocialImport = require('../models/SocialProductImport');
const { recordOpeningInventory } = require('../services/inventoryService');
const { publishPreparedDraft } = require('../controllers/productDraftController');

test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(resetDatabase);
const path = product => `/api/admin/products/${product._id}`;
const preview = async (token, product) => (await request(`${path(product)}/deletion-preview`, { token })).data;
const remove = (token, product, review, body = {}) => request(`${path(product)}/permanent`, { method: 'DELETE', token, body: { confirm: product.name, version: review.version, ...body } });

test('permanent deletion requires archive, exact confirmation and a fresh review', async () => {
  const { token } = await createAdmin();
  const product = await createProduct();
  const active = await preview(token, product);
  assert.equal(active.eligible, false);
  assert.equal((await remove(token, product, active)).status, 409);
  assert.equal((await request(path(product), { method: 'DELETE', token })).status, 200);
  assert.ok(await Product.findById(product._id), 'existing DELETE remains archive');
  const review = await preview(token, product);
  assert.equal(review.eligible, true);
  assert.equal((await remove(token, product, review, { confirm: 'wrong' })).status, 400);
  assert.equal((await remove(token, product, review, { version: active.version })).status, 409);
  await Product.updateOne({ _id: product._id }, { $set: { name: 'Revised product' } });
  assert.equal((await remove(token, { ...product.toObject(), name: 'Revised product' }, review)).status, 409);
  assert.ok(await Product.findById(product._id));
});

test('unused product deletion cleans shopping references but retains readable opening ledger and audit', async () => {
  const { token } = await createAdmin();
  const { user } = await createCustomer();
  const product = await createProduct({ isArchived: true, isActive: false, sku: 'DELETE-OPENING' });
  const other = await createProduct({ completeLookProductIds: [product._id] });
  const draft = await ProductDraft.create({ name: 'Related draft', completeLookProductIds: [product._id] });
  await recordOpeningInventory(product);
  await Cart.create({ user: user._id, items: [{ product: product._id, quantity: 1 }, { product: other._id, quantity: 2 }] });
  await User.updateOne({ _id: user._id }, { $set: { wishlist: [product._id, other._id] } });
  const review = await preview(token, product);
  assert.equal(review.eligible, true, JSON.stringify(review));
  assert.equal(review.cleanup.carts, 1);
  const deleted = await remove(token, product, review);
  assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
  assert.equal(await Product.findById(product._id), null);
  assert.equal((await Cart.findOne({ user: user._id })).items.length, 1);
  assert.deepEqual((await User.findById(user._id)).wishlist.map(String), [String(other._id)]);
  assert.equal((await Product.findById(other._id)).completeLookProductIds.length, 0);
  assert.equal((await ProductDraft.findById(draft._id)).completeLookProductIds.length, 0);
  const ledger = await InventoryTransaction.findOne({ product: product._id });
  assert.equal(ledger.productSnapshot.name, product.name);
  assert.ok(ledger.productSnapshot.deletedAt);
  assert.equal(await AuditLog.countDocuments({ action: 'PRODUCT_PERMANENT_DELETE', entityId: String(product._id) }), 1);
  assert.equal((await remove(token, product, review)).status, 404);
  assert.equal((await request(`/api/products/${product._id}`)).status, 404);
});

test('every historical or merchandising dependency blocks deletion, including legacy and nested references', async () => {
  const { token } = await createAdmin();
  const product = await createProduct({ isArchived: true, isActive: false });
  const references = [
    ['Order', { orderItems: [{ product: product._id }] }, 'orders'],
    ['ReturnExchange', { product: product._id }, 'returns'],
    ['InventoryPurchaseOrder', { items: [{ product: product._id }] }, 'purchases'],
    ['InventoryTransaction', { product: product._id, type: 'SALE', quantity: -1 }, 'inventory'],
    ['InventoryItem', { product: product._id }, 'pieces'],
    ['Review', { product: product._id }, 'reviews'],
    ['RentalListing', { requirements: [{ productId: product._id }] }, 'rentalListings'],
    ['RentalAsset', { productId: product._id }, 'rentalAssets'],
    ['RentalBooking', { allocations: [{ binding: { productId: product._id } }] }, 'rentals'],
    ['VariantGroup', { members: [{ product: product._id }] }, 'groups'],
    ['Coupon', { applicableProducts: [product._id] }, 'coupons'],
    ['Campaign', { offer: { applicableProducts: [product._id] } }, 'campaigns'],
    ['Banner', { destinationType: 'PRODUCT', destinationValue: String(product._id) }, 'banners'],
    ['WebsiteTheme', { draftConfig: { homepage: { blocks: [{ productIds: [String(product._id)] }] } } }, 'themeSelections'],
  ];
  const cleanReview = await preview(token, product);
  for (const [name, document, key] of references) {
    const Model = mongoose.model(name);
    const created = await Model.collection.insertOne(document);
    const review = await preview(token, product);
    assert.ok(review.blockers.some(item => item.key === key), `${name} must block`);
    // A dependency appearing AFTER preview is also checked at commit time.
    const result = await remove(token, product, cleanReview);
    assert.equal(result.status, 409, `${name}: ${JSON.stringify(result.data)}`);
    assert.equal(result.data.code, 'PRODUCT_DELETE_BLOCKED');
    assert.ok(await Product.findById(product._id));
    await Model.collection.deleteOne({ _id: created.insertedId });
  }
});

test('deletion rolls back product, shopping cleanup and ledger snapshot if audit persistence fails', async () => {
  const { token } = await createAdmin();
  const { user } = await createCustomer();
  const product = await createProduct({ isArchived: true, isActive: false });
  await Cart.create({ user: user._id, items: [{ product: product._id }] });
  await recordOpeningInventory(product);
  const review = await preview(token, product);
  const original = AuditLog.create;
  AuditLog.create = async () => { throw new Error('Synthetic audit failure'); };
  try { assert.equal((await remove(token, product, review)).status, 500); }
  finally { AuditLog.create = original; }
  assert.ok(await Product.findById(product._id));
  assert.equal((await Cart.findOne({ user: user._id })).items.length, 1);
  assert.equal((await InventoryTransaction.findOne({ product: product._id })).productSnapshot?.deletedAt, undefined);
});

test('concurrent duplicate deletion has one winner and one audit event', async () => {
  const { token } = await createAdmin();
  const product = await createProduct({ isArchived: true, isActive: false });
  const review = await preview(token, product);
  const results = await Promise.all([remove(token, product, review), remove(token, product, review)]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 404]);
  assert.equal(await AuditLog.countDocuments({ action: 'PRODUCT_PERMANENT_DELETE' }), 1);
});

test('customer and seller store/role guards protect preview and deletion', async () => {
  const customer = await createCustomer();
  const product = await createProduct({ isArchived: true, isActive: false });
  assert.equal((await request(`${path(product)}/deletion-preview`, { token: customer.token })).status, 403);
  assert.equal((await remove(customer.token, product, { version: 'x' })).status, 403);
  const store = await Store.create({ name: 'Delete scope', slug: 'delete-scope', owner: customer.user._id });
  await StoreMember.create({ store: store._id, user: customer.user._id, role: 'OWNER', status: 'ACTIVE' });
  const headers = { 'x-store-id': String(store._id) };
  const foreign = `/api/seller/products/${product._id}`;
  assert.equal((await request(`${foreign}/deletion-preview`, { token: customer.token, headers })).status, 404);
  assert.equal((await request(`${foreign}/permanent`, { method: 'DELETE', token: customer.token, headers, body: { confirm: product.name, version: 'x' } })).status, 404);
  const own = await createProduct({ storeId: store._id, isArchived: true, isActive: false });
  const ownPath = `/api/seller/products/${own._id}`;
  assert.equal((await request(`${ownPath}/deletion-preview`, { token: customer.token, headers })).status, 200);
  await StoreMember.updateOne({ store: store._id }, { $set: { role: 'ORDER_MANAGER' } });
  assert.equal((await request(`${ownPath}/deletion-preview`, { token: customer.token, headers })).status, 403);
});

test('published drafts leave the default queue and can be removed without changing the product', async () => {
  const { token, user } = await createAdmin();
  const product = await createProduct();
  const draft = await ProductDraft.create({ name: product.name, createdBy: user._id, sourceType: 'manual', status: 'published', publishedProductId: product._id, images: product.images });
  await ProductDraft.create({ name: 'Unpublished work' });
  const active = await request('/api/admin/product-drafts', { token });
  assert.equal(active.data.data.length, 1);
  assert.equal(active.data.data[0].status, 'draft');
  assert.equal(active.data.meta.summary.published, 1);
  assert.equal((await request('/api/admin/product-drafts?status=published', { token })).data.data.length, 1);
  assert.equal((await request(`/api/admin/product-drafts/${draft._id}`, { method: 'DELETE', token })).status, 400);
  const before = (await Product.findById(product._id)).toObject();
  const removed = await request(`/api/admin/product-drafts/${draft._id}?confirm=${encodeURIComponent(draft.name)}`, { method: 'DELETE', token });
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  assert.equal(await ProductDraft.findById(draft._id), null);
  assert.deepEqual((await Product.findById(product._id)).toObject(), before);
  assert.equal(String((await DeletedProductDraft.findOne({ draftId: draft._id })).productId), String(product._id));
});

test('removed social draft cannot be recreated or republished by its source import', async () => {
  const { token, user } = await createAdmin();
  await request('/api/catalog-configuration');
  const store = await Store.findOne({ isDefault: true });
  const product = await createProduct({ storeId: store._id });
  const job = await SocialImport.create({ createdBy: user._id, storeId: store._id, sourceUrl: 'https://www.instagram.com/p/DeletedDraftTest/', sourceKey: 'deleted-social-source', platform: 'instagram', status: 'ready' });
  const draft = await ProductDraft.create({ name: product.name, status: 'published', publishedProductId: product._id, sourceType: 'social-import', sourceSocialImportId: job._id, storeId: store._id });
  job.draftId = draft._id; await job.save();
  assert.equal((await request(`/api/admin/product-drafts/${draft._id}?confirm=${encodeURIComponent(draft.name)}`, { method: 'DELETE', token })).status, 200);
  const detail = await request(`/api/admin/social-imports/${job._id}`, { token });
  assert.equal(detail.status, 200, JSON.stringify(detail.data));
  assert.equal(detail.data.data.publishedProductId, String(product._id));
  assert.equal(detail.data.data.draftId, undefined);
  assert.equal((await request(`/api/admin/social-imports/${job._id}/draft`, { method: 'POST', token, body: {} })).status, 409);
  const republish = await request(`/api/admin/social-imports/${job._id}/publish`, { method: 'POST', token, body: {} });
  assert.equal(republish.status, 200, JSON.stringify(republish.data));
  assert.equal(republish.data.productId, String(product._id));
  assert.equal(await Product.countDocuments(), 1);
  assert.equal(await ProductDraft.countDocuments(), 0);
});

test('stale publication cannot recreate a deleted draft and an in-flight publisher blocks archive/delete', async () => {
  const { token } = await createAdmin();
  const draft = await ProductDraft.create({ name: 'Removed before publication', status: 'archived' });
  await request(`/api/admin/product-drafts/${draft._id}?confirm=${encodeURIComponent(draft.name)}`, { method: 'DELETE', token });
  await assert.rejects(publishPreparedDraft(draft), /removed/);
  assert.equal(await Product.countDocuments(), 0);
  const locked = await ProductDraft.create({ name: 'Publishing now', status: 'draft', publishingToken: 'in-flight' });
  assert.equal((await request(`/api/admin/product-drafts/${locked._id}/archive`, { method: 'PATCH', token })).status, 409);
  assert.equal((await request(`/api/admin/product-drafts/${locked._id}`, { method: 'PUT', token, body: { name: 'Unsafe rename' } })).status, 409);
});

test('transaction-unavailable deployment fails closed without mutating catalog or carts', async () => {
  const { token } = await createAdmin();
  const product = await createProduct({ isArchived: true, isActive: false });
  const { resetTransactionSupportCache } = require('../utils/transaction');
  const originalAdmin = mongoose.connection.db.admin;
  mongoose.connection.db.admin = () => ({ command: async () => ({ ok: 1 }) });
  resetTransactionSupportCache();
  try {
    const review = await preview(token, product);
    assert.equal(review.transactions, false);
    assert.equal(review.eligible, false);
    assert.equal((await remove(token, product, review)).status, 503);
    assert.ok(await Product.findById(product._id));
  } finally { mongoose.connection.db.admin = originalAdmin; resetTransactionSupportCache(); }
});

test('damaged/quarantined stock and stale draft revisions cannot be discarded', async () => {
  const { token } = await createAdmin();
  const product = await createProduct({ isArchived: true, isActive: false, nonSellableStock: { damaged: 1, quarantine: 2 } });
  const review = await preview(token, product);
  assert.equal(review.eligible, false);
  assert.equal(review.blockers.find(item => item.key === 'nonSellable').count, 3);
  const draft = await ProductDraft.create({ name: 'Revised archived draft', status: 'archived', revision: 4 });
  const result = await request(`/api/admin/product-drafts/${draft._id}?confirm=${encodeURIComponent(draft.name)}&baseRevision=3`, { method: 'DELETE', token });
  assert.equal(result.status, 409);
  assert.ok(await ProductDraft.findById(draft._id));
});

test('a removed published reel draft remains linked to its product and cannot be rebuilt', async () => {
  const { token, user } = await createAdmin();
  const product = await createProduct();
  const savedJob = await mongoose.model('ReelImport').create({ createdBy: user._id, status: 'completed', sourceVideo: {
    provider: 'r2', storageKey: 'test-receipt-source', originalFilename: 'test-receipt.mp4', mimeType: 'video/mp4', sizeBytes: 1, durationSeconds: 1,
  } });
  const job = { insertedId: savedJob._id };
  const candidate = await mongoose.model('ReelCandidate').create({ job: job.insertedId, groupNumber: 1, status: 'draft_created' });
  const draft = await ProductDraft.create({ name: product.name, status: 'published', publishedProductId: product._id, sourceCandidateId: candidate._id });
  candidate.productDraft = draft._id; await candidate.save();
  assert.equal((await request(`/api/admin/product-drafts/${draft._id}?confirm=${encodeURIComponent(draft.name)}`, { method: 'DELETE', token })).status, 200);
  const listed = await request(`/api/admin/reel-imports/${job.insertedId}/candidates`, { token });
  assert.equal(listed.status, 200);
  assert.equal(listed.data.data[0].savedDraft.publishedProductId, String(product._id));
  const edited = await request(`/api/admin/reel-imports/${job.insertedId}/candidates/${candidate._id}`, { method: 'PATCH', token, body: { adminOverrides: { name: 'Duplicate attempt' } } });
  assert.equal(edited.status, 409);
  const rebuilt = await request(`/api/admin/reel-imports/${job.insertedId}/create-drafts`, { method: 'POST', token, body: { candidateIds: [String(candidate._id)] } });
  assert.equal(rebuilt.status, 400, JSON.stringify(rebuilt.data));
  assert.equal(await Product.countDocuments(), 1);
  assert.equal(await ProductDraft.countDocuments(), 0);
});
