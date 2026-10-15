const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const crypto = require('node:crypto');
const cloud = require('./r2MediaFixture').r2MediaFixture(test);
const r2 = require('../services/r2Upload');
const storage = require('../services/mediaStorage.service');
const { PHOTO_MASTER_MAX_BYTES, PHOTO_TOTAL_MAX_BYTES, PHOTO_RECIPE } = require('../services/photoCompressionService');
let original;
test.before(async () => {
  const pixels = crypto.createHash('sha256').update('photo-fixture').digest();
  const bytes = Buffer.alloc(1200 * 900 * 3); let seed = pixels.readUInt32LE(0);
  for (let i = 0; i < bytes.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; bytes[i] = seed >>> 24; }
  original = await sharp(bytes, { raw: { width: 1200, height: 900, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
});
function input(mimetype = 'image/png', originalname = 'photo.png') { return { buffer: original, size: original.length, mimetype, originalname }; }
async function optimized(saved) {
  const object = cloud.objects.get(saved.publicId || saved.storageKey);
  assert.equal(object.type, 'image/webp'); assert.ok(object.bytes.length <= PHOTO_MASTER_MAX_BYTES);
  assert.ok(object.bytes.length < original.length / 3); assert.equal((await sharp(object.bytes).metadata()).format, 'webp');
  assert.equal(object.metadata['photo-recipe'], PHOTO_RECIPE);
}
test('the direct photo, generic file and buffer writers all optimize before R2', async () => {
  await optimized(await r2.uploadImageToR2(input()));
  await optimized(await r2.uploadFileToR2(input('application/octet-stream', 'payload.bin')));
  await optimized(await r2.uploadFileToR2(input('video/mp4', 'wrong-label.mp4')));
  await optimized(await storage.putBufferToR2(original, 'banners/hero.bin'));
});
test('catalogue uploads keep the complete stored image pack under its budget and reuse the detail master', async () => {
  const files = await require('../services/mediaUploadService').storeFiles({ files: [input()], query: {}, store: {} }, { upload: (file, index, save) => save({}) });
  const file = files[0], keys = new Set([file.publicId, ...file.variants.map(v => v.publicId)]);
  assert.equal(keys.size, 4); assert.equal(cloud.objects.size, 4);
  assert.equal(file.variants.filter(v => v.url === file.url).length, 1);
  assert.ok([...keys].reduce((sum, key) => sum + cloud.bytes(key).length, 0) <= PHOTO_TOTAL_MAX_BYTES);
  for (const key of keys) await optimized({ publicId: key });
});
test('generated and imported photos use the same pack while small photos store one object', async () => {
  const file = await require('../services/generatedMediaService').persistGeneratedFile(input(), { namespace: 'test', ownerId: 'owner', slot: 1, recipe: 'input-v1' });
  await optimized(file); assert.equal(cloud.objects.size, 4);
  const small = await sharp({ create: { width: 100, height: 180, channels: 4, background: 'transparent' } }).png().toBuffer();
  const saved = await storage.uploadGeneratedImage({ buffer: small, size: small.length, mimetype: 'image/png', originalname: 'logo.png' });
  assert.equal(cloud.objects.size, 5); assert.equal(saved.variants.length, 1); assert.equal(saved.variants[0].url, saved.url);
});
test('unsupported or corrupt photos cannot fall through as uncompressed generic uploads', async () => {
  await assert.rejects(r2.uploadFileToR2({ buffer: Buffer.from('not-an-image'), size: 12, mimetype: 'image/png', originalname: 'bad.png' }));
  await assert.rejects(r2.uploadFileToR2({ buffer: Buffer.from('GIF89a'), size: 6, mimetype: 'application/octet-stream', originalname: 'hidden.bin' }));
  await assert.rejects(r2.uploadFileToR2({ buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), size: 41, mimetype: 'video/mp4', originalname: 'hidden.mp4' }));
  assert.equal(cloud.objects.size, 0);
});
test('a new recipe cannot recover the old unoptimized retry object', async () => {
  const uploadId = 'c'.repeat(64), oldKey = `products/retry-${uploadId}.webp`;
  cloud.objects.set(oldKey, { bytes: original, type: 'image/png' });
  const saved = await r2.uploadImageToR2(input(), { uploadId, recovering: true });
  assert.notEqual(saved.publicId, oldKey); await optimized(saved);
  const puts = cloud.puts;
  const repeated = await r2.uploadImageToR2(input(), { uploadId, recovering: true });
  assert.equal(saved.publicId, repeated.publicId); assert.equal(cloud.puts, puts);
});
