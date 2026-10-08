const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { compressPhotoBuffer, preparePhotoFile, prepareAnalysisPhotoBuffer, PHOTO_SOURCE_MAX_BYTES } = require('../services/photoCompressionService');

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
async function samePixels(source, output) {
  const original = await sharp(source).raw().toBuffer({ resolveWithObject: true });
  const stored = await sharp(output).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual(stored.info, original.info);
  assert.deepEqual(stored.data, original.data);
}

test('photos over 2 MB retain every pixel and native resolution, with no 100 KB cap', async () => {
  const { pixels, raw } = texturedPixels(1800, 1000);
  const png = await sharp(pixels, { raw }).png({ compressionLevel: 0 }).toBuffer();
  assert.ok(png.length > 2 * 1024 * 1024);
  const output = await compressPhotoBuffer(png);
  assert.ok(output.buffer.length > 100000); assert.ok(output.buffer.length <= png.length);
  assert.equal(output.mimeType, 'image/png'); assert.equal(output.lossless, true);
  assert.equal(output.width, 1800); assert.equal(output.height, 1000);
  await samePixels(png, output.buffer);
});

test('lossless PNG optimization reduces inefficient files and preserves alpha including hidden RGB', async () => {
  const { pixels, raw } = texturedPixels(600, 400, true);
  const png = await sharp(pixels, { raw }).png({ compressionLevel: 0 }).toBuffer();
  const output = await compressPhotoBuffer(png);
  assert.ok(output.buffer.length < png.length);
  assert.equal((await sharp(output.buffer).metadata()).hasAlpha, true);
  await samePixels(png, output.buffer);
});

test('JPEG privacy metadata is stripped, orientation is applied losslessly and ICC survives', async () => {
  const { pixels, raw } = texturedPixels(280, 170);
  const jpg = await sharp(pixels, { raw }).jpeg({ quality: 98 }).withMetadata({ orientation: 6 }).toBuffer();
  const result = await compressPhotoBuffer(jpg), metadata = await sharp(result.buffer).metadata();
  assert.equal(result.mimeType, 'image/png'); assert.equal(metadata.width, 170); assert.equal(metadata.height, 280);
  assert.equal(metadata.orientation, undefined); assert.equal(metadata.exif, undefined);
  assert.ok(metadata.icc); assert.deepEqual(metadata.icc, (await sharp(jpg).metadata()).icc);
  const expected = await sharp(jpg).rotate().keepIccProfile().png().toBuffer();
  await samePixels(expected, result.buffer);
  const webp = await sharp(pixels, { raw }).webp({ quality: 98 }).toBuffer();
  assert.equal((await compressPhotoBuffer(webp)).buffer, webp);
  await samePixels(webp, (await compressPhotoBuffer(webp)).buffer);
});

test('already optimized photos and prepared files avoid repeated generation; videos pass through', async () => {
  const source = await sharp({ create: { width: 40, height: 60, channels: 4, background: '#704032' } }).webp().toBuffer();
  assert.deepEqual((await compressPhotoBuffer(source)).buffer, source);
  const file = { buffer: source, mimetype: 'image/webp', originalname: 'small.webp', size: source.length };
  const converted = await preparePhotoFile(file);
  assert.deepEqual(file.buffer, source);
  assert.equal(await preparePhotoFile(file), converted);
  assert.equal(await preparePhotoFile(converted), converted);
  const video = { buffer: Buffer.from('video'), mimetype: 'video/mp4' };
  assert.equal(await preparePhotoFile(video), video);
});

test('AI derivatives stay bounded without altering saved photo quality', async () => {
  const { pixels, raw } = texturedPixels(1800, 1000);
  const source = await sharp(pixels, { raw }).png({ compressionLevel: 0 }).toBuffer();
  const analysis = await prepareAnalysisPhotoBuffer(source);
  assert.ok(analysis.buffer.length <= 1024 * 1024);
  assert.equal(analysis.mimeType, 'image/webp');
  await samePixels(source, (await compressPhotoBuffer(source)).buffer);
});

