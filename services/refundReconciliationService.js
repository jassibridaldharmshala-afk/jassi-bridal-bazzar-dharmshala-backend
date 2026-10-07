const Order = require('../models/Order');
const ReturnExchange = require('../models/ReturnExchange');
const { fetchRazorpayRefund, refundRazorpayPayment, isRazorpayConfigured } = require('./razorpayService');
const { processCancellationRefund, processItemCancellationRefund, processRtoRefund, recordProviderRefund } = require('./paymentRefundService');
const { returnOrderStatus } = require('./returnEligibilityService');
const { notifyLater } = require('./notificationService');
const { logAudit } = require('./auditService');
const inventoryService = require('./inventoryService');
const { getStoreSettings } = require('./paymentSettingsService');
const { settleExchangeAdjustment } = require('./exchangeAdjustmentService');

const due = value => !value || new Date(value) <= new Date();
const money = value => Math.round(Number(value || 0) * 100) / 100;

async function completeReturnRefund(request, order, reference, amount) {
  const refunded = money(amount || request.financial?.approvedRefundAmount || request.financial?.estimatedRefundAmount);
  await recordProviderRefund({ orderId: order._id, refundId: reference, paymentId: order.razorpayPaymentId, amount: refunded, note: 'Refund confirmed by provider reconciliation', sourceType: 'RETURN', sourceId: request._id });
  const completed = await ReturnExchange.findOneAndUpdate(
    { _id: request._id, status: 'Refund Initiated', 'financial.refundStatus': { $ne: 'PROCESSED' } },
    { $set: { status: 'Refunded', active: false, resolutionStatus: 'Refunded', completedAt: new Date(), 'financial.refundStatus': 'PROCESSED', 'financial.refundReference': reference, 'financial.refundedAmount': refunded, 'financial.processedAt': new Date(), 'financial.lastRefundError': '' }, $unset: { 'financial.nextRefundCheckAt': 1 }, $inc: { revision: 1 }, $push: { statusTimeline: { status: 'Refunded', note: 'Refund confirmed by automatic payment reconciliation.', source: 'SYSTEM', date: new Date() } } },
    { new: true },
  );
  if (!completed) return null;
  const cases = await ReturnExchange.find({ order: order._id });
  const latestOrder = await Order.findById(order._id);
  const status = returnOrderStatus(latestOrder, cases);
  if (status !== latestOrder.orderStatus) await Order.updateOne({ _id: latestOrder._id }, { $set: { orderStatus: status }, $inc: { revision: 1 }, $push: { statusTimeline: { status, date: new Date(), note: 'Return refund confirmed automatically.' } } });
  notifyLater({ userId: completed.user, storeId: completed.storeId, event: 'REFUND_PROCESSED', title: 'Refund processed', message: `Your refund of Rs. ${refunded.toLocaleString('en-IN')} has been processed. Bank posting time may vary.`, metadata: { orderId: String(order._id), returnId: String(completed._id), amount: refunded } });
  logAudit({ source: 'SYSTEM', action: 'RETURN_REFUND_RECONCILED', entityType: 'ReturnExchange', entityId: completed._id, storeId: completed.storeId, after: { reference, amount: refunded } });
  return completed;
}

async function reconcileReturn(request) {
  const order = await Order.findById(request.order);
  if (!order) return;
  let reference = String(request.financial?.refundReference || '').trim();
  let gateway;
  if (reference) gateway = await fetchRazorpayRefund(reference);
  else {
    if (!isRazorpayConfigured() || !order.razorpayPaymentId || Number(request.financial?.refundAttemptCount || 0) >= 3) return;
    await ReturnExchange.updateOne({ _id: request._id }, { $inc: { 'financial.refundAttemptCount': 1 }, $set: { 'financial.lastRefundAttemptAt': new Date(), 'financial.lastRefundError': '' } });
    gateway = await refundRazorpayPayment({ paymentId: order.razorpayPaymentId, amountInPaise: Math.round(money(request.financial?.approvedRefundAmount || request.financial?.estimatedRefundAmount) * 100), idempotencyKey: `return_${request._id}`, notes: { orderId: String(order._id), returnId: String(request._id) } });
    reference = String(gateway.id || '').trim();
  }
  const status = String(gateway?.status || '').toLowerCase();
  if (status === 'processed') return completeReturnRefund(request, order, reference, Number(gateway.amount || 0) / 100);
  const failed = ['failed', 'rejected'].includes(status);
  await ReturnExchange.updateOne({ _id: request._id }, { $set: { 'financial.refundReference': reference || undefined, 'financial.refundStatus': failed ? 'FAILED' : 'INITIATED', 'financial.lastRefundError': failed ? `Provider status: ${status}.` : '', 'financial.nextRefundCheckAt': new Date(Date.now() + 30 * 60 * 1000) } });
}

