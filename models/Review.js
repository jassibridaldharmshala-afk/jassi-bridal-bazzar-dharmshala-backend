const mongoose = require('mongoose');
const storeIdPlugin = require('./plugins/storeId');

const reviewSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
  rating: { type: Number, min: 1, max: 5, required: true },
  title: String,
  comment: String,
  photos: [{ type: String, maxlength: 2048 }],
  verifiedPurchase: { type: Boolean, default: false },
  isVisible: { type: Boolean, default: true },
  moderationStatus: { type: String, enum: ['PENDING', 'PUBLISHED', 'HIDDEN', 'REJECTED', 'ARCHIVED'], default: 'PUBLISHED', index: true },
  moderationReason: { type: String, maxlength: 300, default: '' },
  moderationNote: { type: String, maxlength: 1000, default: '', select: false },
  moderatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  moderatedAt: Date,
  archivedAt: Date,
  withdrawnAt: Date,
  editedAt: Date,
  isFeatured: { type: Boolean, default: false, index: true },
  merchantReply: {
    body: { type: String, maxlength: 1000 },
    repliedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    repliedAt: Date,
    editedAt: Date,
  },
  merchantReplyHistory: {
    type: [{
      body: { type: String, maxlength: 1000 },
      action: { type: String, enum: ['PUBLISHED', 'UPDATED', 'REMOVED'], required: true },
      actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      at: { type: Date, default: Date.now },
    }],
    select: false,
    default: undefined,
  },
  aspects: {
    quality: { type: Number, min: 1, max: 5 },
    fit: { type: Number, min: 1, max: 5 },
    colorAccuracy: { type: Number, min: 1, max: 5 },
  },
  recommend: Boolean,
  purchase: {
    size: { type: String, maxlength: 80 },
    color: { type: String, maxlength: 80 },
    variantId: { type: String, maxlength: 160 },
  },
  sentiment: { type: String, enum: ['POSITIVE', 'NEUTRAL', 'NEGATIVE'], default: 'NEUTRAL', index: true },
  topics: [{ type: String, maxlength: 40 }],
  riskSignals: [{ type: String, maxlength: 60 }],
  reportCount: { type: Number, default: 0, min: 0 },
  helpfulBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', select: false }],
  helpfulCount: { type: Number, default: 0, min: 0 },
}, { timestamps: true });

reviewSchema.plugin(storeIdPlugin);
reviewSchema.index({ user: 1, product: 1 }, { unique: true });
reviewSchema.index({ product: 1, isVisible: 1, createdAt: -1 });
reviewSchema.index({ storeId: 1, createdAt: -1 });
reviewSchema.index({ storeId: 1, moderationStatus: 1, createdAt: -1 });
reviewSchema.index({ storeId: 1, rating: 1, createdAt: -1 });

module.exports = mongoose.model('Review', reviewSchema);
