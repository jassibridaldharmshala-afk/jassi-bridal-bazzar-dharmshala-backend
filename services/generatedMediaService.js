const crypto = require('node:crypto');
const storage = require('./mediaStorage.service');
const { persistLocal, fileDigest } = require('./uploadRetryService');

function generatedUploadId({ namespace, ownerId, storeId = '', slot, recipe }) {
  if (!namespace || !ownerId || slot === undefined || !recipe) throw new Error('Generated media requires an owner, slot and versioned recipe.');
  return crypto.createHash('sha256').update(JSON.stringify([String(storeId), namespace, String(ownerId), String(slot), recipe])).digest('hex');
}
async function persistGeneratedFile(file, identity, { video = false, responsive = true, folder = 'reel-imports/candidates' } = {}) {
  const uploadId = generatedUploadId(identity);
  const options = { uploadId, recovering: true, folder, responsive };
  if (storage.getStorageProvider()) return (video ? storage.uploadOriginalVideo : storage.uploadGeneratedImage)(file, options);
  if (!video) file = await require('./photoCompressionService').preparePhotoFile(file);
  const saved = await persistLocal(file, options);
  const publicBase = String(process.env.PUBLIC_API_URL || 'http://localhost:5000').replace(/\/$/, '');
  const variants = [];
  if (!video && responsive) for (const variant of await require('./photoCompressionService').responsivePhotoVariants(file)) {
    const derivativeId = crypto.createHash('sha256').update(uploadId + ':display-v1:' + variant.width).digest('hex');
    const display = await persistLocal(variant, { ...options, uploadId: derivativeId });
    variants.push({ ...display, provider: 'local', url: publicBase + display.url, width: variant.width, height: variant.height, mimeType: variant.mimetype, sizeBytes: variant.size });
  }
  return { provider: 'local', storageKey: saved.publicId, url: publicBase + saved.url, ...(video ? {} : { variants, width: file.photo?.width, height: file.photo?.height, mimeType: file.mimetype, sizeBytes: file.size }) };
}
module.exports = { generatedUploadId, persistGeneratedFile, fileDigest };
