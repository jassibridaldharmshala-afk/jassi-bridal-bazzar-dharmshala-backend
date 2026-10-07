const { ApiError } = require('../utils/apiError');

const TRANSITIONS = {
  Requested: ['Approved', 'Rejected', 'Cancelled'],
  Approved: ['Pickup Scheduled', 'Received', 'Cancelled'],
  'Pickup Scheduled': ['Picked Up', 'In Transit', 'Received', 'Cancelled'],
  'Picked Up': ['In Transit', 'Received'],
  'In Transit': ['Received'],
  Received: ['Inspection Pending', 'Verified', 'Mismatch Found', 'QC Passed', 'QC Failed'],
  'Inspection Pending': ['Verified', 'Mismatch Found'],
  Verified: ['QC Passed', 'QC Failed'],
  'Mismatch Found': ['QC Failed', 'Verified'],
  'QC Passed': ['Refund Initiated', 'Refunded', 'Exchange Allocated', 'Exchanged'],
  'QC Failed': ['Closed'],
  'Refund Initiated': ['Refunded'],
  'Exchange Allocated': ['Replacement Shipped', 'Exchanged', 'Cancelled'],
  'Replacement Shipped': ['Replacement Delivered', 'Exchanged'],
  'Replacement Delivered': ['Exchanged', 'Closed'],
  Rejected: ['Closed'],
  Cancelled: ['Closed'],
  Refunded: ['Closed'],
  Exchanged: ['Closed'],
  Closed: [],
};

const RETURN_ONLY = new Set(['Refund Initiated', 'Refunded']);
const EXCHANGE_ONLY = new Set(['Exchange Allocated', 'Replacement Shipped', 'Replacement Delivered', 'Exchanged']);

function nextStatuses(request) {
  return (TRANSITIONS[request?.status] || []).filter((status) => (
    request?.type === 'exchange' ? !RETURN_ONLY.has(status) : !EXCHANGE_ONLY.has(status)
  ));
}

function assertTransition(request, nextStatus) {
  if (request.status === nextStatus) return;
  if (!nextStatuses(request).includes(nextStatus)) {
    throw new ApiError(
      'RETURN_TRANSITION_INVALID',
      `${request.type === 'exchange' ? 'Exchange' : 'Return'} cannot move from ${request.status} to ${nextStatus}.`,
      { statusCode: 409, details: { currentStatus: request.status, allowedStatuses: nextStatuses(request) } },
    );
  }
}

function round(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function returnPolicySettings(order, current = {}) {
  const snapshot = order?.returnPolicySnapshot;
  if (!snapshot?.capturedAt) return current || {};
  const saved = snapshot.toObject ? snapshot.toObject() : snapshot;
  return { ...(current || {}), ...saved };
}

function refundEstimate(order, item, quantity, settings = {}, options = {}) {
  const allItems = order?.orderItems || [];
  const activeQuantity = entry => Math.max(0, Number(entry.quantity || 0) - Number(entry.cancelledQuantity || 0));
  // Discounts belong to the original purchased units. Using only the current
  // active quantity would over-refund a coupon when items are cancelled or
  // returned in separate requests.
  const merchandiseTotal = allItems.reduce((sum, entry) => sum + Number(entry.price || 0) * Number(entry.quantity || 0), 0);
  const itemAmount = round(Number(item?.price || 0) * Number(quantity || 0));
  const ratio = merchandiseTotal > 0 ? itemAmount / merchandiseTotal : 0;
  const coupon = round(Number(order?.couponDiscount || order?.coupon?.discountAmount || 0) * ratio);
  const prepaid = round(Number(order?.prepaidDiscount || 0) * ratio);
  const totalActiveQuantity = allItems.reduce((sum, entry) => sum + activeQuantity(entry), 0);
  const priorQuantity = (options.priorRequests || []).filter(request => request.type === 'return' && !['Rejected', 'Cancelled'].includes(request.status))
    .reduce((sum, request) => sum + Number(request.quantity || 0), 0);
  const isFullReturn = totalActiveQuantity > 0 && priorQuantity + Number(quantity || 0) >= totalActiveQuantity;
  const refundableDeliveryCharge = isFullReturn && settings.refundDeliveryChargeOnFullReturn ? round(order?.deliveryCharge) : 0;
  const refundablePlatformFee = isFullReturn && settings.refundPlatformFeeOnFullReturn ? round(order?.platformFee) : 0;
  const refundableCodCharge = isFullReturn && settings.refundCodChargeOnFullReturn ? round(order?.codCharge) : 0;
  const customerChargeApplies = !options.isCancellation && !options.sellerFault;
  const returnShippingCharge = customerChargeApplies ? round(settings.customerReturnShippingCharge) : 0;
  const eligibleMerchandise = Math.max(0, itemAmount - coupon - prepaid);
  const restockingFee = customerChargeApplies
    ? round(eligibleMerchandise * Math.min(100, Math.max(0, Number(settings.customerRestockingFeePercent || 0))) / 100)
    : 0;
  return {
    currency: 'INR',
    merchandiseAmount: itemAmount,
    allocatedCouponDiscount: coupon,
    allocatedPrepaidDiscount: prepaid,
    refundableDeliveryCharge,
    refundablePlatformFee,
    refundableCodCharge,
    returnShippingCharge,
    restockingFee,
    estimatedRefundAmount: round(Math.max(0, eligibleMerchandise + refundableDeliveryCharge + refundablePlatformFee + refundableCodCharge - returnShippingCharge - restockingFee)),
  };
}

function actorSource(req) {
  if (req?.storeMember) return 'SELLER';
  if (req?.user?.role === 'admin') return 'ADMIN';
  return req?.user ? 'CUSTOMER' : 'SYSTEM';
}

function timelineEntry(req, status, note, source) {
  return {
    status,
    note: String(note || '').trim(),
    source: source || actorSource(req),
    actor: req?.user ? { id: String(req.user._id || ''), name: String(req.user.name || 'Account') } : undefined,
    date: new Date(),
  };
}

module.exports = { TRANSITIONS, actorSource, assertTransition, nextStatuses, refundEstimate, returnPolicySettings, timelineEntry };
