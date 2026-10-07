const mongoose = require('mongoose');
const storeIdPlugin = require('./plugins/storeId');

const BANNER_TYPES = ['Hero', 'Offer', 'Category', 'Sale'];
const BANNER_POSITIONS = ['Home - Top', 'Home - Middle', 'Home - Bottom', 'Cart - Bottom', 'Category - Featured', 'Offer Strip'];
const DESTINATION_TYPES = ['CUSTOM', 'PRODUCT', 'CATEGORY', 'COLLECTION', 'COUPON'];

const bannerSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 120 },
  subtitle: { type: String, trim: true, maxlength: 300 },
  image: { type: String, required: true, trim: true, maxlength: 2048 },
  tabletImage: { type: String, trim: true, maxlength: 2048 },
  mobileImage: { type: String, trim: true, maxlength: 2048 },
  altText: { type: String, trim: true, maxlength: 180 },
  focalPoint: { type: String, enum: ['center', 'top', 'bottom', 'left', 'right'], default: 'center' },
  buttonText: { type: String, trim: true, maxlength: 60 },
  link: { type: String, trim: true, maxlength: 1000 },
  destinationType: { type: String, enum: DESTINATION_TYPES, default: 'CUSTOM' },
  destinationValue: { type: String, trim: true, maxlength: 300 },
  campaignKey: { type: String, trim: true, lowercase: true, maxlength: 80 },
  campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', index: true },
  couponCode: { type: String, trim: true, uppercase: true, maxlength: 32 },
  type: { type: String, enum: BANNER_TYPES, default: 'Hero' },
  position: {
    type: String,
    enum: BANNER_POSITIONS,
    default: 'Home - Top',
  },
  startsAt: Date,
  endsAt: Date,
  isActive: { type: Boolean, default: true },
  isArchived: { type: Boolean, default: false },
  archivedAt: Date,
  displayOrder: { type: Number, default: 0, min: 0 },
  views: { type: Number, default: 0 },
  impressions: { type: Number, default: 0, min: 0 },
  clicks: { type: Number, default: 0, min: 0 },
  revision: { type: Number, default: 0, min: 0 },
}, { timestamps: true });

bannerSchema.plugin(storeIdPlugin);
bannerSchema.index({ storeId: 1, isActive: 1, displayOrder: 1 });
bannerSchema.index({ storeId: 1, position: 1, isArchived: 1, isActive: 1, startsAt: 1, endsAt: 1, displayOrder: 1 });
bannerSchema.index({ storeId: 1, campaignKey: 1 }, { sparse: true });

module.exports = mongoose.model('Banner', bannerSchema);
module.exports.BANNER_TYPES = BANNER_TYPES;
module.exports.BANNER_POSITIONS = BANNER_POSITIONS;
module.exports.DESTINATION_TYPES = DESTINATION_TYPES;
