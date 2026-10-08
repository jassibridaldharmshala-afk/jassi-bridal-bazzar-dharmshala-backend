const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { pipeline } = require('stream/promises');
const {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} = require('@aws-sdk/client-s3');
const {
  buildPublicUrl,
  getR2Client,
  isR2Configured,
  uploadFileToR2,
} = require('./r2Upload');
const {
  deleteFile: deleteCloudinaryFile,
  isCloudinaryConfigured,
  uploadImage,
  uploadVideo,
} = require('./cloudinaryUpload');

function getStorageProvider() {
  if (isR2Configured()) return 'r2';
  if (isCloudinaryConfigured()) return 'cloudinary';
  return null;
}

function assertStorageConfigured() {
  const provider = getStorageProvider();
  if (!provider) {
    const error = new Error('Reel import storage is not configured. Connect R2 or Cloudinary.');
    error.code = 'REEL_STORAGE_NOT_CONFIGURED';
    error.statusCode = 503;
    throw error;
  }
  return provider;
}

async function uploadOriginalVideo(file, options = {}) {
  const provider = assertStorageConfigured();
  const uploaded = provider === 'r2'
    ? await uploadFileToR2(file, { ...options, folder: options.folder || 'reel-imports/original' })
    : await uploadVideo(file, { ...options, folder: options.folder || 'reel-imports/original' });
  return {
    provider,
    storageKey: uploaded.publicId,
    url: uploaded.url,
  };
}

async function uploadGeneratedImage(file, options = {}) {
  const provider = assertStorageConfigured();
  const uploaded = provider === 'r2'
    ? await uploadFileToR2(file, { ...options, folder: options.folder || 'reel-imports/candidates' })
    : await uploadImage(file, { ...options, folder: options.folder || 'reel-imports/candidates' });
  const variants = [];
  for (const variant of options.responsive === false ? [] : await require('./photoCompressionService').responsivePhotoVariants(file)) {
    const uploadId = require('node:crypto').createHash('sha256').update(uploaded.publicId + ':display-v1:' + variant.width).digest('hex');
    const display = provider === 'r2' ? await uploadFileToR2(variant, { ...options, folder: options.folder || 'reel-imports/candidates', uploadId })
      : await uploadImage(variant, { ...options, folder: options.folder || 'reel-imports/candidates', uploadId });
    variants.push({ ...display, provider, width: variant.width, height: variant.height, mimeType: variant.mimetype, sizeBytes: variant.size });
  }
  return { provider, storageKey: uploaded.publicId, url: uploaded.url, variants };
}

async function objectExists({ provider, storageKey, url }) {
  if (provider === 'r2' && isR2Configured()) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      await getR2Client().send(
        new HeadObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: storageKey }),
        { abortSignal: controller.signal },
      );
      return true;
    } catch {
      const publicUrl = url || buildPublicUrl(storageKey);
      if (!publicUrl) return false;
      const response = await fetch(publicUrl, { method: 'HEAD', signal: AbortSignal.timeout(12000) }).catch(() => null);
      return Boolean(response?.ok);
    } finally {
      clearTimeout(timer);
    }
  }
  if (provider === 'cloudinary' && url) {
    const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(12000) }).catch(() => null);
    return Boolean(response?.ok);
  }
  return false;
}

function createAbortContext(parentSignal, timeoutMs) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  const timer = setTimeout(() => controller.abort(new Error('Storage operation timed out.')), timeoutMs);
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', abortFromParent);
    },
  };
}

async function writeBodyToFile(body, destinationPath, { signal } = {}) {
  await fsp.mkdir(path.dirname(destinationPath), { recursive: true });
  if (body && (typeof body.pipe === 'function' || typeof body.getReader === 'function')) {
    await pipeline(body, fs.createWriteStream(destinationPath), { signal });
    return;
  }
  if (body && typeof body.transformToByteArray === 'function') {
    if (signal?.aborted) throw signal.reason || new Error('Storage operation aborted.');
    const bytes = await body.transformToByteArray();
    if (signal?.aborted) throw signal.reason || new Error('Storage operation aborted.');
    await fsp.writeFile(destinationPath, Buffer.from(bytes));
    return;
  }
  throw new Error('Storage returned an unreadable response body.');
}

