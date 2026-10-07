const Order = require('../models/Order');
const Shipment = require('../models/Shipment');
const { createTargetOtp, verifyTargetOtp, invalidateOtp, getExpiryMinutes } = require('./otpService');
const { sendOtp } = require('./smsService');
const { getDemoOtp, getOtpMode, isDemoOtpMode } = require('../config/env');
const { ApiError } = require('../utils/apiError');

const RTO_ORDER_STATES = ['IN_TRANSIT', 'RECEIVED', 'QC_PENDING', 'RESTOCKED', 'QUARANTINED', 'DAMAGED', 'MISSING', 'REFUND_PENDING', 'REFUNDED', 'CLOSED'];
const RTO_SHIPMENT_STATES = ['RTO_IN_TRANSIT', 'RETURNED'];

function scope(storeId) {
  return storeId ? { storeId } : { $or: [{ storeId: { $exists: false } }, { storeId: null }] };
}

async function customerHistory({ userId, storeId }) {
  const storeScope = scope(storeId);
  const [deliveries, rtoOrders, shipmentRtoOrderIds] = await Promise.all([
    Order.find({ ...storeScope, user: userId, orderStatus: 'Delivered' }).select('_id deliveredAt updatedAt').lean(),
    Order.find({ ...storeScope, user: userId, 'rto.status': { $in: RTO_ORDER_STATES } }).select('_id rto.triggeredAt updatedAt').lean(),
    Shipment.distinct('order', { ...storeScope, status: { $in: RTO_SHIPMENT_STATES } }),
  ]);
  const rtoByOrder = new Map(rtoOrders.map(row => [String(row._id), row.rto?.triggeredAt || row.updatedAt]));
  if (shipmentRtoOrderIds.length) {
    const rows = await Order.find({ ...storeScope, user: userId, _id: { $in: shipmentRtoOrderIds } }).select('_id updatedAt').lean();
    for (const row of rows) if (!rtoByOrder.has(String(row._id))) rtoByOrder.set(String(row._id), row.updatedAt);
  }
  const latestDeliveryAt = deliveries.reduce((latest, row) => Math.max(latest, new Date(row.deliveredAt || row.updatedAt || 0).getTime()), 0);
  const latestRtoAt = [...rtoByOrder.values()].reduce((latest, date) => Math.max(latest, new Date(date || 0).getTime()), 0);
  return { successfulDeliveries: deliveries.length, rtoCount: rtoByOrder.size, latestDeliveryAt, latestRtoAt };
}

async function evaluateCodVerification({ paymentMethod, userId, storeId, settings = {}, phoneVerified = false }) {
  if (String(paymentMethod || '').toUpperCase() !== 'COD') {
    return { codAllowed: true, verificationRequired: false, verificationReason: 'PREPAID', customerTrustState: 'VERIFIED', successfulDeliveries: 0, rtoCount: 0 };
  }
  const history = await customerHistory({ userId, storeId });
  const limit = Math.max(0, Number(settings.codRtoRestrictionLimit ?? 2));
  if (limit > 0 && history.rtoCount >= limit) {
    return { ...history, codAllowed: false, verificationRequired: false, verificationReason: 'RTO_LIMIT', customerTrustState: 'RESTRICTED' };
  }
  const smartEnabled = settings.smartCodVerificationEnabled !== false;
  if (!smartEnabled) {
    const required = settings.codConfirmationRequired === true;
    return { ...history, codAllowed: true, verificationRequired: required, verificationReason: required ? 'STORE_POLICY' : 'NOT_REQUIRED', customerTrustState: history.successfulDeliveries ? 'TRUSTED' : 'NEW' };
  }
  const rtoAfterLastDelivery = history.latestRtoAt > history.latestDeliveryAt;
  const verificationRequired = !phoneVerified || history.successfulDeliveries === 0 || rtoAfterLastDelivery;
  return {
    ...history,
    codAllowed: true,
    verificationRequired,
    verificationReason: !phoneVerified ? 'PHONE_NOT_VERIFIED' : history.successfulDeliveries === 0 ? 'FIRST_COD_ORDER' : rtoAfterLastDelivery ? 'RTO_HISTORY' : 'TRUSTED_CUSTOMER',
    customerTrustState: verificationRequired ? (history.successfulDeliveries ? 'VERIFIED' : 'NEW') : 'TRUSTED',
  };
}

function orderSnapshot(decision, phone = '') {
  const now = new Date();
  return {
    required: Boolean(decision.verificationRequired),
    status: decision.verificationRequired ? 'PENDING' : 'NOT_REQUIRED',
    reason: decision.verificationReason,
    trustState: decision.customerTrustState,
    successfulDeliveries: Number(decision.successfulDeliveries || 0),
    rtoCount: Number(decision.rtoCount || 0),
    phoneLast4: String(phone || '').slice(-4),
    evaluatedAt: now,
    ...(decision.verificationRequired ? {} : { verifiedAt: now }),
  };
}

