const crypto = require('crypto');
const { logAudit } = require('../services/auditService');
const Order = require('../models/Order');
const ReturnExchange = require('../models/ReturnExchange');
const InventoryTransaction = require('../models/InventoryTransaction');
const couponService = require('../services/couponService');
const inventoryService = require('../services/inventoryService');
const { buildOrderDraft } = require('../services/orderPricingService');
const { createRazorpayOrder, isRazorpayConfigured } = require('../services/razorpayService');
const { verifyRazorpaySignature } = require('../utils/paymentUtils');
const { runInTransaction } = require('../utils/transaction');
const { ApiError, notFound } = require('../utils/apiError');
const { assertCheckoutReady, assertShippingAddress, cancelOrderInternal } = require('./orderController');
const { buildPersistedOrderFields } = require('../services/orderSnapshotService');
const { notifyLater } = require('../services/notificationService');
const { readAttribution } = require('../utils/attribution');
const { recordEventLater } = require('../services/analyticsService');
const { assertCustomerCanCheckout } = require('../services/customerAccessService');
const { returnOrderStatus } = require('../services/returnEligibilityService');
const { beginPaymentAttempt, checkoutAttemptId, checkoutFingerprint, checkoutCartItems, consumePurchasedCart, failPaymentAttempt, findCheckoutReplay, finishPaymentAttempt, isDuplicateKey } = require('../services/checkoutSafetyService');
const { processCancellationRefund } = require('../services/paymentRefundService');
const { snapshotForOrder } = require('../services/fraudProtectionService');

/**
 * Razorpay flow.
 *
 * The priced order is written to the database *before* the customer is sent
 * to Razorpay. Verification then compares the gateway response against that
 * stored snapshot, so the browser never gets to restate items or amounts
 * after a successful payment.
 */

function amountToPaise(amount) {
  return Math.round(Number(amount || 0) * 100);
}

function paymentOrderHandle(order, { alreadyCompleted = false } = {}) {
  return {
    orderId: order._id,
    order_id: order.razorpayOrderId,
    razorpayOrderId: order.razorpayOrderId,
    amount: amountToPaise(order.finalAmount),
    currency: 'INR',
    keyId: process.env.RAZORPAY_KEY_ID,
    alreadyCompleted,
    totals: {
      totalMRP: order.totalMRP, productDiscount: order.productDiscount, couponDiscount: order.couponDiscount,
      prepaidDiscount: order.prepaidDiscount, deliveryCharge: order.deliveryCharge, codCharge: order.codCharge,
      platformFee: order.platformFee, taxAmount: order.taxAmount, taxRate: order.taxRate, finalAmount: order.finalAmount,
    },
  };
}

/**
 * Finalises a pending order exactly once.
 *
 * Both the customer callback and the webhook call this. The conditional
 * update on `paymentStatus` is the guard: whoever gets there first flips the
 * order to Paid, everyone else sees an already-paid order and stops.
 */
