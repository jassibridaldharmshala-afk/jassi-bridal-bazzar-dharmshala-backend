const mongoose = require('mongoose');

const frameSchema = new mongoose.Schema({
  provider: { type: String, enum: ['r2', 'cloudinary'] },
  storageKey: String,
  url: String,
  timestampSeconds: Number,
  qualityScore: Number,
  sharpnessScore: Number,
  exposureScore: Number,
  visibilityScore: Number,
  selected: { type: Boolean, default: false },
  rejectionReasons: [String],
  recommended: Boolean,
  recommendedCover: Boolean,
  viewType: String,
  qualityWarnings: [String],
  width: Number,
  height: Number,
  selectionVersion: String,
}, { _id: true });

const reelCandidateSchema = new mongoose.Schema({
  job: { type: mongoose.Schema.Types.ObjectId, ref: 'ReelImport', required: true, index: true },
  groupNumber: { type: Number, required: true },
  status: {
    type: String,
    enum: ['suggested', 'approved', 'ignored', 'merged', 'draft_created'],
    default: 'suggested',
  },
  sourceRange: {
    startSeconds: Number,
    endSeconds: Number,
  },
  frames: [frameSchema],
  suggestions: {
    name: String,
    category: String,
    categoryName: String,
    subcategory: String,
    primaryColor: String,
    secondaryColors: [String],
    pattern: String,
    fabric: String,
    occasion: [String],
    tags: [String],
    altText: String,
    shortDescription: String,
    description: String,
    price: Number,
    originalPrice: Number,
    sizes: [String],
    sizeChart: mongoose.Schema.Types.Mixed,
    attributeValues: mongoose.Schema.Types.Mixed,
    fieldSources: mongoose.Schema.Types.Mixed,
    multipleProducts: Boolean,
    priceAmbiguous: Boolean,
    sizingMode: { type: String, enum: ['confirm', 'sized', 'free-size'], default: 'confirm' },
  },
  confidence: {
    name: Number,
    category: Number,
    primaryColor: Number,
    pattern: Number,
    fabric: Number,
    occasion: Number,
    overall: Number,
  },
  analysis: {
    status: {
      type: String,
      enum: ['pending', 'completed', 'failed', 'unavailable'],
      default: 'pending',
    },
    source: String,
    model: String,
    analyzedAt: Date,
    error: String,
    errorCode: String,
  },
  adminOverrides: { type: mongoose.Schema.Types.Mixed, default: {} },
  productDraft: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductDraft', default: null },
  mergedFrom: [{ type: mongoose.Schema.Types.ObjectId, ref: 'ReelCandidate' }],
  mergedInto: { type: mongoose.Schema.Types.ObjectId, ref: 'ReelCandidate', default: null },
  audit: [{
    action: String,
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    at: { type: Date, default: Date.now },
    details: mongoose.Schema.Types.Mixed,
  }],
}, { timestamps: true });

reelCandidateSchema.index({ job: 1, groupNumber: 1 }, { unique: true });
reelCandidateSchema.index({ job: 1, status: 1 });

module.exports = mongoose.model('ReelCandidate', reelCandidateSchema);
