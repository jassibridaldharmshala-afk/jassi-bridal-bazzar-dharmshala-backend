const POST_DELIVERY = ['Delivered', 'Return Requested', 'Exchange Requested', 'Returned', 'Refunded'];
function deliveryDate(order) {
  const value = order.deliveredAt || [...(order.statusTimeline || [])].reverse().find((entry) => entry.status === 'Delivered')?.date;
  return value && Number.isFinite(new Date(value).getTime()) ? new Date(value) : null;
}
function matchesItem(request, item) {
  if (request.orderItemId) return String(request.orderItemId) === String(item._id);
  return String(request.product?._id || request.product) === String(item.product?._id || item.product)
    && String(request.variantId || '') === String(item.variantId || '')
    && (!request.size || request.size === item.size)
    && (!request.color || request.color === item.color);
}
function consumesQuantity(request) {
  if (['Rejected', 'Cancelled'].includes(request.status)) return false;
  if (request.status !== 'Closed' || request.resolutionStatus || request.inventoryRestored) return true;
  const statuses = new Set((request.statusTimeline || []).map(entry => entry.status));
  return !statuses.has('Rejected') && !statuses.has('Cancelled');
}
function returnEligibility(order, requests, configuration, now = Date.now()) {
  const delivered = deliveryDate(order);
  const settings = configuration && typeof configuration === 'object' ? configuration : { returnWindowDays: configuration };
  const returnsEnabled = settings.returnsEnabled !== false;
  const days = settings.returnWindowDays === null ? null : Math.max(0, Number(settings.returnWindowDays ?? 7));
  const eligibleStatus = POST_DELIVERY.includes(order.orderStatus) && (order.orderStatus === 'Delivered' || !!delivered || requests.length > 0);
  const items = (order.orderItems || []).map((item) => {
    const hasItemWindow = item.returnWindowDays !== null && item.returnWindowDays !== undefined && Number.isFinite(Number(item.returnWindowDays));
    const itemDays = hasItemWindow ? Math.max(0, Number(item.returnWindowDays)) : days;
    const deadline = delivered && itemDays !== null && itemDays > 0 ? new Date(delivered.getTime() + itemDays * 86400000) : null;
    const expired = Boolean(delivered && (itemDays === 0 || (deadline && now > deadline.getTime())));
    const used = requests.filter((request) => consumesQuantity(request) && matchesItem(request, item))
      .reduce((sum, request) => sum + Math.max(1, Number(request.quantity || 1)), 0);
    const remainingQuantity = Math.max(0, Number(item.quantity || 0) - Number(item.cancelledQuantity || 0) - used);
    const reason = !returnsEnabled ? 'Returns and exchanges are disabled for this store.'
      : !eligibleStatus ? 'Available after delivery.' : expired ? 'The return window has closed.'
      : !remainingQuantity ? 'A request already covers this item.' : '';
    const canReturn = item.returnable !== false && !reason;
    const canExchange = item.exchangeable !== false && !reason;
    const policyReason = reason || (item.returnable === false && item.exchangeable === false ? 'This item is final sale and cannot be returned or exchanged.' : '');
    return {
      orderItemId: String(item._id), remainingQuantity,
      canRequest: canReturn || canExchange,
      canReturn, canExchange,
      reason: policyReason,
      windowDays: itemDays,
      deadline,
      returnPolicy: String(item.returnPolicy || order.invoiceSeller?.returnPolicy || '').trim(),
    };
  });
  const deadlines = items.map(item => item.deadline).filter(Boolean);
  const deadline = deadlines.length ? new Date(Math.max(...deadlines.map(value => new Date(value).getTime()))) : null;
  return { windowDays: days, deliveredAt: delivered, deadline, items };
}
function returnOrderStatus(order, requests) {
  const active = requests.filter((request) => ['Requested', 'Approved', 'Pickup Scheduled', 'Picked Up', 'In Transit', 'Received', 'Inspection Pending', 'Verified', 'Mismatch Found', 'QC Passed', 'Refund Initiated', 'Exchange Allocated', 'Replacement Shipped', 'Replacement Delivered'].includes(request.status));
  if (active.length) return active.some((request) => request.type === 'return') ? 'Return Requested' : 'Exchange Requested';
  const allCovered = (predicate) => (order.orderItems || []).length > 0 && order.orderItems.every((item) => (
    requests.filter((request) => matchesItem(request, item) && predicate(request)).reduce((sum, request) => sum + Number(request.quantity || 1), 0) >= Math.max(0, Number(item.quantity || 1) - Number(item.cancelledQuantity || 0))
  ));
  if (allCovered((request) => request.status === 'Refunded' || request.resolutionStatus === 'Refunded')) return 'Refunded';
  if (allCovered((request) => request.type === 'return' && request.inventoryRestored)) return 'Returned';
  return 'Delivered';
}
module.exports = { consumesQuantity, returnEligibility, matchesItem, returnOrderStatus };
