const fs = require('node:fs/promises');
const sharp = require('sharp');
const { ApiError } = require('../utils/apiError');

const PHOTO_MAX_BYTES = 99000;
const PHOTO_SOURCE_MAX_BYTES = 20 * 1024 * 1024;
const prepared = new WeakMap();
const photoTypes = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
const invalid = message => new ApiError('UPLOAD_IMAGE_INVALID', message, { statusCode: 400 });

async function compressPhotoBuffer(source, { forceWebp = false } = {}) {
  if (!Buffer.isBuffer(source) || !source.length || source.length > PHOTO_SOURCE_MAX_BYTES) throw invalid('Choose a photo up to 20 MB before compression.');
  try {
    const image = sharp(source, { limitInputPixels: 50000000, failOn: 'warning' });
    const metadata = await image.metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format) || (metadata.pages || 1) !== 1) throw invalid('Use a single JPG, PNG or WebP photo, not SVG or animation.');
    // Avoid generation loss on photos already within both limits. EXIF-bearing
    // photos are re-encoded to apply orientation and remove private metadata.
    if ((!forceWebp || metadata.format === 'webp') && source.length <= PHOTO_MAX_BYTES && Math.max(metadata.width, metadata.height) <= 1600 && !metadata.exif && !metadata.xmp) {
      // Decode as well: a valid header alone does not prove the image is usable.
      await image.clone().stats();
      return { buffer: source, mimeType: `image/${metadata.format}`, width: metadata.width, height: metadata.height, skipped: true };
    }
    let edge = Math.min(1600, Math.max(metadata.width, metadata.height));
    for (let attempt = 0; attempt < 10; attempt += 1) {
      let result;
      for (const quality of [90, 85]) {
        result = await image.clone().rotate().resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
          .webp({ quality, alphaQuality: 100, effort: 5 }).toBuffer({ resolveWithObject: true });
        if (result.data.length <= PHOTO_MAX_BYTES) return { buffer: result.data, mimeType: 'image/webp', width: result.info.width, height: result.info.height, quality, skipped: false };
      }
      if (edge <= 320) break;
      edge = Math.max(320, Math.floor(edge * Math.min(0.85, Math.sqrt(PHOTO_MAX_BYTES / result.data.length) * 0.94)));
    }
    throw invalid('This photo could not fit below 100 KB at high quality. Crop unnecessary background and try again.');
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw invalid('This photo could not be decoded. Choose a valid JPG, PNG or WebP photo.');
  }
}

// Every public storage provider and local persistence use this boundary. It does
// not mutate the source file: upload retry digests continue to identify originals.
async function preparePhotoFile(file) {
  if (!photoTypes.has(String(file?.mimetype || '').toLowerCase())) {
    if (String(file?.mimetype || '').startsWith('image/')) throw invalid('Only JPG, PNG and WebP photos are allowed.');
    return file;
  }
  if (prepared.has(file)) return prepared.get(file);
  const pending = (async () => {
    if (Number(file.size) > PHOTO_SOURCE_MAX_BYTES) throw invalid('Choose a photo up to 20 MB before compression.');
    const source = file.buffer || await fs.readFile(file.path);
    const photo = await compressPhotoBuffer(source);
    const result = { ...file, ...(photo.skipped && !file.buffer ? {} : { buffer: photo.buffer }),
      mimetype: photo.mimeType, size: photo.buffer.length, photo: { width: photo.width, height: photo.height, quality: photo.quality, skipped: photo.skipped } };
    prepared.set(result, Promise.resolve(result));
    return result;
  })();
  prepared.set(file, pending);
  try { return await pending; } catch (error) { prepared.delete(file); throw error; }
}

module.exports = { PHOTO_MAX_BYTES, PHOTO_SOURCE_MAX_BYTES, compressPhotoBuffer, preparePhotoFile };
