const test = require('node:test');
const assert = require('node:assert/strict');
const { request, resetDatabase, startTestEnvironment, stopTestEnvironment, getBaseUrl } = require('./helpers');
const { createAdmin, createCustomer, createProduct } = require('./factories');
const { createProvisionedSeller } = require('./accessFixtures');
const background = require('../services/imageBackgroundService');
test.before(startTestEnvironment); test.after(stopTestEnvironment); test.beforeEach(resetDatabase);

test('background APIs require admin/store access and process previews without publishing images', async (t) => {
  const admin = await createAdmin(), customer = await createCustomer(), seller = await createProvisionedSeller('Background Store');
  for (const suffix of ['', '/stored']) {
    assert.equal((await request(`/api/admin/uploads/background${suffix}`, { method: 'POST', body: {} })).status, 401);
    assert.equal((await request(`/api/admin/uploads/background${suffix}`, { method: 'POST', token: customer.token, body: {} })).status, 403);
  }
  t.mock.method(background, 'isConfigured', () => true);
  assert.equal((await request('/api/admin/uploads/background', { token: admin.token })).data.available, true);
  let calls = 0;
  t.mock.method(background, 'removeBackground', async buffer => { calls++; assert.equal(buffer.toString(), 'photo'); return { image: 'data:image/png;base64,cGhvdG8=' }; });
  for (const [prefix, token, headers] of [['admin', admin.token, {}], ['seller', seller.token, { 'x-store-id': String(seller.store.id) }]]) {
    const body = new FormData(); body.append('image', new Blob(['photo'], { type: 'image/webp' }), 'photo.webp');
    const response = await fetch(`${getBaseUrl()}/api/${prefix}/uploads/background`, { method: 'POST', headers: { ...headers, authorization: `Bearer ${token}` }, body });
    assert.equal(response.status, 200, await response.clone().text());
    assert.ok((await response.json()).image.startsWith('data:image/png;'));
  }
  assert.equal(calls, 2);
  assert.equal(await require('../models/Product').countDocuments(), 0);
  const missing = await request('/api/admin/uploads/background', { method: 'POST', token: admin.token, body: {} });
  assert.equal(missing.status, 400);
});

test('product editing and restoration retain original storage asset and previous edit after reload', async (t) => {
  const admin = await createAdmin();
  const original = { url: 'https://media.example/products/original.webp', publicId: 'products/original.webp', primary: true };
  const product = await createProduct({ images: [original], sizes: [], sizingMode: 'free-size', sku: 'BACKGROUND-TEST', description: 'A product for background editing.' });
  const keys = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME', 'R2_PUBLIC_URL'];
  keys.forEach(key => { process.env[key] = key === 'R2_PUBLIC_URL' ? 'https://media.example' : 'isolated-background-test'; });
  t.after(() => keys.forEach(key => delete process.env[key]));
  const deleted = [];
  t.mock.method(require('../services/r2Upload').getR2Client(), 'send', async command => { deleted.push(command.input.Key); return {}; });
  const edited = { url: 'https://media.example/products/edited.webp', publicId: 'products/edited.webp', primary: true,
    background: { original: { url: original.url, publicId: original.publicId }, edited: { url: 'https://media.example/products/edited.webp', publicId: 'products/edited.webp' }, preset: 'beige' } };
  const saved = await request(`/api/admin/products/${product._id}`, { method: 'PUT', token: admin.token, body: { images: [edited] } });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const reloaded = await require('../models/Product').findById(product._id).lean();
  assert.deepEqual(reloaded.images[0].background, edited.background);
  assert.deepEqual(deleted, [], 'background edits must not delete original storage objects');
  const restored = await request(`/api/admin/products/${product._id}`, { method: 'PUT', token: admin.token, body: { images: [{ ...edited, url: original.url, publicId: original.publicId }] } });
  assert.equal(restored.status, 200, JSON.stringify(restored.data));
  const final = await require('../models/Product').findById(product._id).lean();
  assert.equal(final.images[0].url, original.url); assert.equal(final.images[0].background.edited.url, edited.url);
  assert.deepEqual(deleted, []);
});

test('draft publication keeps background metadata for later product editing', async () => {
  const admin = await createAdmin();
  const category = await require('../models/Category').create({ name: 'Sarees', slug: 'background-draft-sarees' });
  const image = { url: '/uploads/edited.webp', primary: true, background: {
    original: { url: '/uploads/original.webp' }, edited: { url: '/uploads/edited.webp' }, preset: 'transparent',
  } };
  const draft = await require('../models/ProductDraft').create({ name: 'Ivory silk saree', category: category._id, images: [image], price: 1299, sellingPrice: 1299, originalPrice: 1599, stock: 4, sizingMode: 'free-size' });
  const published = await request('/api/admin/product-drafts/publish-selected', { method: 'POST', token: admin.token, body: { ids: [String(draft._id)] } });
  assert.equal(published.status, 200, JSON.stringify(published.data));
  const product = await require('../models/Product').findOne({ sourceDraftId: draft._id }).lean();
  assert.deepEqual(product.images[0].background, image.background);
});

test('stored preview rejects arbitrary network URLs and local path traversal', async () => {
  const admin = await createAdmin();
  for (const url of ['http://169.254.169.254/metadata', 'https://untrusted.example/photo.png', '/uploads/../../.env']) {
    const result = await request('/api/admin/uploads/background/stored', { method: 'POST', token: admin.token, body: { url } });
    assert.equal(result.status, 400, JSON.stringify(result.data));
  }
});