async function reconcileCancellation(order) {
  const reference = String(order.cancellationRefund?.providerRefundId || '').trim();
  if (!reference) return;
  const gateway = await fetchRazorpayRefund(reference);
  const status = String(gateway?.status || '').toLowerCase();
  if (status === 'processed') {
    const amount = money(Number(gateway.amount || 0) / 100 || order.cancellationRefund.amount);
    await recordProviderRefund({ orderId: order._id, refundId: reference, paymentId: order.razorpayPaymentId, amount, note: 'Cancellation refund confirmed by provider reconciliation', sourceType: 'CANCELLATION', sourceId: order._id });
    await Order.updateOne({ _id: order._id }, { $set: { 'cancellationRefund.status': 'PROCESSED', 'cancellationRefund.amount': amount, 'cancellationRefund.processedAt': new Date(), 'cancellationRefund.lastError': '' }, $unset: { 'cancellationRefund.nextCheckAt': 1 } });
    notifyLater({ userId: order.user, storeId: order.storeId, event: 'REFUND_PROCESSED', title: 'Cancellation refund processed', message: `Your refund of Rs. ${amount.toLocaleString('en-IN')} has been processed.`, metadata: { orderId: String(order._id), amount } });
    return;
  }
  await Order.updateOne({ _id: order._id }, { $set: { 'cancellationRefund.status': ['failed', 'rejected'].includes(status) ? 'FAILED' : 'INITIATED', 'cancellationRefund.lastError': ['failed', 'rejected'].includes(status) ? `Provider status: ${status}.` : '', 'cancellationRefund.nextCheckAt': new Date(Date.now() + 30 * 60 * 1000) } });
}

async function reconcileRto(order) {
  const reference = String(order.rto?.refundReference || '').trim();
  if (!reference) return;
  const gateway = await fetchRazorpayRefund(reference);
  const status = String(gateway?.status || '').toLowerCase();
  if (status === 'processed') {
    const amount = money(Number(gateway.amount || 0) / 100 || Math.max(0, Number(order.finalAmount || 0) - Number(order.refundedAmount || 0)));
    await recordProviderRefund({ orderId: order._id, refundId: reference, paymentId: order.razorpayPaymentId, amount, note: 'RTO refund confirmed by provider reconciliation', sourceType: 'RTO', sourceId: order._id });
    await Order.updateOne({ _id: order._id }, { $set: { 'rto.refundStatus': 'PROCESSED', 'rto.status': 'REFUNDED', 'rto.lastRefundError': '' }, $unset: { 'rto.nextRefundCheckAt': 1 } });
    notifyLater({ userId: order.user, storeId: order.storeId, event: 'REFUND_PROCESSED', title: 'RTO refund processed', message: `Your refund of Rs. ${amount.toLocaleString('en-IN')} has been processed.`, metadata: { orderId: String(order._id), amount } });
  } else if (['failed', 'rejected'].includes(status)) {
    await Order.updateOne({ _id: order._id }, { $set: { 'rto.refundStatus': 'FAILED', 'rto.lastRefundError': `Provider status: ${status}.`, 'rto.nextRefundCheckAt': new Date(Date.now() + 30 * 60 * 1000) } });
  }
}

async function reconcileItemCancellation(order, entry) {
  const reference = String(entry?.providerRefundId || '').trim();
  if (!reference) return;
  const gateway = await fetchRazorpayRefund(reference);
  const status = String(gateway?.status || '').toLowerCase();
  const operationId = String(entry.operationId || '');
  if (status === 'processed') {
    const amount = money(Number(gateway.amount || 0) / 100 || entry.amount);
    await recordProviderRefund({ orderId: order._id, refundId: reference, paymentId: order.razorpayPaymentId, amount, note: 'Item cancellation refund confirmed by provider reconciliation', sourceType: 'ITEM_CANCELLATION', sourceId: operationId });
    await Order.updateOne({ _id: order._id }, { $set: { 'itemCancellationRefunds.$[refund].status': 'PROCESSED', 'itemCancellationRefunds.$[refund].processedAt': new Date(), 'itemCancellationRefunds.$[refund].lastError': '' }, $unset: { 'itemCancellationRefunds.$[refund].nextCheckAt': 1 } }, { arrayFilters: [{ 'refund.operationId': operationId }] });
    notifyLater({ userId: order.user, storeId: order.storeId, event: 'REFUND_PROCESSED', title: 'Cancelled item refund processed', message: `Your refund of Rs. ${amount.toLocaleString('en-IN')} has been processed.`, metadata: { orderId: String(order._id), operationId, amount } });
    return;
  }
  const failed = ['failed', 'rejected'].includes(status);
  await Order.updateOne({ _id: order._id }, { $set: { 'itemCancellationRefunds.$[refund].status': failed ? 'FAILED' : 'INITIATED', 'itemCancellationRefunds.$[refund].lastError': failed ? `Provider status: ${status}.` : '', 'itemCancellationRefunds.$[refund].nextCheckAt': new Date(Date.now() + 30 * 60 * 1000) } }, { arrayFilters: [{ 'refund.operationId': operationId }] });
}

