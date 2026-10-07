const mongoose = require('mongoose');

// A receipt, not a second copy of the media. No credentials or file bytes.
const schema = new mongoose.Schema({
  _id: String,
  fingerprint: { type: String, required: true },
  fileCount: Number,
  fields: mongoose.Schema.Types.Mixed,
  query: mongoose.Schema.Types.Mixed,
  storage: String,
  status: { type: String, enum: ['PENDING', 'RUNNING', 'COMPLETE', 'REMOVED'], default: 'PENDING' },
  owner: String,
  leaseUntil: Date,
  attempts: { type: Number, default: 0 },
  files: { type: [mongoose.Schema.Types.Mixed], default: [] },
  result: mongoose.Schema.Types.Mixed,
  recordId: { type: String, index: true },
}, { timestamps: true, versionKey: false });
schema.index({ 'files.provider': 1, 'files.publicId': 1 });
module.exports = mongoose.model('UploadOperation', schema);
