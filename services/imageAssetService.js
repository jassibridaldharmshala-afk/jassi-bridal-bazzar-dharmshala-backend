const mongoose = require('mongoose');
const Asset = require('../models/MediaAsset');
async function registerImageAsset(file, { storeId } = {}) {
  if (mongoose.connection.readyState !== 1 || !file?.url || !String(file.mimeType || '').startsWith('image/')) return;
  const { url, publicId, storageKey, provider, variants = [], width, height, sizeBytes, mimeType } = file;
  await Asset.updateOne({ url }, { $set: { publicId: publicId || storageKey, provider, variants, width, height, sizeBytes, mimeType,
    ...(storeId ? { storeId } : {}), recipe: require('./photoCompressionService').PHOTO_RECIPE } }, { upsert: true });
}
async function imageAsset(url, session) {
  if (!url || mongoose.connection.readyState !== 1) return;
  const known = await Asset.findOne({ $or: [{ url }, { 'variants.url': url }] }).session(session || null).lean();
  if (known) return known;
  // Receipts retain the exact copies of older uploads that predate manifests.
  const receipt = await require('../models/UploadOperation').findOne({ 'files.url': url }).select('files').session(session || null).lean();
  return receipt?.files?.find(file => file?.url === url);
}
async function attachImageMedia(record, fields, session) {
  for (const field of fields) {
    const asset = await imageAsset(record[field], session);
    record[field + 'Media'] = asset ? { url: asset.url, variants: asset.variants, width: asset.width, height: asset.height, sizeBytes: asset.sizeBytes, mimeType: asset.mimeType, provider: asset.provider, publicId: asset.publicId } : undefined;
  }
}
module.exports = { registerImageAsset, imageAsset, attachImageMedia };
