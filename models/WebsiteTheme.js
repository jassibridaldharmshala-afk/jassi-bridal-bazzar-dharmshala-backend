const mongoose = require('mongoose');

const websiteThemeSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  slug: { type: String, required: true, trim: true, lowercase: true },
  preset: { type: String, default: 'default' },
  draftConfig: { type: mongoose.Schema.Types.Mixed, required: true },
  publishedConfig: { type: mongoose.Schema.Types.Mixed },
  isActive: { type: Boolean, default: false },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  publishedAt: Date,
  scheduledConfig: mongoose.Schema.Types.Mixed,
  scheduledFor: { type: Date, index: true },
  scheduledNote: { type: String, maxlength: 240 },
  scheduledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  scheduledContent: mongoose.Schema.Types.Mixed,
  scheduledContentId: { type: String, trim: true, maxlength: 80, index: true },
  scheduledContentFor: { type: Date, index: true },
  scheduledContentNote: { type: String, maxlength: 240 },
  scheduledContentBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  scheduledContentStatus: { type: String, enum: ['SCHEDULED', 'PROCESSING', 'FAILED'], default: undefined },
  scheduledContentAttempts: { type: Number, min: 0, default: undefined },
  scheduledContentLeaseUntil: Date,
  scheduledContentLastAttemptAt: Date,
  scheduledContentError: { type: String, maxlength: 500 },
}, { timestamps: true, optimisticConcurrency: true });

websiteThemeSchema.index({ slug: 1 }, { unique: true });
websiteThemeSchema.index({ isActive: 1 }, { unique: true, partialFilterExpression: { isActive: true } });

module.exports = mongoose.model('WebsiteTheme', websiteThemeSchema);