async function finalizePaidOrder(orderId, { razorpayPaymentId, note, req, source = 'SYSTEM' }) {
  return runInTransaction(async (session) => {
    const claimed = await Order.findOneAndUpdate(
      { _id: orderId, orderStatus: { $ne: 'Cancelled' }, paymentStatus: { $nin: ['Paid', 'Refunded'] } },
      {
        $set: {
          paymentStatus: 'Paid',
          paymentState: 'PAID',
          orderStatus: 'Confirmed',
          codConfirmationStatus: 'NOT_REQUIRED',
          'codVerification.required': false,
          'codVerification.status': 'NOT_REQUIRED',
          'codVerification.reason': 'PREPAID',
          'codVerification.trustState': 'VERIFIED',
          'codVerification.verifiedAt': new Date(),
          razorpayPaymentId,
          paymentFailureReason: undefined,
        },
        $inc: { revision: 1 },
        $push: {
          statusTimeline: { status: 'Confirmed', date: new Date(), note },
          paymentEvents: { state: 'PAID', status: 'Paid', reference: razorpayPaymentId, note, source, date: new Date() },
        },
      },
      { new: true, session },
    );

    if (!claimed) {
      const current = await Order.findById(orderId).session(session || null);
      if (current?.orderStatus === 'Cancelled' && current.paymentStatus !== 'Refunded') {
        const remaining = Math.max(0, Number(current.finalAmount || 0) - Number(current.refundedAmount || 0));
        const capturedAfterCancellation = await Order.findOneAndUpdate(
          { _id: orderId, orderStatus: 'Cancelled', paymentStatus: { $nin: ['Paid', 'Refunded'] } },
          {
            $set: {
              paymentStatus: 'Paid', paymentState: 'PAID', razorpayPaymentId,
              'cancellationRefund.status': 'PENDING', 'cancellationRefund.amount': remaining,
              'cancellationRefund.lastError': '',
            },
            $inc: { revision: 1 },
            $push: { paymentEvents: { state: 'PAID', status: 'Paid after cancellation', reference: razorpayPaymentId, note: 'Payment was captured after cancellation; automatic refund queued.', source, date: new Date() } },
          },
          { new: true, session },
        );
        const cancelledOrder = capturedAfterCancellation || await Order.findById(orderId).session(session || null);
        return {
          order: cancelledOrder,
          alreadyPaid: !capturedAfterCancellation,
          paymentAfterCancellation: cancelledOrder?.paymentStatus === 'Paid' && Number(cancelledOrder.refundedAmount || 0) < Number(cancelledOrder.finalAmount || 0),
        };
      }
      return { order: current, alreadyPaid: true, paymentAfterCancellation: false };
    }

    const deductionClaim = await inventoryService.claimInventoryDeduction(Order, claimed._id, session);
    if (deductionClaim) {
      // The customer has already paid, so a stock shortfall must not fail the
      // request. Take what is available and flag the gap for the admin.
      const applied = await inventoryService.deductStockForOrder(deductionClaim.orderItems, {
        orderId: claimed._id,
        userId: claimed.user,
        reason: 'Online payment captured',
        session,
        allowShortfall: true,
      });

      const shortfall = applied.reduce((sum, entry) => sum + (entry.shortfall || 0), 0);
      if (shortfall > 0) {
        await Order.updateOne({ _id: claimed._id }, {
          $push: {
            statusTimeline: {
              status: 'Confirmed',
              date: new Date(),
              note: `Paid, but ${shortfall} unit(s) were no longer in stock. Needs manual review.`,
            },
          },
        }, session ? { session } : {});
      }
    }

    const couponClaim = await Order.findOneAndUpdate(
      {
        _id: claimed._id,
        'coupon.code': { $exists: true, $ne: null },
        $or: [
          { couponConsumed: { $ne: true } },
          { couponReleased: true },
        ],
      },
      { $set: { couponConsumed: true, couponReleased: false } },
      { new: true, session },
    );
    if (couponClaim?.coupon?.code) {
      await couponService.consumeCoupon(couponClaim.coupon.code, { session, userId: couponClaim.user, discountAmount: couponClaim.coupon.savingAmount ?? couponClaim.coupon.discountAmount, couponId: couponClaim.coupon.couponId });
    }

    const paid = await Order.findById(claimed._id).session(session || null);
    return { order: paid, alreadyPaid: false, paymentAfterCancellation: false };
  }).then(async (result) => {
    if (result.paymentAfterCancellation) {
      const refunded = await processCancellationRefund(result.order._id);
      if (!result.alreadyPaid) {
        notifyLater({
          userId: result.order.user, storeId: result.order.storeId, event: 'REFUND_INITIATED',
          title: 'Payment refund started',
          message: 'Your payment arrived after the order was cancelled. The refund has been started automatically.',
          metadata: { orderId: String(result.order._id) },
        });
        logAudit({ req, source, action: 'PAYMENT_CAPTURED_AFTER_CANCELLATION', entityType: 'Order', entityId: result.order._id, storeId: result.order.storeId, after: { paymentStatus: refunded?.paymentStatus, orderStatus: 'Cancelled', cancellationRefund: refunded?.cancellationRefund } });
      }
      return { ...result, order: refunded || result.order };
    }
    if (result.order?.paymentStatus === 'Paid') await consumePurchasedCart(result.order).catch(() => null);
    if (result.order && !result.alreadyPaid) notifyPaid(result.order);
    if (result.order && !result.alreadyPaid) logAudit({ req, source, action: 'PAYMENT_CAPTURED', entityType: 'Order', entityId: result.order._id, storeId: result.order.storeId, after: { paymentStatus: result.order.paymentStatus, orderStatus: result.order.orderStatus, finalAmount: result.order.finalAmount } });
    return result;
  });
}

async function notifyPaid(order) {
  if (!order) return;
  require('../services/orderAlertService').queueLater(order._id);
  notifyLater({
    userId: order.user,
    storeId: order.storeId,
    event: 'ORDER_CONFIRMED',
    title: 'Payment received',
    message: `Your order ${order.invoiceNumber || ''} is confirmed.`,
    metadata: { orderId: String(order._id) },
  });
}

/**
 * Step 1: price the cart server-side, persist a pending order and hand the
 * frontend only the Razorpay handles it needs to open checkout.
 */
