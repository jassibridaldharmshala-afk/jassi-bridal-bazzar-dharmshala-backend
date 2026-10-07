const mongoose = require('mongoose');

// Minimal publication receipt: no draft content or media. Keeps imports and
// retries idempotent after the owner removes a published draft record.
const schema = new mongoose.Schema({
  draftId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
  productId: { type: mongoose.Schema.Types.ObjectId, required: true },
  storeId: mongoose.Schema.Types.ObjectId,
  sourceSocialImportId: { type: mongoose.Schema.Types.ObjectId, unique: true, sparse: true },
  sourceCandidateId: { type: mongoose.Schema.Types.ObjectId, unique: true, sparse: true },
  deletedBy: mongoose.Schema.Types.ObjectId,
  deletedAt: { type: Date, default: Date.now },
}, { versionKey: false });

module.exports = mongoose.model('DeletedProductDraft', schema);
