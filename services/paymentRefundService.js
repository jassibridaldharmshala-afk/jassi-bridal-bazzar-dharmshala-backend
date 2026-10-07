const crypto = require('node:crypto');
const Order = require('../models/Order');
const { refundRazorpayPayment, isRazorpayConfigured } = require('./razorpayService');
const couponService = require('./couponService');

function money(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

async function recordProviderRefund({ orderId, refundId, paymentId, amount, currency = 'INR', note, sourceType, sourceId, source = 'SYSTEM', provider = 'razorpay' }) {
  const refunded = money(amount);
  const reference = String(refundId || '').trim();
  if (!reference || refunded <= 0) return { order: await Order.findById(orderId), added: false, isFull: false };
  const claimed = await Order.findOneAndUpdate({
    _id: orderId,
    'refunds.providerRefundId': { $ne: reference },
    $expr: { $lte: [{ $add: [{ $ifNull: ['$refundedAmount', 0] }, refunded] }, { $add: [{ $ifNull: ['$finalAmount', 0] }, 0.001] }] },
  }, {
    $inc: { refundedAmount: refunded, revision: 1 },
    $push: {
      refunds: { providerRefundId: reference, paymentId, provider: String(provider || 'razorpay').toLowerCase(), amount: refunded, currency: String(currency || 'INR').toUpperCase(), status: 'PROCESSED', note, processedAt: new Date(), sourceType, sourceId: sourceId ? String(sourceId) : undefined },
      paymentEvents: { state: 'PARTIALLY_REFUNDED', status: 'Refund processed', amount: refunded, reference, note, source, date: new Date() },
    },
  }, { new: true });
  const order = claimed || await Order.findById(orderId);
  if (!order) return { order: null, added: false, isFull: false };
  const totalRefunded = Math.min(money(order.finalAmount), money(order.refundedAmount));
  const isFull = totalRefunded >= money(order.finalAmount);
  if (claimed) {
    await Order.updateOne({ _id: order._id }, { $set: { refundedAmount: totalRefunded, paymentState: isFull ? 'REFUNDED' : 'PARTIALLY_REFUNDED', ...(isFull ? { paymentStatus: 'Refunded' } : {}) } });
    order.refundedAmount = totalRefunded;
    order.paymentState = isFull ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    if (isFull) order.paymentStatus = 'Refunded';
    if (isFull && order.couponConsumed && order.coupon?.restoreOnFullRefund) await couponService.releaseCouponForFullyRefundedOrder(order._id);
  }
  return { order, added: Boolean(claimed), isFull };
}

async function processCancellationRefund(orderId) {
  const lookup = Order.findById(orderId);
  let order = await (lookup?.select
    ? lookup.select('+cancellationRefund.operation +cancellationRefund.operationUntil')
    : lookup?.session ? lookup.session(null) : lookup);
  if (!order || order.orderStatus !== 'Cancelled') return order;
  let status = order.cancellationRefund?.status || 'NOT_REQUIRED';
  if (status === 'PROCESSED' || order.paymentStatus === 'Refunded') return order;
  const remaining = money(Math.max(0, Number(order.finalAmount || 0) - Number(order.refundedAmount || 0)));
  if (remaining <= 0) {
    await Order.updateOne({ _id: order._id }, { $set: { 'cancellationRefund.status': 'PROCESSED', 'cancellationRefund.amount': 0, 'cancellationRefund.processedAt': new Date() } });
    return Order.findById(order._id);
  }
  if (status === 'NOT_REQUIRED') {
    const paymentWasCollected = order.paymentMethod !== 'COD'
      && (order.paymentStatus === 'Paid' || ['PAID', 'PARTIALLY_REFUNDED'].includes(order.paymentState));
    if (!paymentWasCollected) return order;
    const queued = await Order.findOneAndUpdate(
      { _id: order._id, orderStatus: 'Cancelled', 'cancellationRefund.status': { $in: ['NOT_REQUIRED', null] } },
      { $set: { 'cancellationRefund.status': 'PENDING', 'cancellationRefund.amount': remaining, 'cancellationRefund.lastError': '' } },
      { new: true },
    );
    order = queued || await Order.findById(order._id).select('+cancellationRefund.operation +cancellationRefund.operationUntil');
    status = order?.cancellationRefund?.status || 'NOT_REQUIRED';
    if (status === 'NOT_REQUIRED') return order;
  }
  if (String(order.paymentProvider || '').toLowerCase() !== 'razorpay' || !order.razorpayPaymentId) {
    await Order.updateOne({ _id: order._id }, { $set: { 'cancellationRefund.status': 'MANUAL_REQUIRED', 'cancellationRefund.amount': remaining, 'cancellationRefund.lastError': 'The original online payment cannot be refunded automatically.' } });
    return Order.findById(order._id);
  }
  if (!isRazorpayConfigured()) {
    await Order.updateOne({ _id: order._id }, { $set: { 'cancellationRefund.status': 'FAILED', 'cancellationRefund.amount': remaining, 'cancellationRefund.lastError': 'Razorpay refund service is not configured.' } });
    return Order.findById(order._id);
  }

  const operation = crypto.randomUUID();
  const leased = await Order.findOneAndUpdate({
    _id: order._id,
    orderStatus: 'Cancelled',
    'cancellationRefund.status': { $in: ['PENDING', 'FAILED'] },
    $or: [
      { 'cancellationRefund.operation': { $exists: false } }, { 'cancellationRefund.operation': '' },
      { 'cancellationRefund.operationUntil': { $lt: new Date() } },
    ],
  }, { $set: {
    'cancellationRefund.status': 'PROCESSING', 'cancellationRefund.amount': remaining,
    'cancellationRefund.attemptedAt': new Date(), 'cancellationRefund.operation': operation,
    'cancellationRefund.operationUntil': new Date(Date.now() + 60000), 'cancellationRefund.lastError': '',
  }, $inc: { 'cancellationRefund.attemptCount': 1 } }, { new: true });
  if (!leased) return Order.findById(order._id);

  try {
    const gateway = await refundRazorpayPayment({
      paymentId: leased.razorpayPaymentId,
      amountInPaise: Math.round(remaining * 100),
      idempotencyKey: `cancel_${leased._id}`,
      notes: { orderId: String(leased._id), purpose: 'order_cancellation' },
    });
    const providerRefundId = String(gateway.id || '').trim();
    if (String(gateway.status || '').toLowerCase() === 'processed') {
      await recordProviderRefund({ orderId: leased._id, refundId: providerRefundId, paymentId: leased.razorpayPaymentId, amount: remaining, note: 'Refund processed for cancelled order', sourceType: 'CANCELLATION', sourceId: leased._id });
      await Order.updateOne({ _id: leased._id, 'cancellationRefund.operation': operation }, { $set: { 'cancellationRefund.status': 'PROCESSED', 'cancellationRefund.providerRefundId': providerRefundId, 'cancellationRefund.processedAt': new Date(), 'cancellationRefund.lastError': '' }, $unset: { 'cancellationRefund.operation': 1, 'cancellationRefund.operationUntil': 1 } });
    } else {
      await Order.updateOne({ _id: leased._id, 'cancellationRefund.operation': operation }, { $set: { 'cancellationRefund.status': 'INITIATED', 'cancellationRefund.providerRefundId': providerRefundId, 'cancellationRefund.nextCheckAt': new Date(Date.now() + 30 * 60 * 1000) }, $unset: { 'cancellationRefund.operation': 1, 'cancellationRefund.operationUntil': 1 } });
    }
  } catch (error) {
    await Order.updateOne({ _id: leased._id, 'cancellationRefund.operation': operation }, { $set: { 'cancellationRefund.status': 'FAILED', 'cancellationRefund.lastError': String(error.message || 'Refund request failed').slice(0, 500), 'cancellationRefund.nextCheckAt': new Date(Date.now() + 30 * 60 * 1000) }, $unset: { 'cancellationRefund.operation': 1, 'cancellationRefund.operationUntil': 1 } });
  }
  return Order.findById(order._id);
}

async function processRtoRefund(orderId) {
  let order = await Order.findById(orderId).select('+paymentEvents +rto.operation +rto.operationUntil');
  if (!order || !['QC_PENDING', 'RESTOCKED', 'QUARANTINED', 'DAMAGED', 'MISSING', 'REFUND_PENDING'].includes(order.rto?.status)) return order;
  const collected = order.paymentMethod !== 'COD' && (order.paymentStatus === 'Paid' || ['PAID', 'PARTIALLY_REFUNDED'].includes(order.paymentState));
  if (!collected) {
    await Order.updateOne({ _id: order._id }, { $set: { 'rto.refundStatus': 'NOT_REQUIRED', 'rto.status': 'CLOSED' } });
    return Order.findById(order._id);
  }
  const remainingPaid = money(Math.max(0, Number(order.finalAmount || 0) - Number(order.refundedAmount || 0)));
  const requestedRefund = order.rto?.refundAmount === undefined || order.rto?.refundAmount === null ? remainingPaid : Number(order.rto.refundAmount);
  const remaining = money(Math.min(remainingPaid, Math.max(0, requestedRefund)));
  if (remaining <= 0) {
    await Order.updateOne({ _id: order._id }, { $set: { 'rto.refundStatus': 'PROCESSED', 'rto.status': 'REFUNDED' } });
    return Order.findById(order._id);
  }
  if (String(order.paymentProvider || '').toLowerCase() !== 'razorpay' || !order.razorpayPaymentId) {
    await Order.updateOne({ _id: order._id }, { $set: { 'rto.refundStatus': 'MANUAL_REQUIRED', 'rto.status': 'REFUND_PENDING', 'rto.notes': 'The prepaid RTO refund must be completed manually.' } });
    return Order.findById(order._id);
  }
  if (!isRazorpayConfigured()) {
    await Order.updateOne({ _id: order._id }, { $set: { 'rto.refundStatus': 'FAILED', 'rto.status': 'REFUND_PENDING', 'rto.notes': 'Razorpay refund service is not configured.' } });
    return Order.findById(order._id);
  }
  const operation = crypto.randomUUID();
  const leased = await Order.findOneAndUpdate({ _id: order._id, 'rto.refundStatus': { $in: ['PENDING', 'FAILED', 'NOT_REQUIRED'] }, $or: [{ 'rto.operation': '' }, { 'rto.operation': { $exists: false } }, { 'rto.operationUntil': { $lt: new Date() } }] }, { $set: { 'rto.refundStatus': 'PROCESSING', 'rto.status': 'REFUND_PENDING', 'rto.operation': operation, 'rto.operationUntil': new Date(Date.now() + 60000), 'rto.refundAttemptedAt': new Date(), 'rto.nextRefundCheckAt': new Date(Date.now() + 5 * 60 * 1000), 'rto.lastRefundError': '' }, $inc: { 'rto.refundAttemptCount': 1 } }, { new: true });
  if (!leased) return Order.findById(order._id);
  try {
    const gateway = await refundRazorpayPayment({ paymentId: leased.razorpayPaymentId, amountInPaise: Math.round(remaining * 100), idempotencyKey: `rto_${leased._id}`, notes: { orderId: String(leased._id), purpose: 'order_rto' } });
    const reference = String(gateway.id || '').trim();
    if (String(gateway.status || '').toLowerCase() === 'processed') {
      await recordProviderRefund({ orderId: leased._id, refundId: reference, paymentId: leased.razorpayPaymentId, amount: remaining, note: 'Refund processed after return to origin', sourceType: 'RTO', sourceId: leased._id });
      await Order.updateOne({ _id: leased._id, 'rto.operation': operation }, { $set: { 'rto.refundStatus': 'PROCESSED', 'rto.refundReference': reference, 'rto.status': 'REFUNDED', 'rto.lastRefundError': '' }, $unset: { 'rto.operation': 1, 'rto.operationUntil': 1, 'rto.nextRefundCheckAt': 1 } });
    } else {
      await Order.updateOne({ _id: leased._id, 'rto.operation': operation }, { $set: { 'rto.refundStatus': 'PENDING', 'rto.refundReference': reference, 'rto.status': 'REFUND_PENDING', 'rto.nextRefundCheckAt': new Date(Date.now() + 30 * 60 * 1000) }, $unset: { 'rto.operation': 1, 'rto.operationUntil': 1 } });
    }
  } catch (error) {
    await Order.updateOne({ _id: leased._id, 'rto.operation': operation }, { $set: { 'rto.refundStatus': 'FAILED', 'rto.status': 'REFUND_PENDING', 'rto.lastRefundError': String(error.message || 'RTO refund failed').slice(0, 500), 'rto.nextRefundCheckAt': new Date(Date.now() + 30 * 60 * 1000) }, $unset: { 'rto.operation': 1, 'rto.operationUntil': 1 } });
  }
  return Order.findById(order._id);
}

async function processItemCancellationRefund(orderId, operationId) {
  let order = await Order.findById(orderId);
  if (!order) return order;
  const operation = String(operationId || '').trim();
  let entry = (order.itemCancellationRefunds || []).find(item => item.operationId === operation);
  if (!entry || ['PROCESSED', 'NOT_REQUIRED'].includes(entry.status)) return order;
  const collected = order.paymentMethod !== 'COD' && (order.paymentStatus === 'Paid' || ['PAID', 'PARTIALLY_REFUNDED'].includes(order.paymentState));
  if (!collected) {
    await Order.updateOne({ _id: order._id }, { $set: { 'itemCancellationRefunds.$[refund].status': 'NOT_REQUIRED' } }, { arrayFilters: [{ 'refund.operationId': operation }] });
    return Order.findById(order._id);
  }
  if (String(order.paymentProvider || '').toLowerCase() !== 'razorpay' || !order.razorpayPaymentId) {
    await Order.updateOne({ _id: order._id }, { $set: { 'itemCancellationRefunds.$[refund].status': 'MANUAL_REQUIRED', 'itemCancellationRefunds.$[refund].lastError': 'The original payment cannot be refunded automatically.' } }, { arrayFilters: [{ 'refund.operationId': operation }] });
    return Order.findById(order._id);
  }
  if (!isRazorpayConfigured()) {
    await Order.updateOne({ _id: order._id }, { $set: { 'itemCancellationRefunds.$[refund].status': 'FAILED', 'itemCancellationRefunds.$[refund].lastError': 'Razorpay refund service is not configured.' } }, { arrayFilters: [{ 'refund.operationId': operation }] });
    return Order.findById(order._id);
  }
  const leased = await Order.findOneAndUpdate({ _id: order._id, itemCancellationRefunds: { $elemMatch: { operationId: operation, status: { $in: ['PENDING', 'FAILED'] } } } }, { $set: { 'itemCancellationRefunds.$.status': 'PROCESSING', 'itemCancellationRefunds.$.attemptedAt': new Date(), 'itemCancellationRefunds.$.nextCheckAt': new Date(Date.now() + 5 * 60 * 1000), 'itemCancellationRefunds.$.lastError': '' }, $inc: { 'itemCancellationRefunds.$.attemptCount': 1 } }, { new: true });
  if (!leased) return Order.findById(order._id);
  entry = leased.itemCancellationRefunds.find(item => item.operationId === operation);
  try {
    const gateway = await refundRazorpayPayment({ paymentId: leased.razorpayPaymentId, amountInPaise: Math.round(money(entry.amount) * 100), idempotencyKey: `item_cancel_${operation.replace(/[^a-z0-9_-]/gi, '').slice(0, 70)}`, notes: { orderId: String(leased._id), purpose: 'item_cancellation', operationId: operation } });
    const reference = String(gateway.id || '').trim();
    if (String(gateway.status || '').toLowerCase() === 'processed') {
      await recordProviderRefund({ orderId: leased._id, refundId: reference, paymentId: leased.razorpayPaymentId, amount: entry.amount, note: 'Refund processed for cancelled order item', sourceType: 'ITEM_CANCELLATION', sourceId: operation });
      await Order.updateOne({ _id: leased._id }, { $set: { 'itemCancellationRefunds.$[refund].status': 'PROCESSED', 'itemCancellationRefunds.$[refund].providerRefundId': reference, 'itemCancellationRefunds.$[refund].processedAt': new Date(), 'itemCancellationRefunds.$[refund].lastError': '' }, $unset: { 'itemCancellationRefunds.$[refund].nextCheckAt': 1 } }, { arrayFilters: [{ 'refund.operationId': operation }] });
    } else {
      await Order.updateOne({ _id: leased._id }, { $set: { 'itemCancellationRefunds.$[refund].status': 'INITIATED', 'itemCancellationRefunds.$[refund].providerRefundId': reference, 'itemCancellationRefunds.$[refund].nextCheckAt': new Date(Date.now() + 30 * 60 * 1000) } }, { arrayFilters: [{ 'refund.operationId': operation }] });
    }
  } catch (error) {
    await Order.updateOne({ _id: leased._id }, { $set: { 'itemCancellationRefunds.$[refund].status': 'FAILED', 'itemCancellationRefunds.$[refund].lastError': String(error.message || 'Item refund failed').slice(0, 500), 'itemCancellationRefunds.$[refund].nextCheckAt': new Date(Date.now() + 30 * 60 * 1000) } }, { arrayFilters: [{ 'refund.operationId': operation }] });
  }
  return Order.findById(order._id);
}

module.exports = { processCancellationRefund, processItemCancellationRefund, processRtoRefund, recordProviderRefund };