async function createPaymentOrder(req, res) {
  assertCheckoutReady(req);
  const requestedMethod = String(req.body?.paymentMethod || 'UPI').toUpperCase();
  if (requestedMethod === 'COD') throw new ApiError('PAYMENT_METHOD_UNAVAILABLE', 'Cash on Delivery orders must use the COD checkout.');
  const attemptId = checkoutAttemptId(req);
  const fingerprint = checkoutFingerprint(req.body, requestedMethod);
  const existing = await findCheckoutReplay({ userId: req.user._id, attemptId, fingerprint });
  if (existing) {
    if (existing.paymentStatus === 'Paid') return res.json(paymentOrderHandle(existing, { alreadyCompleted: true }));
    if (existing.paymentStatus === 'Pending' && existing.razorpayOrderId) return res.json(paymentOrderHandle(existing));
    throw new ApiError('DUPLICATE_REQUEST', 'This payment attempt has ended. Return to checkout and try again.', { statusCode: 409 });
  }
  await assertCustomerCanCheckout({ storeId: req.store?._id, userId: req.user?._id, paymentMethod: req.body?.paymentMethod || 'UPI' });

  if (!isRazorpayConfigured()) {
    throw new ApiError('SERVICE_UNAVAILABLE', 'Online payment is not available right now. Please choose Cash on Delivery.');
  }

  const shippingAddress = assertShippingAddress(req.body?.shippingAddress);
  const draft = await buildOrderDraft({
    orderItems: req.body?.orderItems,
    couponCode: req.body?.coupon?.code,
    paymentMethod: req.body?.paymentMethod || 'UPI',
    userId: req.user?._id,
    shippingAddress,
    tenantFilter: req.tenantFilter,
  });

  const amountInPaise = amountToPaise(draft.totals.finalAmount);
  require('../services/shippingRules').assertQuotedTotal(draft, req.body?.expectedTotal);
  if (amountInPaise < 100) {
    throw new ApiError('VALIDATION_ERROR', 'Order amount must be at least Rs. 1 for online payment.');
  }

  const attempt = await beginPaymentAttempt({ userId: req.user._id, storeId: draft.storeId || req.store?._id, attemptId, fingerprint });
  if (!attempt.owned) {
    if (attempt.order?.paymentStatus === 'Paid') return res.json(paymentOrderHandle(attempt.order, { alreadyCompleted: true }));
    if (attempt.order?.paymentStatus === 'Pending' && attempt.order?.razorpayOrderId) return res.json(paymentOrderHandle(attempt.order));
    throw new ApiError('DUPLICATE_REQUEST', 'This payment attempt has ended. Refresh checkout and try again.', { statusCode: 409 });
  }

  let razorpayOrder;
  try {
    razorpayOrder = await createRazorpayOrder({
      amountInPaise,
      receipt: `sc_${crypto.createHash('sha256').update(attemptId).digest('hex').slice(0, 32)}`,
      notes: { userId: String(req.user._id), paymentMethod: draft.paymentMethod, checkoutAttemptId: attemptId },
    });
  } catch (error) {
    await failPaymentAttempt(attemptId, req.user._id, error);
    throw error;
  }

  const cartItems = checkoutCartItems(req.body);
  const fraudSnapshot = snapshotForOrder(draft.settings, draft.totals.finalAmount);
  let order;
  let replayed = false;
  try {
    order = await runInTransaction(async (session) => {
    await require('../services/commerceUsageService').assertMonthlyCapacity(req.store, { session, platform: req.platformLicense, lock: true });
    const [created] = await Order.create([{
      ...buildPersistedOrderFields({
        userId: req.user._id,
        draft,
        shippingAddress,
        billingAddress: req.body?.billingAddress,
        extra: {
          storeId: draft.storeId || undefined,
          checkoutAttemptId: attemptId,
          checkoutFingerprint: fingerprint,
          checkoutCartItems: cartItems,
          cartCleanupStatus: cartItems.length ? 'PENDING' : 'NOT_REQUIRED',
          attribution: readAttribution(req.body?.attribution || req.body),
          traffic: require('../utils/trafficContext')(req.body),
          prepaidDiscount: draft.totals.prepaidDiscount || 0,
          paymentProvider: 'Razorpay',
          paymentStatus: 'Pending',
          paymentState: 'PENDING',
          orderStatus: 'Pending',
          codConfirmationStatus: 'NOT_REQUIRED',
          codVerification: { required: false, status: 'NOT_REQUIRED', reason: 'PREPAID', trustState: 'VERIFIED', evaluatedAt: new Date() },
          razorpayOrderId: razorpayOrder.id,
          inventoryDeducted: true,
          inventoryDeductedAt: new Date(),
          couponConsumed: Boolean(draft.totals.coupon?.code),
          statusTimeline: [{ status: 'Pending', date: new Date(), note: 'Awaiting Razorpay payment' }],
          fraudProtectionSnapshot: Object.fromEntries(Object.entries(fraudSnapshot).filter(([key]) => key !== 'packageStatus')),
          packageVerification: { status: fraudSnapshot.packageStatus },
          paymentEvents: [{ state: 'PENDING', status: 'Pending', amount: draft.totals.finalAmount, reference: razorpayOrder.id, source: 'CHECKOUT', note: 'Awaiting Razorpay payment', date: new Date() }],
        },
      }),
    }], session ? { session } : {});

    let stockTaken = false;
    try {
      await inventoryService.deductStockForOrder(draft.items, {
        orderId: created._id,
        userId: req.user._id,
        reason: 'Reserved for online payment',
        session,
      });
      stockTaken = true;

      if (draft.totals.coupon?.code) {
        await couponService.consumeCoupon(draft.totals.coupon.code, { session, userId: req.user._id, discountAmount: draft.totals.coupon.savingAmount, couponId: draft.totals.coupon.couponId });
      }
    } catch (error) {
      if (!session) {
        if (stockTaken) {
          await inventoryService.restoreStockForOrder(draft.items, {
            orderId: created._id,
            userId: req.user._id,
            type: 'CANCELLATION',
            reason: 'Online checkout failed after stock was reserved',
          }).catch(() => null);
        }
        await Order.deleteOne({ _id: created._id }).catch(() => null);
        await InventoryTransaction.deleteMany({ order: created._id }).catch(() => null);
      }
      throw error;
    }

      return created;
    });
  } catch (error) {
    if (!isDuplicateKey(error)) {
      await failPaymentAttempt(attemptId, req.user._id, error);
      throw error;
    }
    order = await findCheckoutReplay({ userId: req.user._id, attemptId, fingerprint });
    if (!order) {
      await failPaymentAttempt(attemptId, req.user._id, error);
      throw error;
    }
    replayed = true;
  }

  await finishPaymentAttempt(attemptId, req.user._id, { order: order._id, providerOrderId: order.razorpayOrderId });

  if (replayed) {
    if (order.paymentStatus === 'Paid') return res.json(paymentOrderHandle(order, { alreadyCompleted: true }));
    if (order.paymentStatus === 'Pending' && order.razorpayOrderId) return res.json(paymentOrderHandle(order));
    throw new ApiError('DUPLICATE_REQUEST', 'This payment attempt has ended. Return to checkout and try again.', { statusCode: 409 });
  }

  logAudit({ req, action: 'PAYMENT_STARTED', entityType: 'Order', entityId: order._id, storeId: order.storeId, after: { paymentStatus: order.paymentStatus, paymentMethod: order.paymentMethod, finalAmount: order.finalAmount } });

  recordEventLater({
    name: 'PAYMENT_STARTED',
    storeId: order.storeId,
    userId: req.user._id,
    orderId: order._id,
    source: order.attribution?.source,
    campaign: order.attribution?.campaign,
    reelId: order.attribution?.reelId,
  });

  return res.json(paymentOrderHandle(order));
}

