const Settings = require('../models/Settings');
const { ApiError } = require('../utils/apiError');

/**
 * Turns the admin Settings document into the checkout rules the backend
 * enforces and the frontend renders. Both sides read the same source so a
 * hidden button and a rejected request always agree.
 */

const ONLINE_METHODS = [
  { key: 'UPI', label: 'UPI', settingKey: 'upiEnabled' },
  { key: 'CARD', label: 'Credit / Debit Card', settingKey: 'cardPaymentEnabled' },
  { key: 'NETBANKING', label: 'Net Banking', settingKey: 'netBankingEnabled' },
  { key: 'WALLET', label: 'Wallet', settingKey: 'walletEnabled' },
];

async function getStoreSettings(tenantFilter = {}) {
  return (await Settings.findOne(tenantFilter || {}).lean()) || {};
}

function isOnlineMethod(method) {
  return ONLINE_METHODS.some((option) => option.key === method);
}

function codCharge(settings) {
  return Math.max(0, Number(settings?.codCharge || 0));
}

function codMaxAmount(settings) {
  const max = Number(settings?.codMaxAmount || 0);
  return max > 0 ? max : null;
}

function codMinAmount(settings) {
  return Math.max(0, Number(settings?.codMinAmount || 0));
}

function codPincodeAllowed(settings, pincode) {
  const allowed = Array.isArray(settings?.codPincodes) ? settings.codPincodes.map((item) => String(item).replace(/\D/g, '')).filter(Boolean) : [];
  if (!allowed.length) return true;
  const pin = String(pincode || '').replace(/\D/g, '');
  if (!pin) return true;
  return allowed.includes(pin);
}

function resolvePrepaidDiscount(method, amount, settings) {
  if (!isOnlineMethod(method)) return 0;
  const value = Number(settings?.prepaidDiscountValue || 0);
  if (value <= 0) return 0;
  const base = Math.max(0, Number(amount || 0));
  if (settings?.prepaidDiscountType === 'Percentage') {
    return Math.round(Math.min(base, (base * value) / 100) * 100) / 100;
  }
  if (settings?.prepaidDiscountType === 'Flat') {
    return Math.round(Math.min(base, value) * 100) / 100;
  }
  return 0;
}

async function customerRtoBlocked(userId, settings, tenantFilter = {}) {
  if (!userId) return false;
  if (settings?.smartCodVerificationEnabled !== false) {
    const decision = await require('./codVerificationService').evaluateCodVerification({
      paymentMethod: 'COD', userId, storeId: settings?.storeId || tenantFilter?.storeId, settings, phoneVerified: true,
    });
    if (!decision.codAllowed) return true;
  }
  if (settings?.rtoBlockEnabled !== true) return false;
  const minOrders = Number(settings?.rtoBlockMinOrders || 0);
  const threshold = Number(settings?.rtoBlockThreshold || 0);
  if (minOrders <= 0 || threshold <= 0) return false;
  const Order = require('../models/Order');
  const { andFilter } = require('./storeService');
  const orders = await Order.find(andFilter({ user: userId, orderStatus: { $ne: 'Cancelled' } }, tenantFilter)).select('_id').lean();
  const total = orders.length;
  if (total < minOrders) return false;
  const Shipment = require('../models/Shipment');
  const returnedToOrigin = await Shipment.countDocuments(andFilter({ order: { $in: orders.map((order) => order._id) }, status: { $in: ['RTO_IN_TRANSIT', 'RETURNED'] } }, tenantFilter));
  return (returnedToOrigin / total) >= threshold;
}

/**
 * Razorpay must be both enabled by the admin and actually configured with
 * keys, otherwise the customer would pick a method that cannot complete.
 */
function razorpayUsable(settings, { razorpayConfigured }) {
  return Boolean(settings?.razorpayEnabled) && Boolean(razorpayConfigured);
}

function razorpayDisabledReason(settings, { razorpayConfigured }) {
  if (!settings?.razorpayEnabled) return 'Online payments are turned off by the store';
  if (!razorpayConfigured) return 'Online payment setup is incomplete';
  return '';
}

