const mongoose = require('mongoose');
const storeIdPlugin = require('./plugins/storeId');

const couponCustomerUsageSchema = new mongoose.Schema({
  coupon: { type: mongoose.Schema.Types.ObjectId, ref: 'Coupon', required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  usedCount: { type: Number, default: 0, min: 0 },
  firstOrderClaim: { type: Boolean, default: false },
}, { timestamps: true });

couponCustomerUsageSchema.plugin(storeIdPlugin);
couponCustomerUsageSchema.index({ storeId: 1, coupon: 1, user: 1 }, { unique: true });
couponCustomerUsageSchema.index(
  { storeId: 1, user: 1, firstOrderClaim: 1 },
  { unique: true, partialFilterExpression: { firstOrderClaim: true, usedCount: { $gt: 0 } } },
);

module.exports = mongoose.model('CouponCustomerUsage', couponCustomerUsageSchema);
