const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  name: { type: String, required: true, maxlength: 80 },
  key: { type: String, required: true, trim: true, lowercase: true, maxlength: 40 },
  isActive: { type: Boolean, default: true, index: true },
  archivedAt: { type: Date, default: null, index: true },
  archivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  isBuiltinCopy: { type: Boolean, default: false },
  structure: { type: mongoose.Schema.Types.Mixed, required: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  revision: { type: Number, default: 1, min: 1 },
}, { timestamps: true });
schema.index({ key: 1 }, { unique: true, partialFilterExpression: { key: { $type: 'string' } } });
schema.pre('validate', function ensureKey(next) {
  if (!this.key && this.name) this.key = String(this.name).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  next();
});
module.exports = mongoose.model('IndustryPreset', schema);
