const couponService = require('../services/couponService');

/**
 * @deprecated Use couponService.consumeCoupon. Kept as a thin wrapper so any
 * leftover caller still goes through the usage-limit-safe path.
 */
async function incrementCouponUsage(couponCode, options) {
  return couponService.consumeCoupon(couponCode, options);
}

module.exports = {
  incrementCouponUsage,
};
