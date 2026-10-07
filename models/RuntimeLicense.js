const mongoose = require('mongoose');

const runtimeLicenseSchema = new mongoose.Schema({
  key: { type: String, unique: true, default: 'active', immutable: true },
  installationId: { type: String, index: true },
  payload: { type: String, required: true },
  signature: { type: String, required: true },
  algorithm: { type: String, default: 'Ed25519' },
  checkedAt: { type: Date, default: Date.now },
}, { timestamps: true });

module.exports = mongoose.model('RuntimeLicense', runtimeLicenseSchema);
