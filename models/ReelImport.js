const mongoose = require('mongoose');
const storeIdPlugin = require('./plugins/storeId');

const reelImportStageSchema = new mongoose.Schema({
  key: { type: String, required: true },
  label: { type: String, required: true },
  status: {
    type: String,
    enum: ['running', 'completed', 'failed', 'cancelled'],
    default: 'running',
  },
  percentage: { type: Number, default: 0, min: 0, max: 100 },
  message: { type: String, default: '' },
  attempt: { type: Number, default: 0 },
  startedAt: { type: Date, default: Date.now },
  completedAt: Date,
  durationMs: Number,
  errorCode: String,
}, { _id: false });

const reelImportSchema = new mongoose.Schema({
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  sourceVideo: {
    provider: { type: String, enum: ['r2', 'cloudinary'], required: true },
    storageKey: { type: String, required: true },
    url: { type: String, select: false },
    originalFilename: { type: String, required: true, maxlength: 255 },
    mimeType: { type: String, required: true },
    sizeBytes: { type: Number, required: true },
    durationSeconds: { type: Number, required: true },
    width: Number,
    height: Number,
    codec: String,
  },
  status: {
    type: String,
    enum: ['uploading', 'uploaded', 'queued', 'processing', 'review_required', 'creating_drafts', 'completed', 'failed', 'cancelled'],
    default: 'uploaded',
    index: true,
  },
  progress: {
    percentage: { type: Number, default: 0, min: 0, max: 100 },
    stage: { type: String, default: 'uploading_video' },
    currentStep: { type: String, default: 'Uploading video' },
    message: { type: String, default: '' },
    startedAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  stageHistory: { type: [reelImportStageSchema], default: [] },
  lastHeartbeatAt: { type: Date, default: Date.now, index: true },
  activeRunId: { type: String, default: null, select: false },
  queueJobId: { type: String, default: null },
  processingConfig: {
    framesPerSecond: Number,
    sceneThreshold: Number,
    duplicateThreshold: Number,
    clusteringThreshold: Number,
  },
  statistics: {
    extractedFrames: { type: Number, default: 0 },
    rejectedFrames: { type: Number, default: 0 },
    duplicateFrames: { type: Number, default: 0 },
    candidateFrames: { type: Number, default: 0 },
    detectedProducts: { type: Number, default: 0 },
    createdDrafts: { type: Number, default: 0 },
  },
  error: {
    code: String,
    safeMessage: String,
  },
  cancellationRequested: { type: Boolean, default: false },
  attemptCount: { type: Number, default: 0 },
  startedAt: Date,
  completedAt: Date,
  retentionExpiresAt: { type: Date, index: true },
  sourcePurgedAt: Date,
  purgeLeaseUntil: Date,
  purgeAttemptCount: { type: Number, default: 0 },
  purgeLastError: { type: String, maxlength: 500, default: '' },
}, { timestamps: true });

reelImportSchema.plugin(storeIdPlugin);
reelImportSchema.index({ createdBy: 1, createdAt: -1 });
reelImportSchema.index({ status: 1, createdAt: -1 });
reelImportSchema.index({ status: 1, lastHeartbeatAt: 1 });
reelImportSchema.index({ retentionExpiresAt: 1, sourcePurgedAt: 1, purgeLeaseUntil: 1 }, { name: 'reel_media_cleanup_due' });

module.exports = mongoose.model('ReelImport', reelImportSchema);
