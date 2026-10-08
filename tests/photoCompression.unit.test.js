const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { compressPhotoBuffer, preparePhotoFile, PHOTO_MAX_BYTES } = require('../services/photoCompressionService');

function texturedPixels(width, height, alpha = false) {
  const channels = alpha ? 4 : 3, pixels = Buffer.alloc(width * height * channels);
  let seed = 97;
  for (let i = 0; i < pixels.length; i += channels) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    pixels[i] = seed & 255; pixels[i + 1] = (seed >>> 8) & 255; pixels[i + 2] = (seed >>> 16) & 255;
    if (alpha) pixels[i + 3] = i % 11 ? 255 : 0;
  }
  return { pixels, raw: { width, height, channels } };
}

test('detailed photos larger than 2 MB and already-WebP imports fit under 100 KB with quality >=85', async () => {
  const { pixels, raw } = texturedPixels(1200, 1000);
  const png = await sharp(pixels, { raw }).png().toBuffer();
  assert.ok(png.length > 2 * 1024 * 1024);
  for (const source of [png, await sharp(png).webp({ quality: 98 }).toBuffer()]) {
    const output = await compressPhotoBuffer(source);
    assert.ok(output.buffer.length <= PHOTO_MAX_BYTES);
    assert.equal(output.mimeType, 'image/webp');
    assert.ok(output.quality >= 85);
    const meta = await sharp(output.buffer).metadata();
    assert.ok(meta.width >= 320 && meta.width <= 1600);
    assert.equal(meta.exif, undefined);
  }
});

test('transparent output retains alpha and EXIF orientation is applied before metadata is removed', async () => {
  const { pixels, raw } = texturedPixels(800, 600, true);
  const output = await compressPhotoBuffer(await sharp(pixels, { raw }).png().toBuffer());
  const meta = await sharp(output.buffer).metadata();
  assert.equal(meta.hasAlpha, true);
  assert.ok(output.buffer.length <= PHOTO_MAX_BYTES);
  const original = await sharp({ create: { width: 800, height: 400, channels: 3, background: '#700c2a' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const oriented = await compressPhotoBuffer(original);
  const rotated = await sharp(oriented.buffer).metadata();
  assert.equal(rotated.width, 400); assert.equal(rotated.height, 800);
  assert.equal(rotated.orientation, undefined); assert.equal(rotated.exif, undefined);
});

test('small photos remain byte-identical; video passthrough and source digests are preserved', async () => {
  const source = await sharp({ create: { width: 40, height: 60, channels: 4, background: '#704032' } }).webp().toBuffer();
  assert.deepEqual((await compressPhotoBuffer(source)).buffer, source);
  const file = { buffer: source, mimetype: 'image/webp', originalname: 'small.webp', size: source.length };
  const converted = await preparePhotoFile(file);
  assert.deepEqual(file.buffer, source);
  assert.equal(await preparePhotoFile(file), converted);
  const video = { buffer: Buffer.from('video'), mimetype: 'video/mp4' };
  assert.equal(await preparePhotoFile(video), video);
});

test('corrupt images, animated or unsupported types fail with actionable validation errors', async () => {
  await assert.rejects(compressPhotoBuffer(Buffer.from('not a photo')), error => error.statusCode === 400);
  await assert.rejects(compressPhotoBuffer(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>')), /single JPG/);
  await assert.rejects(preparePhotoFile({ buffer: Buffer.from('gif'), mimetype: 'image/gif' }), /Only JPG/);
});

test('generated local assets are compressed atomically without replacing source files', async () => {
  const { pixels, raw } = texturedPixels(700, 700);
  const original = await sharp(pixels, { raw }).png().toBuffer();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-compress-'));
  const source = path.join(directory, 'source.png'); let stored;
  try {
    await fs.writeFile(source, original);
    stored = await require('../services/uploadRetryService').persistLocal({ path: source, mimetype: 'image/png', originalname: 'generated.png', size: original.length });
    const bytes = await fs.readFile(path.join(__dirname, '../uploads', stored.publicId));
    assert.ok(bytes.length <= PHOTO_MAX_BYTES);
    assert.equal((await sharp(bytes).metadata()).format, 'webp');
    assert.deepEqual(await fs.readFile(source), original);
    assert.equal(stored.mimeType, 'image/webp'); assert.equal(stored.sizeBytes, bytes.length);
  } finally {
    if (stored) await fs.unlink(path.join(__dirname, '../uploads', stored.publicId)).catch(() => {});
    await fs.unlink(source).catch(() => {});
    await fs.rmdir(directory).catch(() => {});
  }
});

test('generated R2 and Cloudinary images apply the same byte limit before provider requests', async t => {
  const keys = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME', 'R2_PUBLIC_URL', 'CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => keys.forEach(key => previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key]));
  Object.assign(process.env, { R2_ACCOUNT_ID: 'test', R2_ACCESS_KEY_ID: 'test', R2_SECRET_ACCESS_KEY: 'test', R2_BUCKET_NAME: 'test', R2_PUBLIC_URL: 'https://test.invalid', CLOUDINARY_CLOUD_NAME: 'test', CLOUDINARY_API_KEY: 'test', CLOUDINARY_API_SECRET: 'test' });
  const { pixels, raw } = texturedPixels(600, 600);
  const source = await sharp(pixels, { raw }).png().toBuffer();
  const file = { buffer: source, originalname: 'generated.png', mimetype: 'image/png', size: source.length };
  let r2Calls = 0, cloudCalls = 0;
  t.mock.method(require('../services/r2Upload').getR2Client(), 'send', async command => {
    r2Calls += 1; assert.ok(command.input.Body.length <= PHOTO_MAX_BYTES);
    assert.equal(command.input.ContentType, 'image/webp'); assert.match(command.input.Key, /\.webp$/);
    return {};
  });
  t.mock.method(global, 'fetch', async (_url, options) => {
    cloudCalls += 1; const blob = options.body.get('file');
    assert.ok(blob.size <= PHOTO_MAX_BYTES); assert.equal(blob.type, 'image/webp');
    return { ok: true, json: async () => ({ secure_url: 'https://test.invalid/generated.webp', public_id: 'generated' }) };
  });
  const r2 = await require('../services/r2Upload').uploadFileToR2(file);
  const cloud = await require('../services/cloudinaryUpload').uploadImage(file);
  assert.equal(r2Calls, 1); assert.equal(cloudCalls, 1);
  assert.ok(r2.sizeBytes <= PHOTO_MAX_BYTES && cloud.sizeBytes <= PHOTO_MAX_BYTES);
  assert.deepEqual(file.buffer, source);
});