/**
 * Step 2: verify the gateway signature and finalise the stored order.
 *
 * Nothing from the request body is used to price or populate the order.
 */
async function verifyPayment(req, res) {
  assertCheckoutReady(req);

  const razorpayOrderId = req.body.razorpay_order_id || req.body.order_id;
  const razorpayPaymentId = req.body.razorpay_payment_id || req.body.payment_id;
  const razorpaySignature = req.body.razorpay_signature || req.body.signature;

  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    throw new ApiError('VALIDATION_ERROR', 'Missing payment verification fields');
  }

  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) throw new ApiError('SERVICE_UNAVAILABLE', 'Razorpay is not configured');

  if (!verifyRazorpaySignature({ razorpayOrderId, razorpayPaymentId, razorpaySignature, secret })) {
    throw new ApiError('PAYMENT_FAILED', 'Payment verification failed');
  }

  const pending = await Order.findOne({ razorpayOrderId, user: req.user._id });
  if (!pending) throw notFound('We could not find a pending order for this payment. Please contact support.');

  const { order, alreadyPaid } = await finalizePaidOrder(pending._id, {
    razorpayPaymentId,
    note: 'Payment verified and order placed', req, source: 'CUSTOMER',
  });

  // A valid gateway callback can arrive after the customer has cancelled the
  // pending order. That payment is refunded by finalizePaidOrder and must not
  // be counted as a completed checkout or revenue conversion.
  if (order.orderStatus !== 'Cancelled') {
    recordEventLater({
      name: alreadyPaid ? 'PAYMENT_SUCCESS' : 'PURCHASE',
      storeId: order.storeId,
      userId: req.user._id,
      orderId: order._id,
      source: order.attribution?.source,
      campaign: order.attribution?.campaign,
      reelId: order.attribution?.reelId,
    });
    if (!alreadyPaid) {
      recordEventLater({
        name: 'PAYMENT_SUCCESS',
        storeId: order.storeId,
        userId: req.user._id,
        orderId: order._id,
      });
    }
  }

  return res.json({ success: true, alreadyPaid, order });
}

/**
 * Razorpay webhook. Recovers payments where the browser never came back.
 *
 * Requires the raw request body for signature verification, mounted with
 * express.raw in app.js.
 */
