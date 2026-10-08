const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Category = require('../models/Category');
const context = require('../services/productImportContext.service');
const configuration = require('../services/masterConfigurationService');
const media = require('../services/productSmartFillMedia');

function fixture(t, analyze) {
  const find = t.mock.method(Category, 'find', () => ({ select: () => ({ limit: () => ({ lean: async () => [{ _id: 'bridal', name: 'Lehengas' }] }) }) }));
  const read = t.mock.method(configuration, 'readConfiguration', async () => ({ structure: { industry: 'boutique', features: { sizing: true }, attributes: [] } }));
  t.mock.method(context, 'enabled', () => true);
  const analysis = t.mock.method(context, 'analyzeProductContext', analyze);
  const photos = t.mock.method(media, 'readProductPhoto', async () => ({ buffer: Buffer.from('synthetic-photo'), mimeType: 'image/webp' }));
  const file = require.resolve('../controllers/productSmartFillController');
  delete require.cache[file];
  const controller = require(file);
  t.after(() => { delete require.cache[file]; });
  return { controller, find, read, analysis, photos };
}
function response() {
  const res = new EventEmitter(); res.writableEnded = false;
  res.json = value => { res.body = value; res.writableEnded = true; return res; };
  return res;
}
const request = (owner = 'owner') => ({ user: { _id: owner }, store: { _id: 'store-a' }, tenantFilter: { storeId: 'store-a' },
  body: { notes: 'Name: Bridal lehenga', imageUrls: ['/uploads/one.webp', '/uploads/two.webp'] } });
const successful = { contextStatus: 'completed', name: 'Embroidered Lehenga', description: 'Visible embroidery', sizes: ['M'], sizingMode: 'sized', attributeValues: {}, fieldSources: {} };

test('availability advertises pacing compatible with the existing request limiter and six views', t => {
  const { controller } = fixture(t, async () => successful);
  const res = response(); controller.status({}, res);
  assert.deepEqual(res.body, { enabled: true, notesSupported: true, maxPhotos: 6, requestIntervalMs: 5100 });
});

test('one product response reports completed analysis, preserves tenant filtering and excludes bridal sizes', async t => {
  const { controller, find, read, analysis, photos } = fixture(t, async () => ({ ...successful }));
  const res = response(); await controller.fill(request(), res, error => { throw error; });
  assert.equal(res.body.analysisStatus, 'completed'); assert.equal(res.body.errorCode, ''); assert.equal(res.body.analysisError, '');
  assert.equal(res.body.mode, 'ai'); assert.equal(res.body.suggestion.name, successful.name);
  assert.equal(res.body.suggestion.sizes, undefined); assert.equal(res.body.suggestion.sizingMode, undefined);
  assert.equal(read.mock.calls[0].arguments[0], 'store-a');
  assert.ok(JSON.stringify(find.mock.calls[0].arguments[0]).includes('store-a'));
  assert.equal(photos.mock.callCount(), 2); assert.equal(analysis.mock.calls[0].arguments[0].images.length, 2);
});

test('provider failures expose a typed batch error rather than being counted as successful notes fallback', async t => {
  const { controller } = fixture(t, async () => ({ ...successful, contextStatus: 'failed', contextErrorCode: 'AI_QUOTA_EXCEEDED', contextError: 'Provider quota exhausted' }));
  const res = response(); await controller.fill(request(), res, error => { throw error; });
  assert.equal(res.body.analysisStatus, 'failed'); assert.equal(res.body.errorCode, 'AI_QUOTA_EXCEEDED');
  assert.equal(res.body.analysisError, 'Provider quota exhausted'); assert.ok(res.body.warnings.includes('Provider quota exhausted'));
});

test('the existing owner lock rejects concurrent requests and releases after completion for the next queued product', async t => {
  let finish;
  const { controller, analysis } = fixture(t, () => new Promise(resolve => { finish = resolve; }));
  const first = controller.fill(request(), response(), error => { throw error; });
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  let duplicate;
  await controller.fill(request(), response(), error => { duplicate = error; });
  assert.equal(duplicate.errorCode, 'DUPLICATE_REQUEST'); assert.equal(analysis.mock.callCount(), 1);
  finish({ ...successful }); await first;
  const next = controller.fill(request(), response(), error => { throw error; });
  while (analysis.mock.callCount() < 2) await new Promise(resolve => setImmediate(resolve));
  finish({ ...successful }); await next;
  assert.equal(analysis.mock.callCount(), 2);
});
