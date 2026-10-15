const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const { startTestEnvironment, stopTestEnvironment, resetDatabase, getBaseUrl } = require('./helpers');
const { createAdmin, createCustomer } = require('./factories');
const { createUploadSeller } = require('./photoUploadFixtures');
test.before(startTestEnvironment); test.after(stopTestEnvironment); test.beforeEach(resetDatabase);
const cloud = require('./r2MediaFixture').r2MediaFixture(test);

test('public photos, evidence and grouped drafts accept large sources but save bounded WebP', async t => {
  const admin = await createAdmin(), customer = await createCustomer(), seller = await createUploadSeller();
  const pixels = Buffer.alloc(1200 * 1000 * 3); let seed = 71;
  for (let i = 0; i < pixels.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; pixels[i] = seed >>> 24; }
  const source = await sharp(pixels, { raw: { width: 1200, height: 1000, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
  assert.ok(source.length > 3 * 1024 * 1024);
  const stored = [];
  t.after(async () => { await Promise.all(stored.map(name => fs.unlink(path.join(__dirname, '../uploads', name)).catch(() => {}))); });
  for (const route of [
    { path: '/api/admin/uploads?folder=banners', token: admin.token, field: 'images' },
    { path: '/api/seller/uploads?folder=categories', token: seller.token, field: 'images', headers: { 'x-store-id': seller.store.id } },
    { path: '/api/reviews/uploads', token: customer.token, field: 'images' },
    { path: '/api/returns/uploads', token: customer.token, field: 'images' },
    { path: '/api/returns/evidence/uploads', token: customer.token, field: 'files' },
    { path: '/api/admin/orders/evidence/uploads', token: admin.token, field: 'files' },
    { path: '/api/admin/product-drafts/bulk-upload', token: admin.token, field: 'images', draft: true },
  ]) {
    const form = new FormData(); form.append(route.field, new Blob([source], { type: 'image/png' }), 'detailed-bridal.png');
    if (route.draft) form.append('groupMode', 'single');
    const response = await fetch(getBaseUrl() + route.path, { method: 'POST', headers: { Authorization: `Bearer ${route.token}`, ...route.headers }, body: form });
    const data = await response.json(); assert.equal(response.status, 201, route.path + ': ' + JSON.stringify(data));
    const file = route.draft ? { url: data.data.drafts[0].image } : data.files[0];
    const url = file.url || file.fileUrl;
    const privateFile = file.provider === 'private';
    const name = path.basename(new URL(url, getBaseUrl()).pathname); if (!privateFile) assert.ok(url.startsWith(cloud.url + '/'));
    const download = await fetch(new URL(url, getBaseUrl()), privateFile ? { headers: { Authorization: 'Bearer ' + route.token } } : {});
    assert.equal(download.status, 200); const bytes = Buffer.from(await download.arrayBuffer());
    assert.ok(bytes.length <= source.length, route.path);
    assert.ok(bytes.length <= 220 * 1024, route.path);
    assert.equal((await sharp(bytes).metadata()).format, 'webp');
    if (!route.draft) { assert.equal(file.mimeType, 'image/webp'); assert.equal(file.sizeBytes, bytes.length); }
    const downloaded = await fetch(new URL(url, getBaseUrl()), privateFile ? { headers: { Authorization: 'Bearer ' + route.token } } : {});
    assert.equal(downloaded.status, 200); assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
  }
});
