const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { startTestEnvironment, stopTestEnvironment, resetDatabase, request } = require('./helpers');
const { createUploadSeller } = require('./photoUploadFixtures');
const { getIndustryPreset } = require('../config/industryPresets');
const Category = require('../models/Category');
const Product = require('../models/Product');
const Rental = require('../models/Rental');

before(async () => {
  mock.method(require('../services/controlPlaneClient'), 'licenseStatus', async () => ({ managed: false, status: 'ACTIVE' }));
  await startTestEnvironment();
});
after(async () => { await stopTestEnvironment(); mock.restoreAll(); });
beforeEach(resetDatabase);

async function fixture() {
  const { store, token } = await createUploadSeller('Optional sizing bridal shop');
  const structure = JSON.parse(JSON.stringify(getIndustryPreset('boutique')));
  structure.features.sizing = false;
  structure.attributes = structure.attributes.map(attribute => attribute.key === 'size' ? { ...attribute, required: true } : attribute);
  store.catalogStructure = structure; await store.save();
  const category = await Category.create({ storeId: store._id, name: 'Lehengas', slug: 'optional-lehengas' });
  const headers = { 'x-store-id': String(store._id) };
  const body = { name: 'Wine bridal lehenga', sku: 'OPTIONAL-SIZE', category: String(category._id), price: 4500, sellingPrice: 4500, originalPrice: 6000, stock: 2,
    images: [{ url: '/uploads/optional.webp', primary: true }], description: 'Wine bridal lehenga with visible gold floral embroidery.', commerceMode: 'SALE_ONLY',
    sizingMode: 'sized', sizes: [], sizeChart: { unit: 'in', rows: [] }, attributeValues: {} };
  return { token, headers, body, store };
}

test('blank sizes save as Free Size even when selectable mode and a required custom size definition exist', async () => {
  const { token, headers, body } = await fixture();
  const created = await request('/api/seller/products', { method: 'POST', token, headers, body });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const stored = await Product.findById(created.data._id);
  assert.equal(stored.sizingMode, 'free-size'); assert.equal(stored.stock, 2);
  assert.deepEqual(stored.sizes, []); assert.equal(stored.sizeChart.rows.length, 0);
});

test('manually entered sizes survive create and partial updates when automatic shop sizing is disabled', async () => {
  const { token, headers, body } = await fixture();
  const created = await request('/api/seller/products', { method: 'POST', token, headers, body: { ...body, sizes: ['M'], sizeChart: { unit: 'in', rows: [{ size: 'M', waist: 30, hips: 40, bottomLength: 42 }] } } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.sizingMode, 'sized'); assert.deepEqual(created.data.sizes, ['M']);
  const updated = await request(`/api/seller/products/${created.data._id}`, { method: 'PUT', token, headers, body: { price: 4800 } });
  assert.equal(updated.status, 200, JSON.stringify(updated.data));
  const stored = await Product.findById(created.data._id);
  assert.equal(stored.sizingMode, 'sized'); assert.deepEqual(stored.sizes, ['M']);
  assert.equal(stored.sizeChart.rows[0].waist, 30); assert.equal(stored.stock, 2);
});

test('sale + rental drafts publish without size labels and preserve both prices and the deposit', async () => {
  const { token, headers, body } = await fixture();
  const rentalPricing = { dailyRatePaise: 50000, depositPaise: 100000, advanceMode: 'PERCENT', advancePercent: 25 };
  const created = await request('/api/seller/product-drafts', { method: 'POST', token, headers, body: { ...body, commerceMode: 'SALE_AND_RENTAL', rentalPricing } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const id = created.data.data._id || created.data.data.id;
  const published = await request('/api/seller/product-drafts/publish-selected', { method: 'POST', token, headers, body: { ids: [id] } });
  assert.equal(published.status, 200, JSON.stringify(published.data));
  const stored = await Product.findOne({ sourceDraftId: id });
  assert.ok(stored); assert.equal(stored.commerceMode, 'SALE_AND_RENTAL'); assert.equal(stored.price, 4500);
  assert.equal(stored.sizingMode, 'free-size'); assert.deepEqual(stored.sizes, []);
  const offer = await Rental.Listing.findOne({ productId: stored._id });
  assert.ok(offer); assert.equal(offer.dailyRatePaise, 50000); assert.equal(offer.depositPaise, 100000); assert.equal(offer.advancePercent, 25);
});