async function reconcileExchangeCredit(request) {
  const reference = String(request.financial?.exchangeAdjustmentReference || '').trim();
  if (!reference) return;
  const gateway = await fetchRazorpayRefund(reference);
  const status = String(gateway?.status || '').toLowerCase();
  if (status === 'processed') {
    const order = await Order.findById(request.order);
    if (!order) return;
    const amount = money(Number(gateway.amount || 0) / 100 || Math.abs(Number(request.financial?.exchangePriceDifference || 0)));
    await recordProviderRefund({ orderId: order._id, refundId: reference, paymentId: order.razorpayPaymentId, amount, note: 'Exchange credit confirmed by provider reconciliation', sourceType: 'EXCHANGE_ADJUSTMENT', sourceId: request._id });
    await settleExchangeAdjustment(request._id, { type: 'CREDITED', reference, paymentId: order.razorpayPaymentId, source: 'SYSTEM' });
    notifyLater({ userId: request.user, storeId: request.storeId, event: 'EXCHANGE_CREDIT_UPDATED', title: 'Exchange credit processed', message: `Your exchange credit of Rs. ${amount.toLocaleString('en-IN')} has been processed.`, metadata: { orderId: String(order._id), returnId: String(request._id), refundId: reference } });
    return;
  }
  const failed = ['failed', 'rejected'].includes(status);
  await ReturnExchange.updateOne({ _id: request._id }, { $set: { 'financial.exchangeAdjustmentStatus': failed ? 'FAILED' : 'CREDIT_PROCESSING', 'financial.exchangeAdjustmentLastError': failed ? `Provider status: ${status}.` : '', 'financial.nextRefundCheckAt': new Date(Date.now() + 30 * 60 * 1000) }, $inc: { revision: 1 } });
}

async function releaseExpiredExchangeReservations() {
  const expired = await ReturnExchange.find({
    type: 'exchange', status: 'Exchange Allocated', exchangeDeducted: true,
    exchangeReservationReleased: { $ne: true }, exchangeReservationExpiresAt: { $lte: new Date() },
  }).limit(20);
  let released = 0;
  for (const request of expired) {
    try {
      const settings = await getStoreSettings(request.storeId ? { storeId: request.storeId } : {});
      await inventoryService.applyInventoryAdjustment({
        productId: request.product, variantId: request.exchangeVariantId, mode: 'ADD', bucket: 'SELLABLE',
        quantity: Number(request.quantity || 1), reasonCode: 'CUSTOMER_RETURN',
        reason: 'Expired exchange reservation released', note: 'Replacement was not dispatched before the reservation deadline.',
        reference: `Exchange ${request._id}`, idempotencyKey: `exchange-expiry:${request._id}`,
        tenantFilter: request.storeId ? { storeId: request.storeId } : {},
      });
      const updated = await ReturnExchange.findOneAndUpdate({ _id: request._id, status: 'Exchange Allocated', exchangeReservationReleased: { $ne: true } }, {
        $set: { status: 'QC Passed', exchangeDeducted: false, exchangeReservationReleased: true, slaDueAt: new Date(Date.now() + Math.max(1, Number(settings.returnSlaHours || 24)) * 60 * 60 * 1000) },
        $unset: { exchangeReservedAt: 1, exchangeReservationExpiresAt: 1 }, $inc: { revision: 1 },
        $push: { statusTimeline: { status: 'QC Passed', note: 'Replacement reservation expired and stock was released. Allocate a replacement again to continue.', source: 'SYSTEM', date: new Date() } },
      }, { new: true });
      if (updated) {
        released += 1;
        notifyLater({ storeId: updated.storeId, event: 'EXCHANGE_RESERVATION_EXPIRED', title: 'Exchange reservation expired', message: `Exchange ${updated.caseNumber || String(updated._id).slice(-8).toUpperCase()} needs a new replacement allocation.`, channels: ['IN_APP'], metadata: { returnId: String(updated._id), orderId: String(updated.order) } });
        logAudit({ source: 'SYSTEM', action: 'EXCHANGE_RESERVATION_RELEASED', entityType: 'ReturnExchange', entityId: updated._id, storeId: updated.storeId, after: { status: updated.status } });
      }
    } catch (error) {
      await ReturnExchange.updateOne({ _id: request._id }, { $set: { slaDueAt: new Date(Date.now() + 30 * 60 * 1000) }, $push: { internalNotes: { text: `Automatic reservation release failed: ${String(error.message || error).slice(0, 400)}`, author: { name: 'System' }, date: new Date() } } }).catch(() => null);
    }
  }
  return released;
}

