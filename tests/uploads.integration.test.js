const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { request, resetDatabase, startTestEnvironment, stopTestEnvironment, getBaseUrl } = require('./helpers');
const { createAdmin, createCustomer } = require('./factories');
const { createProvisionedSeller } = require('./accessFixtures');

test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(resetDatabase);

async function upload(route, field, bytes, type, name, token, headers = {}) {
  const body = new FormData();
  body.append(field, new Blob([bytes], { type }), name);
  const response = await fetch(`${getBaseUrl()}${route}`, { method: 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body });
  return { status: response.status, data: await response.json() };
}

test('upload access requires an authenticated admin or store member even with a forged local Host', async (t) => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  t.after(() => { process.env.NODE_ENV = previous; });
  for (const host of ['localhost', '127.0.0.1', 'localhost.attacker.test']) {
    for (const route of ['/api/admin/uploads', '/api/admin/uploads/videos', '/api/admin/upload']) {
      const response = await request(route, { method: 'POST', body: {}, headers: { Host: host } });
      assert.equal(response.status, 401, `${route} must not trust Host=${host}`);
    }
  }
  const customer = await createCustomer();
  assert.equal((await request('/api/admin/uploads', { method: 'POST', token: customer.token, body: {}, headers: { Host: 'localhost' } })).status, 403);
});

test('admin and seller multipart uploads retain playable media and provide retrievable public file URLs', async (t) => {
  const admin = await createAdmin(), seller = await createProvisionedSeller('Upload Fixture Store');
  const marker = `qa-upload-${crypto.randomUUID()}`;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'samira-upload-test-'));
  const videoPath = path.join(directory, `${marker}.mp4`);
  const uploadedPaths = [];
  t.after(async () => {
    await Promise.all(uploadedPaths.map(file => fs.unlink(file).catch(() => null)));
    await fs.unlink(videoPath).catch(() => null);
    await fs.rmdir(directory).catch(() => null);
  });
  const generated = spawnSync(require('ffmpeg-static'), ['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=white:s=160x240:d=0.2','-pix_fmt','yuv420p',videoPath], { windowsHide: true, encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  const video = await fs.readFile(videoPath);
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  for (const actor of [{ route: '/api/admin/uploads', token: admin.token, headers: {} }, { route: '/api/seller/uploads', token: seller.token, headers: { 'x-store-id': seller.store.id } }]) {
    for (const media of [{ suffix: '', field: 'images', bytes: image, type: 'image/png', extension: 'png' }, { suffix: '/videos', field: 'videos', bytes: video, type: 'video/mp4', extension: 'mp4' }]) {
      const result = await upload(`${actor.route}${media.suffix}`, media.field, media.bytes, media.type, `${marker}.${media.extension}`, actor.token, actor.headers);
      assert.equal(result.status, 201, JSON.stringify(result.data));
      assert.equal(result.data.files.length, 1);
      assert.equal(result.data.provider, 'local');
      const file = result.data.files[0];
      assert.equal(file.mimeType, media.type);
      assert.equal(file.sizeBytes, media.bytes.length);
      const resolved = path.resolve(__dirname, '..', 'uploads', path.basename(file.url));
      assert.equal(resolved.startsWith(path.resolve(__dirname, '..', 'uploads') + path.sep), true);
      assert.equal(path.basename(resolved).includes(marker), true);
      uploadedPaths.push(resolved);
      assert.deepEqual(await fs.readFile(resolved), media.bytes);
      const download = await fetch(`${getBaseUrl()}${file.url}`);
      assert.equal(download.status, 200);
      assert.deepEqual(Buffer.from(await download.arrayBuffer()), media.bytes);
    }
  }
});

test('invalid media and missing files are explained as validation errors without a server failure', async () => {
  const admin = await createAdmin();
  const video = await upload('/api/admin/uploads/videos', 'videos', Buffer.from('not-video'), 'text/plain', 'invalid.txt', admin.token);
  assert.equal(video.status, 400);
  assert.equal(video.data.code, 'VALIDATION_ERROR');
  assert.match(video.data.message, /mp4|webm|mov/i);
  const image = await upload('/api/admin/uploads', 'images', Buffer.from('not-image'), 'text/plain', 'invalid.txt', admin.token);
  assert.equal(image.status, 400);
  assert.equal((await request('/api/admin/uploads', { method: 'POST', token: admin.token, body: {} })).status, 400);
});

test('review and return evidence photos require customer authentication and valid image bytes', async (t) => {
  const customer = await createCustomer();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const unauthenticated = await upload('/api/reviews/uploads', 'images', png, 'image/png', 'review.png');
  assert.equal(unauthenticated.status, 401);
  const spoofed = await upload('/api/reviews/uploads', 'images', Buffer.from('not-an-image'), 'image/png', 'spoofed.png', customer.token);
  assert.equal(spoofed.status, 400);
  assert.match(spoofed.data.message, /valid JPG, PNG, or WEBP/i);
  const valid = await upload('/api/reviews/uploads', 'images', png, 'image/png', 'customer-review.png', customer.token);
  assert.equal(valid.status, 201, JSON.stringify(valid.data));
  assert.equal(valid.data.files.length, 1);
  const stored = path.resolve(__dirname, '..', 'uploads', path.basename(valid.data.files[0].url));
  t.after(() => fs.unlink(stored).catch(() => null));
  assert.deepEqual(await fs.readFile(stored), png);
  const returnUnauthenticated = await upload('/api/returns/uploads', 'images', png, 'image/png', 'return.png');
  assert.equal(returnUnauthenticated.status, 401);
  const returnSpoofed = await upload('/api/returns/uploads', 'images', Buffer.from('not-an-image'), 'image/png', 'spoofed-return.png', customer.token);
  assert.equal(returnSpoofed.status, 400);
  const returnValid = await upload('/api/returns/uploads', 'images', png, 'image/png', 'customer-return.png', customer.token);
  assert.equal(returnValid.status, 201, JSON.stringify(returnValid.data));
  assert.equal(returnValid.data.files.length, 1);
  const returnStored = path.resolve(__dirname, '..', 'uploads', path.basename(returnValid.data.files[0].url));
  t.after(() => fs.unlink(returnStored).catch(() => null));
  assert.deepEqual(await fs.readFile(returnStored), png);
});

