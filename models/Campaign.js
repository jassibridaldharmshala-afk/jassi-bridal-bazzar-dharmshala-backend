const mongoose = require('mongoose');
const storeIdPlugin = require('./plugins/storeId');

const CAMPAIGN_PRESETS = ['FIRST_ORDER', 'FREE_SHIPPING', 'FESTIVAL', 'FLASH', 'CATEGORY', 'BUY_GET', 'REPEAT', 'VIP'];
const CAMPAIGN_STATES = ['DRAFT', 'BUILDING', 'PUBLISHED', 'PAUSED', 'FAILED', 'ARCHIVED'];

const offerSchema = new mongoose.Schema({
  code: { type: String, trim: true, uppercase: true, maxlength: 32 },
  activationMode: { type: String, enum: ['CODE', 'AUTOMATIC'], default: 'CODE' },
  benefitType: { type: String, enum: ['DISCOUNT', 'FREE_SHIPPING', 'BUY_X_GET_Y'], default: 'DISCOUNT' },
  type: { type: String, enum: ['Percentage', 'Flat'], default: 'Percentage' },
  discountValue: { type: Number, default: 10, min: 0 },
  buyQuantity: { type: Number, default: 2, min: 1 },
  getQuantity: { type: Number, default: 1, min: 1 },
  minOrderAmount: { type: Number, default: 0, min: 0 },
  minItemQuantity: { type: Number, default: 0, min: 0 },
  maxDiscountAmount: { type: Number, default: 0, min: 0 },
  usageLimit: { type: Number, default: 0, min: 0 },
  customerLimit: { type: Number, default: 1, min: 0 },
  totalBudget: { type: Number, default: 0, min: 0 },
  customerSegment: { type: String, enum: ['ALL', 'NEW', 'REPEAT', 'VIP', 'INACTIVE', 'SELECTED'], default: 'ALL' },
  minimumPriorOrders: { type: Number, default: 0, min: 0 },
  minimumLifetimeSpend: { type: Number, default: 0, min: 0 },
  inactiveDays: { type: Number, default: 90, min: 1, max: 3650 },
  firstOrderOnly: { type: Boolean, default: false },
  stackingMode: { type: String, enum: ['EXCLUSIVE', 'ALLOW_PRODUCT_OFFERS'], default: 'ALLOW_PRODUCT_OFFERS' },
  scopeMatchMode: { type: String, enum: ['ANY', 'ALL'], default: 'ALL' },
  minimumRequirementBasis: { type: String, enum: ['CART', 'ELIGIBLE_ITEMS'], default: 'CART' },
  restoreOnFullRefund: { type: Boolean, default: false },
  isPublic: { type: Boolean, default: true },
  applicableProducts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
  applicableCategories: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Category' }],
  applicableCustomers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  applicablePincodes: [{ type: String, trim: true }],
  applicablePaymentMethods: [{ type: String }],
  salesChannels: [{ type: String, enum: ['STOREFRONT', 'ADMIN', 'SOCIAL'] }],
}, { _id: false });

const creativeSchema = new mongoose.Schema({
  title: { type: String, trim: true, maxlength: 120 },
  subtitle: { type: String, trim: true, maxlength: 300 },
  buttonText: { type: String, trim: true, maxlength: 60 },
  image: { type: String, trim: true, maxlength: 2048 },
  tabletImage: { type: String, trim: true, maxlength: 2048 },
  mobileImage: { type: String, trim: true, maxlength: 2048 },
  altText: { type: String, trim: true, maxlength: 180 },
  focalPoint: { type: String, enum: ['center', 'top', 'bottom', 'left', 'right'], default: 'center' },
  type: { type: String, enum: ['Hero', 'Offer', 'Category', 'Sale'], default: 'Sale' },
  position: { type: String, enum: ['Home - Top', 'Home - Middle', 'Home - Bottom', 'Cart - Bottom', 'Category - Featured', 'Offer Strip'], default: 'Home - Middle' },
  destinationType: { type: String, enum: ['CUSTOM', 'PRODUCT', 'CATEGORY', 'COLLECTION', 'COUPON'], default: 'CUSTOM' },
  destinationValue: { type: String, trim: true, maxlength: 300 },
  link: { type: String, trim: true, maxlength: 1000 },
  displayOrder: { type: Number, default: 0, min: 0 },
}, { _id: false });

const campaignSchema = new mongoose.Schema({
  key: { type: String, required: true, trim: true, lowercase: true, maxlength: 80 },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  preset: { type: String, enum: CAMPAIGN_PRESETS, default: 'FESTIVAL' },
  state: { type: String, enum: CAMPAIGN_STATES, default: 'DRAFT', index: true },
  offer: { type: offerSchema, default: () => ({}) },
  creative: { type: creativeSchema, default: () => ({}) },
  startsAt: Date,
  endsAt: Date,
  timezone: { type: String, trim: true, maxlength: 80, default: 'Asia/Kolkata' },
  coupon: { type: mongoose.Schema.Types.ObjectId, ref: 'Coupon' },
  banners: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Banner' }],
  idempotencyKey: { type: String, trim: true, maxlength: 100 },
  lastError: { type: String, trim: true, maxlength: 500 },
  lastSyncedAt: Date,
  publishedAt: Date,
  pausedAt: Date,
  archivedAt: Date,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  revision: { type: Number, default: 0, min: 0 },
}, { timestamps: true });

campaignSchema.plugin(storeIdPlugin);
campaignSchema.index({ storeId: 1, key: 1 }, { unique: true });
campaignSchema.index({ storeId: 1, state: 1, startsAt: 1, endsAt: 1, createdAt: -1 });
campaignSchema.index({ storeId: 1, idempotencyKey: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('Campaign', campaignSchema);
module.exports.CAMPAIGN_PRESETS = CAMPAIGN_PRESETS;
module.exports.CAMPAIGN_STATES = CAMPAIGN_STATES;
