const crypto = require('node:crypto');
const storage = require('./mediaStorage.service');
const { fileDigest } = require('./uploadRetryService');

function generatedUploadId({ namespace, ownerId, storeId = '', slot, recipe }) {
  if (!namespace || !ownerId || slot === undefined || !recipe) throw new Error('Generated media requires an owner, slot and versioned recipe.');
  return crypto.createHash('sha256').update(JSON.stringify([String(storeId), namespace, String(ownerId), String(slot), recipe])).digest('hex');
}
async function persistGeneratedFile(file, identity, { video = false, responsive = true, folder = 'reel-imports/candidates' } = {}) {
  // Encoding changes must not replay an older, larger stored image. Video
  // identities stay stable because their encoding has not changed.
  const uploadId = generatedUploadId(video ? identity : { ...identity, recipe: [identity.recipe, require('./photoCompressionService').PHOTO_RECIPE] });
  const options = { uploadId, recovering: true, folder, responsive, storeId: identity.storeId };
  storage.assertStorageConfigured();
  return (video ? storage.uploadOriginalVideo : storage.uploadGeneratedImage)(file, options);
}
module.exports = { generatedUploadId, persistGeneratedFile, fileDigest };
