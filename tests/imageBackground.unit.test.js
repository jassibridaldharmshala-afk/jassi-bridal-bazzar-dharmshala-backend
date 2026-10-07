const test = require('node:test');
const assert = require('node:assert/strict');
const background = require('../services/imageBackgroundService');
const { normalizeProductPayload, sanitizeProductImages, normalizeProductImages } = require('../utils/imageUtils');
const Product = require('../models/Product');
const Draft = require('../models/ProductDraft');
const image = { url: '/uploads/edited.webp', publicId: 'edited', primary: true, background: { original: { url: '/uploads/original.webp', publicId: 'original' }, edited: { url: '/uploads/edited.webp', publicId: 'edited' }, preset: 'white' } };

test('product and draft persistence retain original, edit and preset through normalization', () => {
  const normalized = normalizeProductPayload({ images: [image] });
  for (const Model of [Product, Draft]) assert.deepEqual(new Model(normalized).toObject().images[0].background, image.background);
  const req = { protocol: 'http', get: () => 'localhost:5000' };
  const response = normalizeProductImages(normalized, req);
  assert.equal(response.images[0].background.original.url, 'http://localhost:5000/uploads/original.webp');
  assert.deepEqual(sanitizeProductImages(response.images)[0].background, image.background);
});
test('unsafe background URLs and unknown presets fail model validation', () => {
  const item = structuredClone(image); item.background.original.url = 'data:image/png;base64,a'; item.background.preset = 'arbitrary';
  const error = new Product({ images: [item] }).validateSync();
  assert.ok(error.errors['images.0.background.original.url']); assert.ok(error.errors['images.0.background.preset']);
});
test('worker communication forwards bytes securely and rejects invalid responses without exposing credentials', async (t) => {
  const previous = { url: process.env.AI_VIDEO_WORKER_URL, token: process.env.AI_VIDEO_WORKER_SERVICE_TOKEN };
  process.env.AI_VIDEO_WORKER_URL = 'https://worker.example'; process.env.AI_VIDEO_WORKER_SERVICE_TOKEN = 'test-worker-token';
  t.after(() => { for (const [key, value] of Object.entries({ AI_VIDEO_WORKER_URL: previous.url, AI_VIDEO_WORKER_SERVICE_TOKEN: previous.token })) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const result = await background.removeBackground(Buffer.from('source'), async (url, options) => {
    assert.equal(url, 'https://worker.example/internal/images/remove-background');
    assert.equal(options.headers.authorization, 'Bearer test-worker-token');
    assert.equal(options.redirect, 'error'); assert.equal(options.body.toString(), 'source');
    return new Response(png, { headers: { 'content-type': 'image/png' } });
  });
  assert.equal(result.image, `data:image/png;base64,${png.toString('base64')}`);
  await assert.rejects(background.removeBackground(png, async () => new Response('test-worker-token', { status: 401 })), error => error.errorCode === 'BACKGROUND_PROCESSING_FAILED' && !error.message.includes('test-worker-token'));
  await assert.rejects(background.removeBackground(png, async () => new Response('not png', { headers: { 'content-type': 'image/png' } })), { errorCode: 'BACKGROUND_PROCESSING_FAILED' });
});
