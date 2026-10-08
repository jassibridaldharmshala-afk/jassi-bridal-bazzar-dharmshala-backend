const crypto = require('crypto');
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const { preparePhotoFile } = require('./photoCompressionService');
const { DeleteObjectCommand, HeadObjectCommand, S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

let r2Client;

const allowedFolders = new Set([
  'products',
  'categories',
  'banners',
  'product-videos',
  'reel-imports/original',
  'reel-imports/normalized',
  'reel-imports/frames',
  'reel-imports/candidates',
  'reviews',
  'returns',
  'verification',
  'social-studio',
]);

function isR2Configured() {
  return Boolean(
    process.env.R2_ACCOUNT_ID
    && process.env.R2_ACCESS_KEY_ID
    && process.env.R2_SECRET_ACCESS_KEY
    && process.env.R2_BUCKET_NAME
    && process.env.R2_PUBLIC_URL,
  );
}

function getR2Client() {
  if (!r2Client) {
    r2Client = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return r2Client;
}

function getR2Folder() {
  return String(process.env.R2_FOLDER || 'products').replace(/^\/+|\/+$/g, '');
}

function buildPublicUrl(objectKey) {
  const base = String(process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
  return `${base}/${objectKey}`;
}

function resolveUploadFolder(folder = '') {
  const normalized = String(folder || '').trim().toLowerCase();
  if (allowedFolders.has(normalized)) return normalized;
  return getR2Folder();
}

function buildObjectKey(file, { folder = 'products', extension = 'webp', uploadId } = {}) {
  const safeFolder = resolveUploadFolder(folder);
  const safeBaseName = String(file.originalname || 'image')
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'image';
  const suffix = crypto.randomBytes(5).toString('hex');
  const safeExtension = String(extension || 'webp').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'webp';
  if (/^[a-f0-9]{64}$/.test(uploadId || '')) return `${safeFolder}/retry-${uploadId}.${safeExtension}`;
  return `${safeFolder}/${Date.now()}-${suffix}-${safeBaseName}.${safeExtension}`;
}

async function alreadyStored(objectKey, options) {
  if (!options.uploadId || !options.recovering) return false;
  try {
    await getR2Client().send(new HeadObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: objectKey }), { abortSignal: AbortSignal.timeout(30000) });
    return true;
  } catch (error) {
    if (error.$metadata?.httpStatusCode === 404 || ['NotFound', 'NoSuchKey'].includes(error.name)) return false;
    throw error;
  }
}

async function uploadImageToR2(file, options = {}) {
  file = await preparePhotoFile(file);
  const objectKey = buildObjectKey(file, { ...options, extension: resolveFileExtension(file) });
  if (!await alreadyStored(objectKey, options)) {
    const buffer = file.buffer || await fs.readFile(file.path);
    await getR2Client().send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: objectKey,
      Body: buffer,
      ContentType: file.mimetype || 'image/webp',
      CacheControl: 'public, max-age=31536000, immutable',
    }), { abortSignal: AbortSignal.timeout(2 * 60 * 1000) });
  }

  return {
    url: buildPublicUrl(objectKey),
    publicId: objectKey,
    originalName: file.originalname,
    mimeType: file.mimetype,
    sizeBytes: file.size,
  };
}

async function uploadFileToR2(file, options = {}) {
  if (String(file.mimetype || '').startsWith('image/')) return uploadImageToR2(file, options);
  const extension = resolveFileExtension(file);
  const objectKey = buildObjectKey(file, { ...options, extension });
  if (await alreadyStored(objectKey, options)) return { url: buildPublicUrl(objectKey), publicId: objectKey, originalName: file.originalname };
  const sizeBytes = Number(file.size || 0) || (await fs.stat(file.path)).size;
  const stream = fsSync.createReadStream(file.path);
  const controller = new AbortController();
  const isVideo = String(file.mimetype || '').toLowerCase().startsWith('video/');
  const timeout = setTimeout(() => controller.abort(), (isVideo ? 10 : 2) * 60 * 1000);

  try {
    await getR2Client().send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: objectKey,
      Body: stream,
      ContentLength: sizeBytes,
      ContentType: file.mimetype || 'application/octet-stream',
      CacheControl: 'public, max-age=31536000, immutable',
    }), { abortSignal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      const timeoutError = new Error(`${isVideo ? 'Uploading the reel' : 'Saving a product photo'} to storage timed out. Please try again.`);
      timeoutError.code = 'STORAGE_UPLOAD_TIMEOUT';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    stream.destroy();
  }

  return {
    url: buildPublicUrl(objectKey),
    publicId: objectKey,
    originalName: file.originalname,
  };
}

async function deleteImageFromR2(identifier) {
  const objectKey = resolveObjectKey(identifier);
  if (!objectKey || !isR2Configured()) return false;

  await getR2Client().send(new DeleteObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: objectKey,
  }));
  await require('./uploadRetryService').invalidateStoredUpload('r2', objectKey);
  return true;
}

function resolveObjectKey(identifier) {
  if (!identifier) return '';
  if (typeof identifier === 'object') {
    return resolveObjectKey(identifier.publicId || identifier.url);
  }

  const value = String(identifier || '').trim();
  if (!value) return '';
  if (!/^https?:\/\//i.test(value)) return value;

  const publicBase = String(process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
  if (publicBase && value.startsWith(publicBase)) {
    return value.slice(publicBase.length + 1);
  }

  try {
    const pathname = new URL(value).pathname.replace(/^\/+/, '');
    return pathname;
  } catch {
    return '';
  }
}

function resolveFileExtension(file = {}) {
  const mime = String(file.mimetype || '').toLowerCase();
  if (mime.startsWith('image/')) return mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('quicktime') || mime.includes('mov')) return 'mov';
  if (mime.includes('mp4')) return 'mp4';
  const original = String(file.originalname || '').split('.').pop().toLowerCase();
  if (['mp4', 'webm', 'mov'].includes(original)) return original;
  return 'mp4';
}

module.exports = {
  buildPublicUrl,
  getR2Client,
  isR2Configured,
  uploadImageToR2,
  uploadFileToR2,
  deleteImageFromR2,
  resolveObjectKey,
  resolveUploadFolder,
};
