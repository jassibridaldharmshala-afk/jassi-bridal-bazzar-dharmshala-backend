const { ApiError } = require('../utils/apiError');

const OPERATIONAL_STATUSES = ['Pending', 'Confirmed', 'Packed', 'Shipped', 'Out for Delivery', 'Delivered', 'Cancelled'];
const RETURN_STATUSES = ['Return Requested', 'Exchange Requested', 'Returned', 'Refunded'];
const HANDED_TO_CARRIER = ['PICKED_UP', 'SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'RTO_IN_TRANSIT', 'RETURNED'];

function shipmentOf(order, shipment) {
  const value = shipment || order?.shipment;
  return value && typeof value === 'object' ? value : null;
}

function isIntegratedShipment(shipment) {
  return Boolean(shipment?.provider && shipment.provider !== 'manual');
}

function isOnlinePaid(order) {
  return order?.paymentMethod === 'COD' || order?.paymentStatus === 'Paid';
}

function canCancelOrder(order, shipment) {
  const current = shipmentOf(order, shipment);
  if (!['Pending', 'Confirmed', 'Packed'].includes(order?.orderStatus)) return false;
  if (current && HANDED_TO_CARRIER.includes(current.status)) return false;
  if (current?.bookingState === 'BOOKED' && !['WAITING', 'READY_TO_SHIP', 'PICKUP_SCHEDULED', 'FAILED', 'CANCELLED'].includes(current.status)) return false;
  return true;
}

function allowedStatusTransitions(order, shipment) {
  if (!order) return [];
  const current = shipmentOf(order, shipment);
  const manual = !current || !isIntegratedShipment(current);
  if (manual && (['RTO_IN_TRANSIT', 'RETURNED', 'CANCELLED'].includes(current?.status) || (order.rto?.status && order.rto.status !== 'NONE'))) return [];
  const tracked = current?.fulfillmentMode === 'SELF'
    ? Boolean(current.deliveryReference)
    : Boolean(current?.courierName && (current?.awb || current?.trackingNumber));
  const transitions = [];

  const codVerificationPending = order.paymentMethod === 'COD' && order.codVerification?.required === true && order.codVerification.status !== 'VERIFIED';
  if (order.orderStatus === 'Pending' && isOnlinePaid(order) && !codVerificationPending) transitions.push('Confirmed');
  if (order.orderStatus === 'Confirmed' && isOnlinePaid(order) && order.packageVerification?.status !== 'PENDING') transitions.push('Packed');
  if (order.orderStatus === 'Packed' && manual && tracked) transitions.push('Shipped');
  if (order.orderStatus === 'Shipped' && manual) transitions.push('Out for Delivery');
  if (order.orderStatus === 'Out for Delivery' && manual) transitions.push('Delivered');
  if (canCancelOrder(order, current)) transitions.push('Cancelled');
  return transitions;
}

function allowedActions(order, shipment, { hasOpenReturn = false, canRecordRefund = false } = {}) {
  const transitions = allowedStatusTransitions(order, shipment);
  const actions = [];
  const statusAction = {
    Confirmed: 'CONFIRM_ORDER',
    Packed: 'MARK_PACKED',
    Shipped: 'MARK_SHIPPED',
    'Out for Delivery': 'MARK_OUT_FOR_DELIVERY',
    Delivered: 'MARK_DELIVERED',
    Cancelled: 'CANCEL_ORDER',
  };
  for (const status of transitions) actions.push(statusAction[status]);
  if (order?.paymentMethod === 'COD' && order.paymentStatus === 'Pending' && order.orderStatus === 'Delivered') actions.push('COLLECT_COD');
  const collectedAmount = order?.paymentMethod === 'COD' ? Number(order.adjustedFinalAmount ?? order.finalAmount ?? 0) : Number(order?.finalAmount || 0);
  if (order?.paymentMethod === 'COD' && order.paymentStatus === 'Paid' && canRecordRefund && Number(order.refundedAmount || 0) < collectedAmount) actions.push('RECORD_COD_REFUND');
  if (['EXCEPTION', 'FAILED'].includes(shipmentOf(order, shipment)?.status)) actions.push('RESOLVE_DELIVERY_EXCEPTION');
  if (hasOpenReturn || RETURN_STATUSES.includes(order?.orderStatus)) actions.push('REVIEW_RETURN');
  return actions.filter(Boolean);
}

function assertOrderTransition(order, nextStatus, shipment) {
  if (order?.orderStatus === nextStatus) return { changed: false };
  if (!OPERATIONAL_STATUSES.includes(nextStatus) || RETURN_STATUSES.includes(nextStatus)) {
    throw new ApiError('ORDER_TRANSITION_INVALID', 'Return and refund states are managed from their dedicated workflow.', { statusCode: 409 });
  }
  const allowed = allowedStatusTransitions(order, shipment);
  if (!allowed.includes(nextStatus)) {
    const next = allowed.filter(status => status !== 'Cancelled');
    const guidance = next.length ? ` Next available step: ${next.join(' or ')}.` : '';
    throw new ApiError('ORDER_TRANSITION_INVALID', `An order cannot move from ${order?.orderStatus || 'its current state'} to ${nextStatus}.${guidance}`, { statusCode: 409 });
  }
  return { changed: true };
}

function publicWorkflow(order, shipment, options) {
  return {
    allowedActions: allowedActions(order, shipment, options),
    allowedStatusTransitions: allowedStatusTransitions(order, shipment),
    revision: Number(order?.revision || 0),
  };
}

module.exports = {
  HANDED_TO_CARRIER,
  OPERATIONAL_STATUSES,
  RETURN_STATUSES,
  allowedActions,
  allowedStatusTransitions,
  assertOrderTransition,
  canCancelOrder,
  isIntegratedShipment,
  publicWorkflow,
};