async function razorpayWebhook(req, res) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return res.status(503).json({ success: false, code: 'SERVICE_UNAVAILABLE', message: 'Webhook secret is not configured' });

  const signature = req.headers['x-razorpay-signature'];
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  const signatureBuffer = Buffer.from(String(signature || ''));
  const expectedBuffer = Buffer.from(expected);
  const signatureValid = signatureBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(signatureBuffer, expectedBuffer);

  if (!signatureValid) {
    return res.status(400).json({ success: false, code: 'UNAUTHORIZED', message: 'Invalid webhook signature' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'Invalid webhook payload' });
  }

  const event = String(payload.event || '');
  const paymentEntity = payload.payload?.payment?.entity;
  const refundEntity = payload.payload?.refund?.entity;
  const paymentLinkEntity = payload.payload?.payment_link?.entity;

  // Rental payments use their own ledger; never deduct sale stock for them.
  // The signature above is verified before routing to either workflow.
  if (paymentEntity?.notes?.purpose === 'rental' || refundEntity?.notes?.purpose === 'rental' || ['payment.captured', 'payment.failed', 'order.paid'].includes(event) || event.startsWith('refund.')) {
    try {
      if (await require('../services/rentalService').handleWebhook(payload)) return res.json({ success: true });
    } catch (error) {
      return res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Rental webhook reconciliation needs retry.' });
    }
  }

  if (event === 'payment_link.paid' && paymentLinkEntity?.id) {
    try {
      const referenceId = String(paymentLinkEntity.reference_id || '');
      let exchangeRequest = await ReturnExchange.findOne({ 'financial.exchangePaymentLinkId': paymentLinkEntity.id });
      if (!exchangeRequest && /^exchange_[a-f\d]{24}$/i.test(referenceId)) exchangeRequest = await ReturnExchange.findById(referenceId.slice(9));
      if (!exchangeRequest || exchangeRequest.type !== 'exchange') return res.json({ success: true, ignored: true });
      const expected = Math.round(Math.max(0, Number(exchangeRequest.financial?.exchangePriceDifference || 0)) * 100);
      const paid = Number(paymentLinkEntity.amount_paid ?? paymentEntity?.amount ?? 0);
      if (!expected || paid < expected) {
        await ReturnExchange.updateOne({ _id: exchangeRequest._id }, { $set: { 'financial.exchangeAdjustmentLastError': 'The payment link was marked paid without the full exchange difference.' } });
        notifyLater({ storeId: exchangeRequest.storeId, event: 'EXCHANGE_PAYMENT_ATTENTION', title: 'Exchange payment needs review', message: `Payment for exchange ${exchangeRequest.caseNumber || String(exchangeRequest._id).slice(-8).toUpperCase()} did not match the expected amount.`, channels: ['IN_APP'], metadata: { returnId: String(exchangeRequest._id), paymentLinkId: paymentLinkEntity.id } });
        return res.json({ success: true, ignored: true });
      }
      const result = await require('../services/exchangeAdjustmentService').settleExchangeAdjustment(exchangeRequest._id, {
        type: 'COLLECTED', reference: paymentEntity?.id || paymentLinkEntity.id, paymentId: paymentEntity?.id, source: 'WEBHOOK',
      });
      notifyLater({ userId: result.request.user, storeId: result.request.storeId, event: 'EXCHANGE_PAYMENT_RECEIVED', title: 'Exchange payment received', message: 'Your exchange price difference is paid. The replacement can now be allocated.', metadata: { orderId: String(result.order._id), returnId: String(result.request._id) } });
      logAudit({ req, source: 'WEBHOOK', action: 'EXCHANGE_PAYMENT_COLLECTED', entityType: 'ReturnExchange', entityId: result.request._id, storeId: result.request.storeId, after: { amount: paid / 100, paymentId: paymentEntity?.id, paymentLinkId: paymentLinkEntity.id } });
      return res.json({ success: true });
    } catch (error) {
      console.error('Razorpay exchange payment-link webhook processing failed:', error.message);
      return res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Webhook processing failed' });
    }
  }
  const razorpayOrderId = paymentEntity?.order_id || payload.payload?.order?.entity?.id || refundEntity?.notes?.order_id;
  const databaseOrderId = String(refundEntity?.notes?.orderId || '').trim();

  // Always acknowledge: Razorpay retries on any non-2xx, and a retry storm
  // for an event we cannot map to an order helps nobody.
  const refundPaymentId = event.startsWith('refund.') ? refundEntity?.payment_id : null;
  if (!razorpayOrderId && !refundPaymentId) return res.json({ success: true, ignored: true });
  let order = await Order.findOne(razorpayOrderId ? { razorpayOrderId } : { razorpayPaymentId: refundPaymentId });
  if (!order && /^[a-f\d]{24}$/i.test(databaseOrderId)) order = await Order.findById(databaseOrderId);

  if (!order) return res.json({ success: true, ignored: true });

  try {
    if (event === 'payment.captured' || event === 'order.paid') {
      await finalizePaidOrder(order._id, {
        razorpayPaymentId: paymentEntity?.id || order.razorpayPaymentId,
        note: 'Payment confirmed by Razorpay webhook', req, source: 'WEBHOOK',
      });
    } else if (event === 'payment.authorized') {
      const result = await Order.updateOne(
        { _id: order._id, paymentStatus: { $ne: 'Paid' } },
        { $set: { paymentState: 'AUTHORIZED' } },
      );
      if (result.modifiedCount) logAudit({ req, source: 'WEBHOOK', action: 'PAYMENT_AUTHORIZED', entityType: 'Order', entityId: order._id, storeId: order.storeId, after: { paymentState: 'AUTHORIZED' } });
    } else if (event === 'payment.failed') {
      await failUnpaidOrder(order, paymentEntity?.error_description || 'Payment failed at gateway', { req, source: 'WEBHOOK' });
    } else if (event === 'refund.processed') {
      const refunded = Number(refundEntity?.amount || 0) / 100;
      const refundId = String(refundEntity?.id || '').trim();
      if (refunded > 0 && refundId) {
        const claimed = await Order.findOneAndUpdate({
          _id: order._id,
          'refunds.providerRefundId': { $ne: refundId },
          $expr: { $lte: [{ $add: [{ $ifNull: ['$refundedAmount', 0] }, refunded] }, { $ifNull: ['$finalAmount', 0] }] },
        }, {
          $inc: { refundedAmount: refunded, revision: 1 },
          $push: {
            refunds: { providerRefundId: refundId, paymentId: refundEntity?.payment_id, provider: 'razorpay', amount: refunded, currency: String(refundEntity?.currency || 'INR').toUpperCase(), status: 'PROCESSED', note: 'Confirmed by Razorpay webhook', processedAt: new Date((Number(refundEntity?.created_at) || Date.now() / 1000) * 1000) },
            paymentEvents: { state: 'PARTIALLY_REFUNDED', status: 'Refund processed', amount: refunded, reference: refundId, note: 'Confirmed by Razorpay webhook', source: 'WEBHOOK', date: new Date() },
          },
        }, { new: true });
        if (claimed) {
          const totalRefunded = Math.min(Number(claimed.finalAmount || 0), Number(claimed.refundedAmount || 0));
          const isFullRefund = totalRefunded >= Number(claimed.finalAmount || 0);
          await Order.updateOne({ _id: claimed._id }, { $set: { refundedAmount: totalRefunded, paymentState: isFullRefund ? 'REFUNDED' : 'PARTIALLY_REFUNDED', ...(isFullRefund ? { paymentStatus: 'Refunded' } : {}) } });
          if (isFullRefund && claimed.couponConsumed && claimed.coupon?.restoreOnFullRefund) {
            await couponService.releaseCouponForFullyRefundedOrder(claimed._id);
          }
          logAudit({ req, source: 'WEBHOOK', action: 'PAYMENT_REFUND_PROCESSED', entityType: 'Order', entityId: claimed._id, storeId: claimed.storeId, before: { paymentState: order.paymentState, refundedAmount: order.refundedAmount || 0 }, after: { paymentState: isFullRefund ? 'REFUNDED' : 'PARTIALLY_REFUNDED', refundAmount: refunded, refundedAmount: totalRefunded, refundId } });
          notifyLater({
            userId: claimed.user, storeId: claimed.storeId, event: 'REFUND_PROCESSED',
            title: isFullRefund ? 'Refund processed' : 'Partial refund processed',
            message: `Your refund of Rs. ${refunded.toLocaleString('en-IN')} has been processed by the payment provider. The time it takes to appear depends on your bank.`,
            metadata: { orderId: String(claimed._id), refundId, amount: refunded },
          });
        } else if (order.paymentStatus === 'Refunded' && order.couponConsumed && order.coupon?.restoreOnFullRefund && !order.couponReleased) {
          // A provider retries webhooks when our previous response was lost.
          // Reconcile an unfinished coupon restoration without adding the refund twice.
          await couponService.releaseCouponForFullyRefundedOrder(order._id);
        }
        const refundReturnId = String(refundEntity?.notes?.returnId || refundEntity?.notes?.return_id || '').trim();
        const completedReturn = await ReturnExchange.findOneAndUpdate(
          { order: order._id, status: 'Refund Initiated', $or: [
            { 'financial.refundReference': refundId },
            ...(refundReturnId ? [{ _id: refundReturnId }] : []),
          ] },
          { $set: { status: 'Refunded', active: false, resolutionStatus: 'Refunded', completedAt: new Date(), 'financial.refundStatus': 'PROCESSED', 'financial.refundReference': refundId, 'financial.refundedAmount': refunded, 'financial.processedAt': new Date() }, $inc: { revision: 1 }, $push: { statusTimeline: { status: 'Refunded', note: 'Refund confirmed by Razorpay.', source: 'SYSTEM', date: new Date() } } },
          { new: true },
        );
        if (completedReturn) {
          await Order.updateOne({ _id: order._id, 'refunds.providerRefundId': refundId }, { $set: { 'refunds.$.sourceType': 'RETURN', 'refunds.$.sourceId': String(completedReturn._id) } });
          const returnCases = await ReturnExchange.find({ order: order._id });
          const currentOrder = claimed || order;
          const nextOrderStatus = returnOrderStatus(currentOrder, returnCases);
          if (nextOrderStatus !== currentOrder.orderStatus) {
            await Order.updateOne({ _id: order._id }, {
              $set: { orderStatus: nextOrderStatus },
              $inc: { revision: 1 },
              $push: { statusTimeline: { status: nextOrderStatus, date: new Date(), note: 'Return refund confirmed by Razorpay.' } },
            });
          }
          logAudit({ req, source: 'WEBHOOK', action: 'RETURN_REFUND_RECONCILED', entityType: 'ReturnExchange', entityId: completedReturn._id, storeId: completedReturn.storeId, after: { status: completedReturn.status, refundId, refundedAmount: refunded } });
        }
        const cancellationMatch = refundEntity?.notes?.purpose === 'order_cancellation'
          || String(order.cancellationRefund?.providerRefundId || '') === refundId;
        if (cancellationMatch) {
          await Order.updateOne({ _id: order._id, 'cancellationRefund.status': { $ne: 'PROCESSED' } }, { $set: {
            'cancellationRefund.status': 'PROCESSED', 'cancellationRefund.providerRefundId': refundId,
            'cancellationRefund.amount': refunded, 'cancellationRefund.processedAt': new Date(), 'cancellationRefund.lastError': '',
          }, $unset: { 'cancellationRefund.operation': 1, 'cancellationRefund.operationUntil': 1 } });
        }
        const itemOperationId = String(refundEntity?.notes?.operationId || '').trim();
        const itemCancellationMatch = refundEntity?.notes?.purpose === 'item_cancellation'
          || (order.itemCancellationRefunds || []).some(entry => String(entry.providerRefundId || '') === refundId);
        if (itemCancellationMatch) {
          const itemFilter = itemOperationId ? { 'refund.operationId': itemOperationId } : { 'refund.providerRefundId': refundId };
          await Order.updateOne({ _id: order._id }, { $set: { 'itemCancellationRefunds.$[refund].status': 'PROCESSED', 'itemCancellationRefunds.$[refund].providerRefundId': refundId, 'itemCancellationRefunds.$[refund].processedAt': new Date(), 'itemCancellationRefunds.$[refund].lastError': '' }, $unset: { 'itemCancellationRefunds.$[refund].nextCheckAt': 1 } }, { arrayFilters: [itemFilter] });
          await Order.updateOne({ _id: order._id, 'refunds.providerRefundId': refundId }, { $set: { 'refunds.$.sourceType': 'ITEM_CANCELLATION', 'refunds.$.sourceId': itemOperationId || refundId } });
        }
        const exchangeReturnId = String(refundEntity?.notes?.returnId || '').trim();
        const exchangeCreditMatch = refundEntity?.notes?.purpose === 'exchange_adjustment' && /^[a-f\d]{24}$/i.test(exchangeReturnId);
        if (exchangeCreditMatch) {
          const settled = await require('../services/exchangeAdjustmentService').settleExchangeAdjustment(exchangeReturnId, { type: 'CREDITED', reference: refundId, paymentId: refundEntity?.payment_id, source: 'WEBHOOK' });
          notifyLater({ userId: settled.request.user, storeId: settled.request.storeId, event: 'EXCHANGE_CREDIT_UPDATED', title: 'Exchange credit processed', message: `Your exchange credit of Rs. ${refunded.toLocaleString('en-IN')} has been processed.`, metadata: { orderId: String(order._id), returnId: String(settled.request._id), refundId } });
        }
        const rtoMatch = refundEntity?.notes?.purpose === 'order_rto' || String(order.rto?.refundReference || '') === refundId;
        if (rtoMatch) {
          await Order.updateOne({ _id: order._id }, { $set: { 'rto.refundStatus': 'PROCESSED', 'rto.refundReference': refundId, 'rto.status': 'REFUNDED', 'rto.notes': '' }, $unset: { 'rto.operation': 1, 'rto.operationUntil': 1 } });
          await Order.updateOne({ _id: order._id, 'refunds.providerRefundId': refundId }, { $set: { 'refunds.$.sourceType': 'RTO', 'refunds.$.sourceId': String(order._id) } });
        }
      }
    } else if (['refund.failed', 'refund.rejected'].includes(event)) {
      const refundId = String(refundEntity?.id || '').trim();
      const refundReturnId = String(refundEntity?.notes?.returnId || refundEntity?.notes?.return_id || '').trim();
      const reason = String(refundEntity?.error_description || refundEntity?.error_reason || refundEntity?.status || 'Payment provider rejected the refund.').slice(0, 500);
      const failedReturn = await ReturnExchange.findOneAndUpdate({ order: order._id, status: 'Refund Initiated', $or: [
        { 'financial.refundReference': refundId },
        ...(refundReturnId ? [{ _id: refundReturnId }] : []),
      ] }, { $set: { 'financial.refundStatus': 'FAILED', 'financial.lastRefundError': reason, 'financial.nextRefundCheckAt': new Date(Date.now() + 30 * 60 * 1000) }, $inc: { revision: 1 }, $push: { statusTimeline: { status: 'Refund Initiated', note: 'The payment provider could not complete this refund. Store support has been notified.', source: 'SYSTEM', date: new Date() } } }, { new: true });
      const cancellationMatch = refundEntity?.notes?.purpose === 'order_cancellation' || String(order.cancellationRefund?.providerRefundId || '') === refundId;
      if (cancellationMatch) await Order.updateOne({ _id: order._id }, { $set: { 'cancellationRefund.status': 'FAILED', 'cancellationRefund.lastError': reason, 'cancellationRefund.nextCheckAt': new Date(Date.now() + 30 * 60 * 1000) } });
      const itemOperationId = String(refundEntity?.notes?.operationId || '').trim();
      const itemCancellationMatch = refundEntity?.notes?.purpose === 'item_cancellation' || (order.itemCancellationRefunds || []).some(entry => String(entry.providerRefundId || '') === refundId);
      if (itemCancellationMatch) {
        const itemFilter = itemOperationId ? { 'refund.operationId': itemOperationId } : { 'refund.providerRefundId': refundId };
        await Order.updateOne({ _id: order._id }, { $set: { 'itemCancellationRefunds.$[refund].status': 'FAILED', 'itemCancellationRefunds.$[refund].lastError': reason, 'itemCancellationRefunds.$[refund].nextCheckAt': new Date(Date.now() + 30 * 60 * 1000) } }, { arrayFilters: [itemFilter] });
      }
      const exchangeReturnId = String(refundEntity?.notes?.returnId || '').trim();
      const exchangeCreditMatch = refundEntity?.notes?.purpose === 'exchange_adjustment' && /^[a-f\d]{24}$/i.test(exchangeReturnId);
      if (exchangeCreditMatch) await ReturnExchange.updateOne({ _id: exchangeReturnId, 'financial.exchangeAdjustmentStatus': { $ne: 'SETTLED' } }, { $set: { 'financial.exchangeAdjustmentStatus': 'FAILED', 'financial.exchangeAdjustmentLastError': reason }, $inc: { revision: 1 } });
      const rtoMatch = refundEntity?.notes?.purpose === 'order_rto' || String(order.rto?.refundReference || '') === refundId;
      if (rtoMatch) await Order.updateOne({ _id: order._id }, { $set: { 'rto.refundStatus': 'FAILED', 'rto.status': 'REFUND_PENDING', 'rto.notes': reason } });
      if (failedReturn || cancellationMatch || itemCancellationMatch || exchangeCreditMatch || rtoMatch) {
        notifyLater({ storeId: order.storeId, event: 'REFUND_ATTENTION', title: 'Refund needs attention', message: `Refund for order ${order.invoiceNumber || String(order._id).slice(-8).toUpperCase()} failed at the payment provider.`, channels: ['IN_APP'], metadata: { orderId: String(order._id), returnId: failedReturn ? String(failedReturn._id) : undefined, refundId } });
        logAudit({ req, source: 'WEBHOOK', action: 'PAYMENT_REFUND_FAILED', entityType: failedReturn ? 'ReturnExchange' : 'Order', entityId: failedReturn?._id || order._id, storeId: order.storeId, after: { refundId, reason } });
      }
    }
  } catch (error) {
    console.error('Razorpay webhook processing failed:', error.message);
    return res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Webhook processing failed' });
  }

  return res.json({ success: true });
}

