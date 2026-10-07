const mongoose = require('mongoose');
const storeIdPlugin = require('./plugins/storeId');

const couponSchema = new mongoose.Schema({
  code: { type: String, required: true, uppercase: true, trim: true },
  title: { type: String, trim: true, maxlength: 120 },
  description: { type: String, trim: true, maxlength: 500 },
  terms: { type: String, trim: true, maxlength: 1200 },
  activationMode: { type: String, enum: ['CODE', 'AUTOMATIC'], default: 'CODE' },
  benefitType: { type: String, enum: ['DISCOUNT', 'FREE_SHIPPING', 'BUY_X_GET_Y'], default: 'DISCOUNT' },
  type: { type: String, enum: ['Percentage', 'Flat'], required: true },
  discountValue: { type: Number, required: true, default: 0, min: 0 },
  buyQuantity: { type: Number, default: 1, min: 1 },
  getQuantity: { type: Number, default: 1, min: 1 },
  minOrderAmount: { type: Number, default: 0 },
  minItemQuantity: { type: Number, default: 0, min: 0 },
  maxDiscountAmount: Number,
  // Optional start date; when unset the coupon is live as soon as it is active.
  validFrom: Date,
  expiryDate: Date,
  usageLimit: Number,
  usedCount: { type: Number, default: 0 },
  totalBudget: Number,
  spentAmount: { type: Number, default: 0, min: 0 },
  priority: { type: Number, default: 0 },
  // ALLOW keeps historic offers working; EXCLUSIVE deliberately limits the
  // coupon to full-price lines.
  stackingMode: { type: String, enum: ['EXCLUSIVE', 'ALLOW_PRODUCT_OFFERS'], default: 'ALLOW_PRODUCT_OFFERS' },
  // Empty means "usable with any payment method".
  applicablePaymentMethods: [{ type: String }],
  applicableProducts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
  applicableCategories: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Category' }],
  // When products and categories are both selected, ALL preserves the legacy
  // intersection behaviour while ANY allows either selection to qualify.
  scopeMatchMode: { type: String, enum: ['ANY', 'ALL'], default: 'ALL' },
  minimumRequirementBasis: { type: String, enum: ['CART', 'ELIGIBLE_ITEMS'], default: 'CART' },
  applicableCustomers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  applicablePincodes: [{ type: String, trim: true }],
  salesChannels: [{ type: String, enum: ['STOREFRONT', 'ADMIN', 'SOCIAL'] }],
  customerSegment: { type: String, enum: ['ALL', 'NEW', 'REPEAT', 'VIP', 'INACTIVE', 'SELECTED'], default: 'ALL' },
  minimumPriorOrders: { type: Number, default: 0, min: 0 },
  minimumLifetimeSpend: { type: Number, default: 0, min: 0 },
  inactiveDays: { type: Number, default: 90, min: 1, max: 3650 },
  customerLimit: Number,
  firstOrderOnly: { type: Boolean, default: false },
  restoreOnFullRefund: { type: Boolean, default: false },
  campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', index: true },
  isPublic: { type: Boolean, default: true },
  isActive: { type: Boolean, default: true },
  isArchived: { type: Boolean, default: false },
  archivedAt: Date,
  revision: { type: Number, default: 0, min: 0 },
}, { timestamps: true });

couponSchema.plugin(storeIdPlugin);
couponSchema.index({ storeId: 1, code: 1 }, { unique: true });
couponSchema.index({ storeId: 1, isArchived: 1, isActive: 1, validFrom: 1, expiryDate: 1, priority: -1 });

module.exports = mongoose.model('Coupon', couponSchema);