async function verifyDownloadedFile(destinationPath, expectedSizeBytes) {
  const details = await fsp.stat(destinationPath);
  const expected = Number(expectedSizeBytes || 0);
  if (!details.size || (expected > 0 && details.size < expected)) {
    const error = new Error('The stored reel download was incomplete.');
    error.code = 'STORAGE_DOWNLOAD_INCOMPLETE';
    throw error;
  }
  return details.size;
}

function normalizeDownloadError(error, errors) {
  if (error?.code === 'STORAGE_DOWNLOAD_INCOMPLETE') return error;
  const timedOut = error?.name === 'AbortError'
    || error?.code === 'ABORT_ERR'
    || /aborted|timed out/i.test(String(error?.message || ''));
  const failure = new Error(timedOut
    ? 'Downloading the reel from storage timed out. Please retry the import.'
    : 'The stored reel could not be downloaded from cloud storage.');
  failure.code = timedOut ? 'STORAGE_DOWNLOAD_TIMEOUT' : 'STORAGE_FAILURE';
  failure.cause = error;
  failure.storageErrors = errors;
  return failure;
}

async function downloadObject(
  { provider, storageKey, url },
  destinationPath,
  { expectedSizeBytes = 0, timeoutMs = 3 * 60 * 1000, signal } = {},
) {
  const errors = [];
  const overall = createAbortContext(signal, timeoutMs);
  if (provider === 'r2' && isR2Configured()) {
    const r2Attempt = createAbortContext(overall.signal, Math.min(60000, Math.max(10000, Math.floor(timeoutMs / 2))));
    try {
      const response = await getR2Client().send(new GetObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: storageKey,
      }), { abortSignal: r2Attempt.signal });
      await writeBodyToFile(response.Body, destinationPath, { signal: r2Attempt.signal });
      await verifyDownloadedFile(destinationPath, expectedSizeBytes);
      overall.cleanup();
      return destinationPath;
    } catch (error) {
      errors.push(error.message);
      await fsp.unlink(destinationPath).catch(() => null);
    } finally {
      r2Attempt.cleanup();
    }
  }

  const readUrl = url || (provider === 'r2' ? buildPublicUrl(storageKey) : '');
  if (!readUrl) {
    overall.cleanup();
    throw normalizeDownloadError(new Error(errors[0] || 'Unable to download stored reel.'), errors);
  }

  try {
    const response = await fetch(readUrl, { signal: overall.signal });
    if (!response.ok) throw new Error(`Storage returned HTTP ${response.status}.`);
    await writeBodyToFile(response.body, destinationPath, { signal: overall.signal });
    await verifyDownloadedFile(destinationPath, expectedSizeBytes);
    return destinationPath;
  } catch (error) {
    errors.push(error.message);
    await fsp.unlink(destinationPath).catch(() => null);
    throw normalizeDownloadError(error, errors);
  } finally {
    overall.cleanup();
  }
}

async function deleteObject({ provider, storageKey }) {
  if (!storageKey) return false;
  if (provider === 'r2') {
    await getR2Client().send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: storageKey }));
    await require('./uploadRetryService').invalidateStoredUpload('r2', storageKey);
    return true;
  }
  if (provider === 'cloudinary' && isCloudinaryConfigured()) {
    return deleteCloudinaryFile(storageKey, 'video');
  }
  return false;
}

async function createSignedReadUrl({ provider, storageKey, url }) {
  if (url) return url;
  if (provider === 'r2') return buildPublicUrl(storageKey);
  throw new Error('A private read URL is unavailable for this storage object.');
}

async function putBufferToR2(buffer, storageKey, contentType = 'application/octet-stream') {
  if (String(contentType).startsWith('image/')) {
    const photo = await require('./photoCompressionService').compressPhotoBuffer(buffer);
    buffer = photo.buffer;
    contentType = photo.mimeType;
  }
  await getR2Client().send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: storageKey,
    Body: buffer,
    ContentType: contentType,
  }));
  return { provider: 'r2', storageKey, url: buildPublicUrl(storageKey) };
}

async function cleanupLocalFile(filePath) {
  if (filePath) await fsp.unlink(filePath).catch(() => null);
}

module.exports = {
  assertStorageConfigured,
  cleanupLocalFile,
  createSignedReadUrl,
  deleteObject,
  downloadObject,
  getStorageProvider,
  objectExists,
  putBufferToR2,
  uploadGeneratedImage,
  uploadOriginalVideo,
};