/**
 * Records an abandoned or failed attempt against the pending order.
 *
 * Stock is reserved when the Razorpay order is created, so failure must
 * restore it exactly once through the same cancellation path COD uses.
 */
async function recordPaymentFailure(req, res) {
  assertCheckoutReady(req);

  const reason = String(req.body.reason || 'Payment failed. Please retry or choose Cash on Delivery.').trim().slice(0, 300);
  const razorpayOrderId = req.body.razorpayOrderId || req.body.razorpay_order_id;

  if (!razorpayOrderId) {
    return res.status(202).json({ success: false, message: reason, order: null });
  }

  const order = await Order.findOne({ razorpayOrderId, user: req.user._id });
  if (!order) return res.status(202).json({ success: false, message: reason, order: null });

  if (['Paid', 'Refunded'].includes(order.paymentStatus)) {
    return res.status(409).json({ success: false, code: 'DUPLICATE_REQUEST', message: order.paymentStatus === 'Refunded' ? 'This payment has already been refunded' : 'Order is already paid', order });
  }

  const updated = await failUnpaidOrder(order, reason, { req, source: 'CUSTOMER' });
  recordEventLater({
    name: 'PAYMENT_FAILED',
    storeId: order.storeId,
    userId: req.user._id,
    orderId: order._id,
  });
  return res.status(202).json({ success: false, message: reason, order: updated || order });
}

