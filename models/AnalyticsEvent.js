const mongoose = require('mongoose');

const EVENT_NAMES = [
  'STORE_VIEW',
  'HOME_SECTION_VIEW',
  'HOME_PRODUCT_CLICK',
  'HOME_CATEGORY_CLICK',
  'HOME_VIEW_ALL',
  'HOME_SCROLL',
  'PRODUCT_VIEW',
  'SEARCH',
  'FILTER_USED',
  'WISHLIST_ADD',
  'ADD_TO_CART',
  'REMOVE_FROM_CART',
  'BEGIN_CHECKOUT',
  'COUPON_APPLIED',
  'BANNER_IMPRESSION',
  'BANNER_CLICK',
  'PAYMENT_STARTED',
  'PAYMENT_SUCCESS',
  'PAYMENT_FAILED',
  'PURCHASE',
  'RETURN_REQUESTED',
  'WHATSAPP_CLICK',
  'INSTAGRAM_SOURCE',
  'ATTRIBUTION_CAPTURE',
  'RENTAL_CTA', 'RENTAL_DATES_CHECK', 'RENTAL_QUOTE_SUCCESS', 'RENTAL_QUOTE_FAILURE', 'RENTAL_HOLD_CREATED', 'RENTAL_PAYMENT_VERIFIED',
];

const EVENT_ALIASES = {
  CHECKOUT_START: 'BEGIN_CHECKOUT',
};

const analyticsEventSchema = new mongoose.Schema({
  storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', index: true },
  name: { type: String, enum: EVENT_NAMES, required: true, index: true },
  sessionId: { type: String, maxlength: 80, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
  path: { type: String, maxlength: 300 },
  searchQuery: { type: String, maxlength: 120 },
  source: { type: String, maxlength: 80 },
  campaign: { type: String, maxlength: 80 },
  reelId: { type: String, maxlength: 80 },
  metadata: mongoose.Schema.Types.Mixed,
  trafficEventId: String,
  expiresAt: Date,
}, { timestamps: true });

analyticsEventSchema.index({ storeId: 1, name: 1, createdAt: -1 });
analyticsEventSchema.index({ storeId: 1, source: 1, createdAt: -1 });
analyticsEventSchema.index({ createdAt: -1 });
analyticsEventSchema.index({ storeId: 1, trafficEventId: 1 }, { unique: true, partialFilterExpression: { trafficEventId: { $type: 'string' } } });
analyticsEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('AnalyticsEvent', analyticsEventSchema);
module.exports.EVENT_ALIASES = EVENT_ALIASES;
module.exports.EVENT_NAMES = EVENT_NAMES;
