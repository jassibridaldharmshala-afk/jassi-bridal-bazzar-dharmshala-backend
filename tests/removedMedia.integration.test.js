const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestEnvironment, stopTestEnvironment, resetDatabase } = require('./helpers');
const service = require('../services/removedMediaService');
const r2 = require('../services/r2Upload');
const Removed = require('../models/RemovedMedia');
const root = 'https://media.test/shop/products/old.webp';
const family = { url: root, provider: 'r2', publicId: 'products/old.webp', mimeType: 'image/webp', variants: [{ url: 'https://media.test/shop/products/old-320.webp', publicId: 'products/old-320.webp', provider: 'r2', width: 320 }] };
test.before(startTestEnvironment); test.after(stopTestEnvironment); test.beforeEach(resetDatabase);
test.beforeEach(t => {
  const previous = process.env.R2_PUBLIC_URL;
  process.env.R2_PUBLIC_URL = 'https://media.test/shop';
  t.after(() => previous === undefined ? delete process.env.R2_PUBLIC_URL : process.env.R2_PUBLIC_URL = previous);
});
test('only owned Cloudflare paths resolve, including a configured subdirectory', () => {
  assert.equal(r2.resolveObjectKey(root), 'products/old.webp');
  for (const url of ['https://foreign.test/shop/products/old.webp', 'https://media.test/shop-spoof/products/old.webp', root + '?download=1', 'https://media.test/shop/products/a%2F..%2Fb.webp', 'https://media.test/shop/products/a%5Cb.webp']) assert.equal(r2.resolveObjectKey(url), '', url);
  assert.equal(r2.resolveObjectKey({ publicId: 'products/old.webp', provider: 'cloudinary' }), '');
});
test('manifest attaches the correct responsive family to URL based records', async () => {
  await require('../services/imageAssetService').registerImageAsset(family);
  const record = { image: root, socialImage: 'https://external.test/other.jpg' };
  await require('../services/imageAssetService').attachImageMedia(record, ['image', 'socialImage']);
  assert.equal(record.imageMedia.variants[0].width, 320);
  assert.equal(record.socialImageMedia, undefined);
});
test('prepared cleanup preserves shared and restorable photos, and never queues an unchanged image', async t => {
  await require('../services/imageAssetService').registerImageAsset(family);
  const calls = []; t.mock.method(r2, 'deleteImageFromR2', async entry => { calls.push(entry.url); return true; });
  await service.queueRemovedMedia({ image: root }, { image: root }, { source: 'category', sourceId: 'same' });
  assert.equal(await Removed.countDocuments(), 0);
  await require('../models/StoreContentVersion').collection.insertOne({ content: { homepage: { image: family.variants[0].url } } });
  await service.queueRemovedMedia({ image: root }, {}, { source: 'category', sourceId: 'changed' });
  await service.processRemovedMedia();
  assert.equal((await Removed.findOne()).status, 'SHARED');
  assert.deepEqual(calls, []);
});
test('prepared cleanup retries an interrupted deletion and removes the complete exact family', async t => {
  await require('../services/imageAssetService').registerImageAsset(family);
  let fail = true; const calls = [];
  t.mock.method(r2, 'deleteImageFromR2', async entry => {
    calls.push(entry.url);
    if (fail && entry.url === family.variants[0].url) { fail = false; throw new Error('Synthetic storage outage'); }
    return true;
  });
  await service.queueRemovedMedia({ image: root }, { image: 'https://external.test/new.webp' }, { source: 'category', sourceId: 'changed' });
  await service.processRemovedMedia();
  const pending = await Removed.findOne(); assert.equal(pending.status, 'PENDING'); assert.match(pending.lastError, /Synthetic/);
  await Removed.updateOne({ _id: pending._id }, { $set: { nextAttemptAt: new Date(0) } });
  await service.processRemovedMedia();
  assert.equal((await Removed.findOne()).status, 'DONE');
  assert.deepEqual(calls, [root, family.variants[0].url, root, family.variants[0].url]);
  assert.equal(await require('../models/MediaAsset').countDocuments(), 0);
});
