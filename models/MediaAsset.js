const mongoose = require('mongoose');
// Upload manifest: dimensions/byte sizes and the exact copies of one photo.
const schema = new mongoose.Schema({
  url: { type: String, required: true, unique: true },
  publicId: String, provider: String, storeId: mongoose.Schema.Types.ObjectId,
  variants: { type: [mongoose.Schema.Types.Mixed], default: [] },
  width: Number, height: Number, sizeBytes: Number, mimeType: String, recipe: String,
}, { timestamps: true });
schema.index({ 'variants.url': 1 });
module.exports = mongoose.model('MediaAsset', schema);
