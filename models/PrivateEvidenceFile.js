const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', default: null, index: true },
  audience: { type: String, enum: ['STAFF', 'CUSTOMER'], required: true },
  mimeType: { type: String, required: true },
  sizeBytes: { type: Number, required: true },
  digest: { type: String, required: true },
  legacySource: { type: String, select: false },
  purgeStatus: { type: String, enum: ['NONE', 'PENDING', 'PURGED', 'FAILED', 'BLOCKED'], default: 'NONE', index: true },
}, { timestamps: true });
module.exports = mongoose.model('PrivateEvidenceFile', schema);