function buildPaymentOptions(settings, { razorpayConfigured, orderAmount = null, pincode = '', userId = null } = {}) {
  const online = razorpayUsable(settings, { razorpayConfigured });
  const maxCod = codMaxAmount(settings);
  const minCod = codMinAmount(settings);
  const amount = orderAmount === null ? null : Number(orderAmount);
  const codOverLimit = maxCod !== null && amount !== null && amount > maxCod;
  const codUnderMin = minCod > 0 && amount !== null && amount < minCod;
  const pincodeBlocked = !codPincodeAllowed(settings, pincode);

  const options = ONLINE_METHODS
    .filter((option) => settings?.[option.settingKey] !== false)
    .map((option) => ({
      key: option.key,
      label: option.label,
      enabled: online,
      provider: 'Razorpay',
      disabledReason: online ? '' : razorpayDisabledReason(settings, { razorpayConfigured }),
      prepaidDiscount: resolvePrepaidDiscount(option.key, amount || 0, settings),
    }));

  if (settings?.codEnabled !== false) {
    const disabledReason = codOverLimit
      ? `Cash on Delivery is available on orders up to Rs. ${maxCod}`
      : codUnderMin
        ? `Cash on Delivery is available on orders of Rs. ${minCod} or more`
        : pincodeBlocked
          ? 'Cash on Delivery is not available for this pincode'
          : '';
    options.push({
      key: 'COD',
      label: 'Cash on Delivery',
      enabled: !codOverLimit && !codUnderMin && !pincodeBlocked,
      provider: 'COD',
      charge: codCharge(settings),
      maxAmount: maxCod,
      minAmount: minCod || null,
      disabledReason,
    });
  }

  return options;
}

async function applyCustomerRtoToPaymentOptions(options, { userId, settings, tenantFilter = {} } = {}) {
  if (!(await customerRtoBlocked(userId, settings, tenantFilter))) return options;
  return options.map((option) => option.key === 'COD' ? {
    ...option,
    enabled: false,
    disabledReason: 'Cash on Delivery is unavailable on this account. Please pay online.',
  } : option);
}

/**
 * Server-side gate. Mirrors buildPaymentOptions so a hand-crafted request for
 * a hidden method is rejected instead of silently accepted.
 */
async function assertPaymentMethodAllowed(method, settings, { razorpayConfigured, orderAmount = null, pincode = '', userId = null, tenantFilter = {} } = {}) {
  if (method === 'COD') {
    if (settings?.codEnabled === false) {
      throw new ApiError('PAYMENT_METHOD_UNAVAILABLE', 'Cash on Delivery is currently unavailable');
    }
    const maxCod = codMaxAmount(settings);
    const minCod = codMinAmount(settings);
    if (maxCod !== null && orderAmount !== null && Number(orderAmount) > maxCod) {
      throw new ApiError('PAYMENT_METHOD_UNAVAILABLE', `Cash on Delivery is available on orders up to Rs. ${maxCod}. Please choose online payment.`);
    }
    if (minCod > 0 && orderAmount !== null && Number(orderAmount) < minCod) {
      throw new ApiError('PAYMENT_METHOD_UNAVAILABLE', `Cash on Delivery is available on orders of Rs. ${minCod} or more.`);
    }
    if (!codPincodeAllowed(settings, pincode)) {
      throw new ApiError('PAYMENT_METHOD_UNAVAILABLE', 'Cash on Delivery is not available for this delivery pincode.');
    }
    if (await customerRtoBlocked(userId, settings, tenantFilter)) {
      throw new ApiError('PAYMENT_METHOD_UNAVAILABLE', 'Cash on Delivery is unavailable on this account. Please pay online.');
    }
    return;
  }

  if (!isOnlineMethod(method)) {
    throw new ApiError('PAYMENT_METHOD_UNAVAILABLE', 'Please choose a valid payment method');
  }

  const option = ONLINE_METHODS.find((entry) => entry.key === method);
  if (settings?.[option.settingKey] === false) {
    throw new ApiError('PAYMENT_METHOD_UNAVAILABLE', `${option.label} is currently unavailable`);
  }
  if (!razorpayUsable(settings, { razorpayConfigured })) {
    throw new ApiError('PAYMENT_METHOD_UNAVAILABLE', 'Online payment is not available right now. Please choose Cash on Delivery.');
  }
}

/** COD fee applies only to COD orders. */
function resolveCodCharge(method, settings) {
  return method === 'COD' ? codCharge(settings) : 0;
}

function resolveDeliveryCharge(sellingTotal, settings) {
  const freeAbove = Number(settings?.freeShippingMinAmount ?? 999);
  const charge = Number(settings?.deliveryCharge ?? 99);
  return settings?.shippingFreeAboveEnabled !== false && Number(sellingTotal || 0) >= freeAbove ? 0 : Math.max(0, charge);
}

module.exports = {
  ONLINE_METHODS,
  applyCustomerRtoToPaymentOptions,
  assertPaymentMethodAllowed,
  buildPaymentOptions,
  codMaxAmount,
  codMinAmount,
  codPincodeAllowed,
  getStoreSettings,
  isOnlineMethod,
  resolveCodCharge,
  resolveDeliveryCharge,
  resolvePrepaidDiscount,
  razorpayDisabledReason,
  razorpayUsable,
};
