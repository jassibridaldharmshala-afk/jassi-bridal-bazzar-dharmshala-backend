const mongoose = require('mongoose');
const storeIdPlugin = require('./plugins/storeId');

const categorySchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  slug: { type: String, required: true, trim: true, lowercase: true, maxlength: 120, match: /^[a-z0-9]+(?:-[a-z0-9]+)*$/ },
  previousSlugs: { type: [String], default: [] },
  definitionKey: { type: String, trim: true, maxlength: 50, default: '' },
  parent: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', default: null },
  parentDefinitionKey: { type: String, trim: true, maxlength: 50, default: '' },
  level: { type: Number, default: 0, min: 0, max: 5 },
  attributeOverrides: { type: [mongoose.Schema.Types.Mixed], default: [] },
  variantAttributes: { type: [String], default: [] },
  configuredFilters: { type: [String], default: [] },
  image: { type: String, trim: true, maxlength: 1000 },
  description: { type: String, trim: true, maxlength: 1200 },
  metaTitle: { type: String, trim: true, maxlength: 100 },
  metaDescription: { type: String, trim: true, maxlength: 300 },
  socialImage: { type: String, trim: true, maxlength: 1000 },
  isActive: { type: Boolean, default: true },
  isArchived: { type: Boolean, default: false },
  archivedAt: { type: Date, default: null },
  displayOrder: { type: Number, default: 0, min: 0, max: 9999, validate: Number.isInteger },
}, { timestamps: true });

categorySchema.plugin(storeIdPlugin);
categorySchema.index({ storeId: 1, slug: 1 }, { unique: true });
categorySchema.index({ storeId: 1, definitionKey: 1 });
categorySchema.index({ storeId: 1, parent: 1, displayOrder: 1 });
categorySchema.index({ storeId: 1, isArchived: 1, isActive: 1 });

module.exports = mongoose.model('Category', categorySchema);