test('bulk-uploaded draft photos remain available through editing and publication with local storage', async (t) => {
  const admin = await createAdmin();
  const marker = `qa-bulk-${crypto.randomUUID()}`;
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const result = await upload('/api/admin/product-drafts/bulk-upload', 'images', image, 'image/png', `${marker}.png`, admin.token);
  assert.equal(result.status, 201, JSON.stringify(result.data));
  const draft = result.data.data.drafts[0];
  const filePath = path.resolve(__dirname, '..', 'uploads', path.basename(new URL(draft.image, getBaseUrl()).pathname));
  assert.equal(path.basename(filePath).includes(marker), true);
  t.after(() => fs.unlink(filePath).catch(() => null));
  assert.deepEqual(await fs.readFile(filePath), image, 'the draft photo must not be deleted as a temporary upload');
  assert.equal((await request('/api/admin/product-drafts', { token: admin.token })).data.data.length, 1);
  assert.equal((await request(`/api/admin/product-drafts/${draft._id}`, { token: admin.token })).data.data.image, draft.image);
  const category = await require('../models/Category').create({ name: 'Sarees', slug: 'bulk-sarees' });
  const edited = await request(`/api/admin/product-drafts/${draft._id}`, { method: 'PUT', token: admin.token, body: { name: 'Rose Silk Saree', category: String(category._id), price: 799, sellingPrice: 799, originalPrice: 999, stock: 4, sizingMode: 'free-size', colors: ['Rose'] } });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  const published = await request('/api/admin/product-drafts/publish-selected', { method: 'POST', token: admin.token, body: { ids: [draft._id] } });
  assert.equal(published.status, 200, JSON.stringify(published.data));
  assert.equal(published.data.data.products[0].name, 'Rose Silk Saree');
  const served = await fetch(`${getBaseUrl()}${new URL(draft.image, getBaseUrl()).pathname}`);
  assert.equal(served.status, 200);
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), image);
});

test('quick photo analysis sends the actual uploaded image, maps categories and leaves commercial fields manual', async (t) => {
  const admin = await createAdmin(), seller = await createProvisionedSeller('Photo Analysis Store');
  assert.equal((await request('/api/admin/products/quick-analyze/status', { token: admin.token })).data.enabled, false);
  const unavailable = await request('/api/admin/products/quick-analyze', { method: 'POST', token: admin.token, body: {} });
  assert.equal(unavailable.status, 200); assert.equal(unavailable.data.enabled, false);
  process.env.GEMINI_API_KEY = 'isolated-photo-analysis-fixture';
  t.after(() => { delete process.env.GEMINI_API_KEY; });
  const marker = `qa-analysis-${crypto.randomUUID()}.png`;
  const filePath = path.join(__dirname, '..', 'uploads', marker);
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  await fs.writeFile(filePath, image);
  t.after(() => fs.unlink(filePath).catch(() => null));
  const originalFetch = global.fetch;
  let providerCalls = 0, quotaExceeded = false;
  t.mock.method(global, 'fetch', async (url, options) => {
    const parsed = new URL(url);
    if (parsed.hostname === '127.0.0.1') return originalFetch(url, options);
    assert.equal(parsed.hostname, 'generativelanguage.googleapis.com');
    providerCalls += 1;
    const sent = JSON.parse(options.body);
    assert.equal(sent.contents[0].parts[1].inlineData.data, image.toString('base64'));
    if (quotaExceeded) return { ok: false, status: 429, json: async () => ({ error: { message: 'Fixture quota exhausted' } }) };
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ name: 'Rose Floral Saree', categoryName: 'Sarees', colors: ['Rose'], pattern: 'Floral', fabric: 'Silk', tags: ['Saree','Floral'], description: 'Rose floral saree.', price: 999, stock: 25, confidence: { overall: 0.9 } }) }] } }] }) };
  });
  const categories = [{ _id: '0123456789abcdef01234567', name: 'Sarees' }];
  for (const actor of [{ prefix: '/api/admin', token: admin.token }, { prefix: '/api/seller', token: seller.token, headers: { 'x-store-id': seller.store.id } }]) {
    assert.equal((await request(`${actor.prefix}/products/quick-analyze/status`, actor)).data.enabled, true);
    const result = await request(`${actor.prefix}/products/quick-analyze`, { ...actor, method: 'POST', body: { imageUrl: `/uploads/${marker}`, categories } });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.suggestion.name, 'Rose Floral Saree');
    assert.equal(result.data.suggestion.categoryId, categories[0]._id);
    assert.equal(result.data.suggestion.sizingMode, 'free-size');
    assert.equal(result.data.suggestion.price, undefined); assert.equal(result.data.suggestion.stock, undefined);
  }
  assert.equal(providerCalls, 2);
  quotaExceeded = true;
  const failed = await request('/api/admin/products/quick-analyze', { method: 'POST', token: admin.token, body: { imageUrl: `/uploads/${marker}`, categories } });
  assert.equal(failed.status, 400);
  assert.match(failed.data.message, /quota/i);
  assert.equal(providerCalls, 3, 'quota failure must not repeatedly spend provider requests');
});