test('corrupt, unsupported, animated and oversized images fail before persistence', async () => {
  await assert.rejects(compressPhotoBuffer(Buffer.from('not a photo')), error => error.statusCode === 400);
  await assert.rejects(compressPhotoBuffer(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>')), /single JPG/);
  await assert.rejects(preparePhotoFile({ buffer: Buffer.from('gif'), mimetype: 'image/gif' }), /Only JPG/);
  await assert.rejects(compressPhotoBuffer(Buffer.alloc(PHOTO_SOURCE_MAX_BYTES + 1)), /20 MB/);
  const huge = await sharp({ create: { width: 8000, height: 8000, channels: 3, background: 'white' } }).png().toBuffer();
  await assert.rejects(compressPhotoBuffer(huge), /could not be decoded/);
});

test('generated local assets optimize losslessly and leave source files untouched', async () => {
  const { pixels, raw } = texturedPixels(700, 700);
  const original = await sharp(pixels, { raw }).png({ compressionLevel: 0 }).toBuffer();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-compress-'));
  const source = path.join(directory, 'source.png'); let stored;
  try {
    await fs.writeFile(source, original);
    stored = await require('../services/uploadRetryService').persistLocal({ path: source, mimetype: 'image/png', originalname: 'generated.png', size: original.length });
    const bytes = await fs.readFile(path.join(__dirname, '../uploads', stored.publicId));
    assert.ok(bytes.length <= original.length);
    await samePixels(original, bytes);
    assert.deepEqual(await fs.readFile(source), original);
    assert.equal(stored.mimeType, 'image/png'); assert.equal(stored.sizeBytes, bytes.length);
  } finally {
    if (stored) await fs.unlink(path.join(__dirname, '../uploads', stored.publicId)).catch(() => {});
    await fs.unlink(source).catch(() => {}); await fs.rmdir(directory).catch(() => {});
  }
});

test('R2 and Cloudinary receive lossless bytes with the correct MIME, extension and receipt', async t => {
  const keys = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME', 'R2_PUBLIC_URL', 'CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => keys.forEach(key => previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key]));
  Object.assign(process.env, { R2_ACCOUNT_ID: 'test', R2_ACCESS_KEY_ID: 'test', R2_SECRET_ACCESS_KEY: 'test', R2_BUCKET_NAME: 'test', R2_PUBLIC_URL: 'https://test.invalid', CLOUDINARY_CLOUD_NAME: 'test', CLOUDINARY_API_KEY: 'test', CLOUDINARY_API_SECRET: 'test' });
  const { pixels, raw } = texturedPixels(600, 600);
  const source = await sharp(pixels, { raw }).png({ compressionLevel: 0 }).toBuffer();
  const file = { buffer: source, originalname: 'generated.png', mimetype: 'image/png', size: source.length };
  let r2Calls = 0, cloudCalls = 0;
  t.mock.method(require('../services/r2Upload').getR2Client(), 'send', async command => {
    r2Calls++; assert.ok(command.input.Body.length <= source.length);
    assert.equal(command.input.ContentType, 'image/png'); assert.match(command.input.Key, /\.png$/);
    await samePixels(source, command.input.Body); return {};
  });
  t.mock.method(global, 'fetch', async (_url, options) => {
    cloudCalls++; const blob = options.body.get('file');
    assert.ok(blob.size <= source.length); assert.equal(blob.type, 'image/png');
    await samePixels(source, Buffer.from(await blob.arrayBuffer()));
    return { ok: true, json: async () => ({ secure_url: 'https://test.invalid/generated.png', public_id: 'generated' }) };
  });
  const r2 = await require('../services/r2Upload').uploadFileToR2(file);
  const cloud = await require('../services/cloudinaryUpload').uploadImage(file);
  assert.equal(r2Calls, 1); assert.equal(cloudCalls, 1);
  assert.ok(r2.sizeBytes <= source.length && cloud.sizeBytes <= source.length);
  assert.deepEqual(file.buffer, source);
});
