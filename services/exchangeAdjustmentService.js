const Order = require('../models/Order');
const ReturnExchange = require('../models/ReturnExchange');
const { ApiError } = require('../utils/apiError');
const { runInTransaction } = require('../utils/transaction');

const withSession = (query, session) => session ? query.session(session) : query;

async function settleExchangeAdjustment(returnId, { type, reference, paymentId = '', source = 'SYSTEM' }) {
  const adjustmentType = String(type || '').toUpperCase();
  if (!['COLLECTED', 'CREDITED'].includes(adjustmentType)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid exchange adjustment type.');
  const safeReference = String(reference || '').trim().slice(0, 120);
  if (!safeReference) throw new ApiError('VALIDATION_ERROR', 'An exchange settlement reference is required.');

  return runInTransaction(async (session) => {
    const request = await withSession(ReturnExchange.findById(returnId), session);
    if (!request || request.type !== 'exchange') throw new ApiError('NOT_FOUND', 'Exchange request not found', { statusCode: 404 });
    const difference = Number(request.financial?.exchangePriceDifference || 0);
    const expectedType = difference > 0 ? 'COLLECTED' : difference < 0 ? 'CREDITED' : 'COLLECTED';
    if (difference && adjustmentType !== expectedType) throw new ApiError('VALIDATION_ERROR', 'The settlement direction does not match the exchange price difference.');
    const amount = Math.abs(difference);
    const order = await withSession(Order.findById(request.order).select('+paymentEvents'), session);
    if (!order) throw new ApiError('NOT_FOUND', 'Order not found', { statusCode: 404 });

    if (!(order.exchangeAdjustments || []).some(entry => String(entry.returnRequest) === String(request._id))) {
      order.exchangeAdjustments.push({ returnRequest: request._id, type: adjustmentType, amount, reference: safeReference, provider: source === 'WEBHOOK' || paymentId ? 'razorpay' : 'manual', processedAt: new Date() });
      if (adjustmentType === 'COLLECTED') {
        order.exchangeAdjustmentCollected = Number(order.exchangeAdjustmentCollected || 0) + amount;
        order.paymentEvents.push({ state: order.paymentState, status: 'Exchange difference collected', amount, reference: safeReference, note: `Exchange price difference collected for ${request.caseNumber || request._id}`, source, date: new Date() });
      } else {
        await Order.updateOne(
          { _id: order._id, 'refunds.providerRefundId': safeReference },
          { $set: { 'refunds.$.sourceType': 'EXCHANGE_ADJUSTMENT', 'refunds.$.sourceId': String(request._id) } },
          { session },
        );
      }
      await order.save(session ? { session } : {});
    }

    const alreadySettled = request.financial?.exchangeAdjustmentStatus === 'SETTLED'
      && String(request.financial?.exchangeAdjustmentReference || '') === safeReference;
    if (!alreadySettled) {
      request.financial.exchangeAdjustmentStatus = 'SETTLED';
      request.financial.exchangeAdjustmentReference = safeReference;
      request.financial.exchangeAdjustmentSettledAt = new Date();
      request.financial.exchangePaymentId = paymentId || request.financial.exchangePaymentId;
      request.financial.exchangeAdjustmentLastError = '';
      request.financial.nextRefundCheckAt = undefined;
      request.revision = Number(request.revision || 0) + 1;
      await request.save(session ? { session } : {});
    }
    return { request, order };
  });
}

module.exports = { settleExchangeAdjustment };
