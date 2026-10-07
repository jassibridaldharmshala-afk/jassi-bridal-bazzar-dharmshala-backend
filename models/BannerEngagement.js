const mongoose = require('mongoose');

const bannerEngagementSchema = new mongoose.Schema({
  storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', index: true },
  banner: { type: mongoose.Schema.Types.ObjectId, ref: 'Banner', required: true, index: true },
  event: { type: String, enum: ['impression'], required: true },
  sessionHash: { type: String, required: true, maxlength: 64 },
  day: { type: String, required: true, maxlength: 10 },
}, { timestamps: true });

bannerEngagementSchema.index(
  { storeId: 1, banner: 1, event: 1, sessionHash: 1, day: 1 },
  { unique: true },
);
bannerEngagementSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

module.exports = mongoose.model('BannerEngagement', bannerEngagementSchema);
