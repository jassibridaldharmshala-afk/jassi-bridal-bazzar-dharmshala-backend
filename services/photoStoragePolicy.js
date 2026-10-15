const path = require('node:path');
const fs = require('node:fs/promises');
const { ApiError } = require('../utils/apiError');
const { PHOTO_MASTER_MAX_BYTES, PHOTO_MASTER_MAX_EDGE, PHOTO_RECIPE } = require('./photoCompressionService');

function imageSignature(bytes) {
  return bytes?.[0] === 0xff && bytes?.[1] === 0xd8 && bytes?.[2] === 0xff
    || bytes?.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || bytes?.toString('ascii', 0, 4) === 'RIFF' && bytes?.toString('ascii', 8, 12) === 'WEBP'
    || bytes?.toString('ascii', 0, 6) === 'GIF87a' || bytes?.toString('ascii', 0, 6) === 'GIF89a'
    || bytes?.toString('ascii', 0, 2) === 'BM' || bytes?.toString('hex', 0, 4) === '49492a00' || bytes?.toString('hex', 0, 4) === '4d4d002a'
    || /<svg\b/i.test(bytes?.toString('utf8', 0, 64) || '')
    || bytes?.toString('ascii', 4, 8) === 'ftyp' && /avif|avis|heic|heix|hevc|mif1/.test(bytes?.toString('ascii', 8, 32));
}
async function isPhotoFile(file = {}) {
  if (/^image\//i.test(file.mimetype || '') || /\.(?:jpe?g|png|webp|gif|avif|heic|heif|svg|tiff?)$/i.test(file.originalname || file.path || '')) return true;
  if (file.buffer) return Boolean(imageSignature(file.buffer.subarray(0, 64)));
  if (!file.path) return false;
  const handle = await fs.open(file.path, 'r');
  try { const prefix = Buffer.alloc(64); const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0); return Boolean(imageSignature(prefix.subarray(0, bytesRead))); }
  finally { await handle.close(); }
}
function photoFileInput(file) {
  return { ...file, mimetype: /^image\//i.test(file.mimetype || '') ? file.mimetype.toLowerCase() : /\.(?:gif|avif|heic|heif|svg|tiff?)$/i.test(path.extname(file.originalname || '')) ? 'image/unsupported' : 'image/webp' };
}
function assertStoredPhoto(file, buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > PHOTO_MASTER_MAX_BYTES || buffer.length !== file.size || file.photo?.recipe !== PHOTO_RECIPE || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') {
    throw new ApiError('UPLOAD_IMAGE_INVALID', 'This photo could not be optimized for storage. Choose another photo.', { statusCode: 400 });
  }
}
function displayMaster(file, saved) {
  return { ...saved, provider: 'r2', width: file.photo.width, height: file.photo.height, displayWidth: PHOTO_MASTER_MAX_EDGE, mimeType: file.mimetype, sizeBytes: file.size };
}
module.exports = { imageSignature, isPhotoFile, photoFileInput, assertStoredPhoto, displayMaster };
