const mongoose = require('mongoose');
const storeIdPlugin = require('./plugins/storeId');

const optionDefinitionSchema = new mongoose.Schema({
  key: { type: String, required: true, trim: true, maxlength: 60 },
  label: { type: String, required: true, trim: true, maxlength: 80 },
  displayType: { type: String, enum: ['text', 'swatch', 'image'], default: 'text' },
}, { _id: false });

const memberSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  optionValues: { type: Map, of: String, default: {} },
  swatch: { type: String, trim: true, maxlength: 120, default: '' },
  sortOrder: { type: Number, min: 0, max: 10000, default: 0 },
  isActive: { type: Boolean, default: true },
}, { _id: false });

const variantGroupSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  slug: { type: String, required: true, trim: true, maxlength: 160 },
  baseProduct: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
  products: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
  optionDefinitions: { type: [optionDefinitionSchema], default: [] },
  members: { type: [memberSchema], default: [] },
  // Kept for existing groups and integrations. New responses derive these
  // summaries from every member instead of treating them as the source of truth.
  colors: [String],
  sizes: [String],
  isActive: { type: Boolean, default: true },
  isArchived: { type: Boolean, default: false, index: true },
  archivedAt: Date,
  revision: { type: Number, default: 0, min: 0 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  lastSavedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

variantGroupSchema.plugin(storeIdPlugin);
variantGroupSchema.index({ storeId: 1, slug: 1 }, {
  unique: true,
  partialFilterExpression: { storeId: { $type: 'objectId' } },
});
variantGroupSchema.index({ storeId: 1, isArchived: 1, isActive: 1, updatedAt: -1 });

module.exports = mongoose.model('VariantGroup', variantGroupSchema);
