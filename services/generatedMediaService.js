const crypto = require('node:crypto');
const storage = require('./mediaStorage.service');
const { persistLocal, fileDigest } = require('./uploadRetryService');

function generatedUploadId({ namespace, ownerId, storeId = '', slot, recipe }) {
  if (!namespace || !ownerId || slot === undefined || !recipe) throw new Error('Generated media requires an owner, slot and versioned recipe.');
  return crypto.createHash('sha256').update(JSON.stringify([String(storeId), namespace, String(ownerId), String(slot), recipe])).digest('hex');
}
async function persistGeneratedFile(file, identity, { video = false, folder = 'reel-imports/candidates' } = {}) {
  const uploadId = generatedUploadId(identity);
  const options = { uploadId, recovering: true, folder };
  if (storage.getStorageProvider()) return (video ? storage.uploadOriginalVideo : storage.uploadGeneratedImage)(file, options);
  const saved = await persistLocal(file, options);
  return { provider: 'local', storageKey: saved.publicId, url: `${String(process.env.PUBLIC_API_URL || 'http://localhost:5000').replace(/\/$/, '')}${saved.url}` };
}
module.exports = { generatedUploadId, persistGeneratedFile, fileDigest };