function assertCodDispatchable(order) {
  if (order?.paymentMethod === 'COD' && order?.codVerification?.required === true && order.codVerification.status !== 'VERIFIED') {
    throw new ApiError('COD_VERIFICATION_REQUIRED', 'Customer verification must be completed before this COD order can be confirmed or dispatched.', { statusCode: 409 });
  }
}

async function sendOrderOtp({ order, phone, req }) {
  if (!order?.codVerification?.required || order.codVerification.status === 'VERIFIED') {
    return { required: false, status: order?.codVerification?.status || 'NOT_REQUIRED' };
  }
  if (order.orderStatus === 'Cancelled') throw new ApiError('ORDER_NOT_VERIFIABLE', 'This order has been cancelled.', { statusCode: 409 });
  const contextId = String(order._id);
  const created = await createTargetOtp(phone, { purpose: 'order_cod_verification', contextId, req, targetType: 'phone' });
  let delivery;
  if (isDemoOtpMode()) delivery = { success: true, provider: 'demo', demoOtp: getDemoOtp() };
  else delivery = await sendOtp(created.phone, created.otp);
  if (!delivery?.success) {
    await invalidateOtp(created.record);
    await Order.updateOne({ _id: order._id, 'codVerification.status': 'PENDING' }, { $set: { 'codVerification.deliveryStatus': 'FAILED', 'codVerification.lastDeliveryError': delivery?.code || 'OTP_DELIVERY_UNAVAILABLE' } });
    throw new ApiError(delivery?.code || 'OTP_DELIVERY_UNAVAILABLE', 'We could not send the verification code. Please try again shortly.', { statusCode: 503 });
  }
  const sentAt = new Date();
  created.record.provider = delivery.provider;
  await created.record.save();
  const expiresAt = new Date(sentAt.getTime() + getExpiryMinutes() * 60000);
  await Order.updateOne({ _id: order._id, 'codVerification.status': 'PENDING' }, { $set: { 'codVerification.sentAt': sentAt, 'codVerification.expiresAt': expiresAt, 'codVerification.deliveryStatus': 'SENT', 'codVerification.lastDeliveryError': '' }, $inc: { 'codVerification.sendCount': 1 } });
  return { required: true, status: 'PENDING', sentAt, expiresAt, retryAfter: Number(process.env.OTP_RESEND_COOLDOWN_SECONDS || 60), otpMode: getOtpMode(), ...(delivery.demoOtp ? { demoOtp: delivery.demoOtp } : {}) };
}

async function verifyOrderOtp({ order, phone, otp, tenantFilter = {} }) {
  if (!order?.codVerification?.required) return order;
  if (order.codVerification.status === 'VERIFIED') return order;
  if (order.codVerification.status !== 'PENDING' || order.orderStatus === 'Cancelled') throw new ApiError('ORDER_NOT_VERIFIABLE', 'This order cannot be verified now.', { statusCode: 409 });
  await verifyTargetOtp(phone, otp, { targetType: 'phone', purpose: 'order_cod_verification', contextId: String(order._id) });
  const now = new Date();
  const updated = await Order.findOneAndUpdate({ _id: order._id, user: order.user?._id || order.user, ...tenantFilter, 'codVerification.status': 'PENDING', orderStatus: 'Pending' }, {
    $set: { 'codVerification.status': 'VERIFIED', 'codVerification.verifiedAt': now, 'codVerification.deliveryStatus': 'DELIVERED', codConfirmationStatus: 'CONFIRMED', orderStatus: 'Confirmed' },
    $inc: { revision: 1 },
    $push: { statusTimeline: { status: 'Confirmed', date: now, note: 'COD order verified by customer OTP' } },
  }, { new: true });
  if (updated) return updated;
  const current = await Order.findOne({ _id: order._id, user: order.user?._id || order.user, ...tenantFilter });
  if (current?.codVerification?.status === 'VERIFIED') return current;
  throw new ApiError('ORDER_CHANGED', 'This order changed while verification was being completed. Refresh and try again.', { statusCode: 409 });
}

function publicVerification(value = {}) {
  return {
    required: value.required === true,
    status: value.status || 'NOT_REQUIRED',
    sentAt: value.sentAt,
    expiresAt: value.expiresAt,
    verifiedAt: value.verifiedAt,
    deliveryStatus: value.deliveryStatus,
  };
}

module.exports = { assertCodDispatchable, customerHistory, evaluateCodVerification, orderSnapshot, publicVerification, sendOrderOtp, verifyOrderOtp };