async function failUnpaidOrder(order, reason, { req, source = 'SYSTEM' } = {}) {
  if (!order || ['Paid', 'Refunded'].includes(order.paymentStatus)) return order;

  const cancelled = order.orderStatus === 'Cancelled'
    ? order
    : await cancelOrderInternal(order, { req, source, actor: req?.user, note: reason });

  const previous = await Order.findOneAndUpdate(
    { _id: order._id, paymentStatus: { $nin: ['Paid', 'Refunded'] } },
    {
      $set: {
        paymentStatus: 'Failed',
        paymentState: 'FAILED',
        paymentFailureReason: reason,
      },
      $inc: { revision: 1 },
      $push: { paymentEvents: { state: 'FAILED', status: 'Failed', note: reason, source, date: new Date() } },
    },
    { new: false },
  );
  if (!previous) return cancelled;
  if (previous.paymentStatus !== 'Failed') notifyLater({
    userId: order.user, storeId: order.storeId, event: 'PAYMENT_FAILED',
    title: 'Payment was not completed',
    message: 'Your payment attempt was unsuccessful. Open your order for details and help with any amount debited.',
    metadata: { orderId: String(order._id) },
  });
  if (previous.paymentStatus !== 'Failed') logAudit({ req, source, action: 'PAYMENT_FAILED', entityType: 'Order', entityId: order._id, storeId: order.storeId, before: { paymentStatus: previous.paymentStatus }, after: { paymentStatus: 'Failed' }, summary: source === 'CUSTOMER' ? 'Customer reported a failed or abandoned payment attempt' : 'Payment gateway reported a failed payment' });
  previous.paymentStatus = 'Failed';
  previous.paymentState = 'FAILED';
  previous.paymentFailureReason = reason;
  return previous;
}

async function expirePendingPaymentOrders({ now = new Date(), limit = 50 } = {}) {
  const minutes = Math.max(5, Number(process.env.PAYMENT_RESERVATION_MINUTES || process.env.INVENTORY_RESERVATION_MINUTES || 20));
  const cutoff = new Date(now.getTime() - minutes * 60 * 1000);
  const orders = await Order.find({
    paymentProvider: 'Razorpay',
    paymentStatus: 'Pending',
    orderStatus: 'Pending',
    createdAt: { $lte: cutoff },
  }).sort({ createdAt: 1 }).limit(Math.max(1, Math.min(Number(limit) || 50, 200)));
  let expired = 0;
  for (const order of orders) {
    try {
      await failUnpaidOrder(order, 'Online payment window expired; reserved stock and coupon capacity were released.', { source: 'PAYMENT_EXPIRY' });
      expired += 1;
    } catch (error) {
      console.error(`Pending payment cleanup failed for ${order._id}: ${error.message}`);
    }
  }
  return { expired };
}

module.exports = {
  createPaymentOrder,
  expirePendingPaymentOrders,
  finalizePaidOrder,
  razorpayWebhook,
  recordPaymentFailure,
  verifyPayment,
};
