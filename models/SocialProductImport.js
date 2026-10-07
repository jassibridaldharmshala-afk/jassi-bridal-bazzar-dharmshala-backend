const mongoose = require('mongoose');
const socialImportSchema = new mongoose.Schema({
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store' },
  sourceUrl: { type: String, required: true }, resolvedUrl: String,
  sourceKey: { type: String, required: true, unique: true },
  platform: { type: String, enum: ['instagram', 'facebook'], required: true },
  status: { type: String, enum: ['queued', 'reading', 'media', 'analyzing', 'ready', 'failed', 'cancelled'], default: 'queued', index: true },
  stage: { type: String, default: 'Waiting to start' }, progress: { type: Number, default: 0 },
  runId: String, attempts: { type: Number, default: 0 }, errorCode: String, error: String,
  caption: String, method: String, warnings: [String], suggestion: mongoose.Schema.Types.Mixed,
  images: [{ _id: false, id: String, url: String, publicId: String, provider: String, kind: String, timestamp: Number,
    qualityScore: Number, sharpnessScore: Number, exposureScore: Number, recommended: Boolean, recommendedCover: Boolean,
    viewType: String, qualityWarnings: [String], width: Number, height: Number, selectionVersion: String }],
  frameSelections: [{ _id: false, analyzedFrames: Number, rejectedFrames: Number, duplicateFrames: Number, candidateFrames: Number, recommendedFrames: Number, selectionVersion: String, viewAnalysis: String }],
  videos: [{ _id: false, id: String, url: String, publicId: String, provider: String, thumbnail: String }],
  draftId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductDraft' },
}, { timestamps: true });
socialImportSchema.index({ createdBy: 1, createdAt: -1 });
module.exports = mongoose.model('SocialProductImport', socialImportSchema);
