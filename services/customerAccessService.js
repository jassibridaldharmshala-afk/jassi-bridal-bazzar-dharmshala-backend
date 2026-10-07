const CustomerCrm = require('../models/CustomerCrm');
const { ApiError } = require('../utils/apiError');

function activeRestrictions(profile) {
  const restrictions = profile?.restrictions || {};
  if (restrictions.expiresAt && new Date(restrictions.expiresAt) <= new Date()) return {};
  return restrictions;
}

async function getCustomerRestrictions({ storeId, userId }) {
  if (!storeId || !userId) return {};
  const profile = await CustomerCrm.findOne({ storeId, user: userId }).select('restrictions').lean();
  return activeRestrictions(profile);
}

async function assertCustomerCanCheckout({ storeId, userId, paymentMethod }) {
  const restrictions = await getCustomerRestrictions({ storeId, userId });
  const reason = String(restrictions.reason || '').trim();
  if (restrictions.checkoutRestricted) {
    throw new ApiError('CHECKOUT_RESTRICTED', reason ? `Checkout is unavailable for this account: ${reason}` : 'Checkout is unavailable for this account. Please contact store support.', { statusCode: 403 });
  }
  if (restrictions.codRestricted && String(paymentMethod || '').trim().toUpperCase() === 'COD') {
    throw new ApiError('COD_RESTRICTED', reason ? `Cash on Delivery is unavailable for this account: ${reason}` : 'Cash on Delivery is unavailable for this account. Please choose a prepaid payment method.', { statusCode: 403 });
  }
  return restrictions;
}

function applyCustomerRestrictionsToPaymentOptions(options = [], restrictions = {}) {
  return options.map((option) => {
    if (option.key !== 'COD' || !restrictions.codRestricted) return option;
    return { ...option, enabled: false, disabledReason: 'Cash on Delivery is unavailable for this account. Please choose a prepaid payment method.' };
  });
}

module.exports = { activeRestrictions, applyCustomerRestrictionsToPaymentOptions, assertCustomerCanCheckout, getCustomerRestrictions };