async function reconcileDueRefunds() {
  if (!isRazorpayConfigured()) return { checked: 0 };
  let checked = 0;
  const returns = await ReturnExchange.find({ status: 'Refund Initiated', 'financial.refundStatus': { $in: ['INITIATED', 'FAILED'] }, $or: [{ 'financial.nextRefundCheckAt': { $lte: new Date() } }, { 'financial.nextRefundCheckAt': { $exists: false } }] }).limit(20);
  for (const request of returns) {
    if (!due(request.financial?.nextRefundCheckAt)) continue;
    checked += 1;
    await reconcileReturn(request).catch(async error => ReturnExchange.updateOne({ _id: request._id }, { $set: { 'financial.lastRefundError': String(error.message || 'Refund reconciliation failed').slice(0, 500), 'financial.nextRefundCheckAt': new Date(Date.now() + 30 * 60 * 1000) } }));
  }
  const exchangeCredits = await ReturnExchange.find({ type: 'exchange', 'financial.exchangeAdjustmentStatus': 'CREDIT_PROCESSING', 'financial.exchangeAdjustmentReference': { $type: 'string', $ne: '' }, $or: [{ 'financial.nextRefundCheckAt': { $lte: new Date() } }, { 'financial.nextRefundCheckAt': { $exists: false } }] }).limit(20);
  for (const request of exchangeCredits) {
    checked += 1;
    await reconcileExchangeCredit(request).catch(async error => ReturnExchange.updateOne({ _id: request._id }, { $set: { 'financial.exchangeAdjustmentLastError': String(error.message || 'Exchange credit reconciliation failed').slice(0, 500), 'financial.nextRefundCheckAt': new Date(Date.now() + 30 * 60 * 1000) } }));
  }
  const cancellations = await Order.find({ orderStatus: 'Cancelled', 'cancellationRefund.status': 'INITIATED', 'cancellationRefund.providerRefundId': { $type: 'string', $ne: '' }, $or: [{ 'cancellationRefund.nextCheckAt': { $lte: new Date() } }, { 'cancellationRefund.nextCheckAt': { $exists: false } }] }).limit(20);
  for (const order of cancellations) {
    checked += 1;
    await reconcileCancellation(order).catch(async error => Order.updateOne({ _id: order._id }, { $set: { 'cancellationRefund.lastError': String(error.message || 'Refund reconciliation failed').slice(0, 500), 'cancellationRefund.nextCheckAt': new Date(Date.now() + 30 * 60 * 1000) } }));
  }
  const rtoOrders = await Order.find({ 'rto.status': 'REFUND_PENDING', 'rto.refundStatus': { $in: ['PENDING', 'FAILED'] }, 'rto.refundReference': { $type: 'string', $ne: '' }, $or: [{ 'rto.nextRefundCheckAt': { $lte: new Date() } }, { 'rto.nextRefundCheckAt': { $exists: false } }] }).limit(20);
  for (const order of rtoOrders) {
    checked += 1;
    await reconcileRto(order).catch(async error => Order.updateOne({ _id: order._id }, { $set: { 'rto.lastRefundError': String(error.message || 'RTO refund reconciliation failed').slice(0, 500), 'rto.nextRefundCheckAt': new Date(Date.now() + 30 * 60 * 1000) } }));
  }
  const itemOrders = await Order.find({ itemCancellationRefunds: { $elemMatch: { status: 'INITIATED', providerRefundId: { $type: 'string', $ne: '' }, $or: [{ nextCheckAt: { $lte: new Date() } }, { nextCheckAt: { $exists: false } }] } } }).limit(20);
  for (const order of itemOrders) {
    const entries = (order.itemCancellationRefunds || []).filter(entry => entry.status === 'INITIATED' && entry.providerRefundId && due(entry.nextCheckAt));
    for (const entry of entries) {
      checked += 1;
      await reconcileItemCancellation(order, entry).catch(async error => Order.updateOne({ _id: order._id }, { $set: { 'itemCancellationRefunds.$[refund].lastError': String(error.message || 'Item refund reconciliation failed').slice(0, 500), 'itemCancellationRefunds.$[refund].nextCheckAt': new Date(Date.now() + 30 * 60 * 1000) } }, { arrayFilters: [{ 'refund.operationId': entry.operationId }] }));
    }
  }
  const staleItemOrders = await Order.find({ itemCancellationRefunds: { $elemMatch: { status: 'PROCESSING', nextCheckAt: { $lte: new Date() } } } }).limit(20);
  for (const order of staleItemOrders) {
    const entries = (order.itemCancellationRefunds || []).filter(entry => entry.status === 'PROCESSING' && due(entry.nextCheckAt));
    for (const entry of entries) {
      await Order.updateOne({ _id: order._id }, { $set: { 'itemCancellationRefunds.$[refund].status': 'FAILED', 'itemCancellationRefunds.$[refund].lastError': 'A previous refund attempt ended before confirmation. Retrying with the same idempotency key.' } }, { arrayFilters: [{ 'refund.operationId': entry.operationId, 'refund.status': 'PROCESSING' }] });
      checked += 1;
      await processItemCancellationRefund(order._id, entry.operationId).catch(() => null);
    }
  }
  const staleCancellations = await Order.find({ orderStatus: 'Cancelled', 'cancellationRefund.status': 'PROCESSING', 'cancellationRefund.operationUntil': { $lte: new Date() } }).select('+cancellationRefund.operation +cancellationRefund.operationUntil').limit(20);
  for (const order of staleCancellations) {
    const released = await Order.updateOne({ _id: order._id, 'cancellationRefund.status': 'PROCESSING', 'cancellationRefund.operationUntil': { $lte: new Date() } }, { $set: { 'cancellationRefund.status': 'FAILED', 'cancellationRefund.lastError': 'A previous refund attempt ended before confirmation. Retrying safely.' }, $unset: { 'cancellationRefund.operation': 1, 'cancellationRefund.operationUntil': 1 } });
    if (released.modifiedCount) { checked += 1; await processCancellationRefund(order._id).catch(() => null); }
  }
  const staleRtoRefunds = await Order.find({ 'rto.status': 'REFUND_PENDING', 'rto.refundStatus': 'PROCESSING', 'rto.operationUntil': { $lte: new Date() } }).select('+rto.operation +rto.operationUntil').limit(20);
  for (const order of staleRtoRefunds) {
    const released = await Order.updateOne({ _id: order._id, 'rto.refundStatus': 'PROCESSING', 'rto.operationUntil': { $lte: new Date() } }, { $set: { 'rto.refundStatus': 'FAILED', 'rto.lastRefundError': 'A previous RTO refund attempt ended before confirmation. Retrying safely.' }, $unset: { 'rto.operation': 1, 'rto.operationUntil': 1 } });
    if (released.modifiedCount) { checked += 1; await processRtoRefund(order._id).catch(() => null); }
  }
  const releasedReservations = await releaseExpiredExchangeReservations();
  return { checked, releasedReservations };
}

let worker;
function startRefundReconciliationWorker() {
  if (worker) return stopRefundReconciliationWorker;
  let active = false;
  const tick = async () => {
    if (active) return;
    active = true;
    try { await reconcileDueRefunds(); } catch { /* Database reconnects are retried next tick. */ }
    finally { active = false; }
  };
  worker = setInterval(tick, Math.max(60000, Number(process.env.REFUND_RECONCILIATION_INTERVAL_MS || 300000)));
  worker.unref();
  tick().catch(() => null);
  return stopRefundReconciliationWorker;
}

function stopRefundReconciliationWorker() {
  if (worker) clearInterval(worker);
  worker = null;
}

module.exports = { completeReturnRefund, reconcileCancellation, reconcileDueRefunds, reconcileExchangeCredit, reconcileItemCancellation, reconcileReturn, reconcileRto, releaseExpiredExchangeReservations, startRefundReconciliationWorker, stopRefundReconciliationWorker };
