const mongoose = require('mongoose');

const storeContentVersionSchema = new mongoose.Schema({
  scopeType: { type: String, enum: ['THEME', 'STORE'], required: true, index: true },
  scopeId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  version: { type: Number, required: true, min: 1 },
  content: { type: mongoose.Schema.Types.Mixed, required: true },
  changes: [{
    path: { type: String, maxlength: 240 },
    before: { type: String, maxlength: 4000 },
    after: { type: String, maxlength: 4000 },
  }],
  note: { type: String, trim: true, maxlength: 240 },
  kind: { type: String, enum: ['BASELINE', 'PUBLISH', 'SCHEDULED'], default: 'PUBLISH', index: true },
  state: { type: String, enum: ['RESERVED', 'PUBLISHED'], default: 'PUBLISHED', index: true },
  releaseId: { type: String, trim: true, maxlength: 80 },
  publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

storeContentVersionSchema.index({ scopeType: 1, scopeId: 1, version: -1 }, { unique: true });
storeContentVersionSchema.index({ releaseId: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('StoreContentVersion', storeContentVersionSchema);
