const Order = require('../models/Order');
const crypto = require('node:crypto');
const Settings = require('../models/Settings');
const InventoryTransaction = require('../models/InventoryTransaction');
const couponService = require('../services/couponService');
const InventoryItem = require('../models/InventoryItem');
const { refreshCustomerRisk, snapshotForOrder } = require('../services/fraudProtectionService');
const inventoryService = require('../services/inventoryService');
const { buildOrderDraft } = require('../services/orderPricingService');
const { applyCustomerRtoToPaymentOptions, buildPaymentOptions, getStoreSettings } = require('../services/paymentSettingsService');
const { isRazorpayConfigured } = require('../services/razorpayService');
const { runInTransaction } = require('../utils/transaction');
const { ApiError, forbidden, notFound } = require('../utils/apiError');
const { asyncHandler } = require('../middleware/validate');
const { readPagination, requireEnum, requireObjectId, requireString, optionalString, wantsPagination, buildPaginatedResponse } = require('../utils/validators');
const { syncPaidOnlineOrderStatus } = require('../utils/orderStatusUtils');
const { buildPersistedOrderFields } = require('../services/orderSnapshotService');
const { notifyLater } = require('../services/notificationService');
const { toShipmentStatus, upsertShipmentForOrder, saveManualShipment } = require('../services/shippingService');
const { andFilter } = require('../services/storeService');
const { readAttribution } = require('../utils/attribution');
const { logAudit } = require('../services/auditService');
const { recordEventLater } = require('../services/analyticsService');
const { normalizeIndianMobile } = require('../utils/phoneUtils');
const { adminOrderFilter } = require('../services/dashboardAnalytics');
const { assertOrderTransition, canCancelOrder, publicWorkflow } = require('../services/orderWorkflowService');
const { applyCustomerRestrictionsToPaymentOptions, assertCustomerCanCheckout, getCustomerRestrictions } = require('../services/customerAccessService');
const { checkoutAttemptId, checkoutFingerprint, checkoutCartItems, consumePurchasedCart, findCheckoutReplay, isDuplicateKey } = require('../services/checkoutSafetyService');
const { processCancellationRefund, processItemCancellationRefund, processRtoRefund, recordProviderRefund } = require('../services/paymentRefundService');
const { refundEstimate, returnPolicySettings } = require('../services/returnWorkflowService');
const { assertCodDispatchable, evaluateCodVerification, orderSnapshot, publicVerification, sendOrderOtp, verifyOrderOtp } = require('../services/codVerificationService');

const ORDER_STATUSES = ['Pending', 'Confirmed', 'Packed', 'Shipped', 'Out for Delivery', 'Delivered', 'Cancelled', 'Return Requested', 'Exchange Requested', 'Returned', 'Refunded'];
const PAYMENT_STATUSES = ['Pending', 'Paid', 'Failed', 'Refunded'];
const CANCELLABLE_STATUSES = ['Pending', 'Confirmed', 'Packed'];
const MANUAL_PAYMENT_TRANSITIONS = { Pending: ['Paid'], Paid: ['Refunded'] };

function revisionFilter(value) {
  const revision = Number(value || 0);
  return revision === 0 ? { $or: [{ revision: 0 }, { revision: { $exists: false } }] } : { revision };
}

function assertCurrentRevision(order, supplied) {
  if (supplied === undefined || supplied === null || supplied === '') return Number(order.revision || 0);
  const value = Number(supplied);
  if (!Number.isInteger(value) || value < 0) throw new ApiError('VALIDATION_ERROR', 'A valid order revision is required.');
  if (value !== Number(order.revision || 0)) throw new ApiError('ORDER_CHANGED', 'This order changed in another session. Reload it before continuing.', { statusCode: 409 });
  return value;
}

function managerRequest(req) {
  return req.user?.role === 'admin' || Boolean(req.storeMember);
}

function actorSnapshot(req) {
  return { id: String(req.user?._id || ''), name: String(req.user?.name || req.user?.phone || 'Staff').slice(0, 100), role: String(req.storeMember?.role || req.user?.role || 'SYSTEM') };
}

function decorateOrder(order, options = {}) {
  if (!order) return order;
  const value = order.toObject ? order.toObject() : { ...order };
  return { ...value, ...publicWorkflow(value, value.shipment, options) };
}

function publicCustomerOrder(order) {
  const value = order?.toObject ? order.toObject() : { ...(order || {}) };
  delete value.packageVerification;
  delete value.fraudProtectionSnapshot;
  if (value.codVerification) value.codVerification = publicVerification(value.codVerification);
  if (value.deliveryProof) delete value.deliveryProof.deliveryOtpVerified;
  if (value.shipment) value.shipment = require('../services/deliveryService').publicShipment(value.shipment, { customer: true });
  value.orderItems = (value.orderItems || []).map(item => { const copy = { ...item }; delete copy.uniqueItemIds; return copy; });
  return value;
}

function fraudOrderFields(settings, finalAmount) {
  const snapshot = snapshotForOrder(settings, finalAmount);
  const { packageStatus, ...fraudProtectionSnapshot } = snapshot;
  return { fraudProtectionSnapshot, packageVerification: { status: packageStatus } };
}

function assertCheckoutReady(req) {
  if (!req.user?.isPhoneVerified) {
    throw new ApiError('FORBIDDEN', 'Please verify your mobile number to continue checkout.');
  }
}

function assertShippingAddress(address) {
  if (!address || typeof address !== 'object') {
    throw new ApiError('VALIDATION_ERROR', 'Please select a delivery address');
  }
  const clean = require('../services/orderSnapshotService').snapshotAddress(address);
  const pincode = clean.pincode;
  if (!/^\d{6}$/.test(pincode)) throw new ApiError('VALIDATION_ERROR', 'Please select an address with a valid 6-digit pincode');
  if (!clean.fullName) throw new ApiError('VALIDATION_ERROR', 'Delivery address needs a contact name');
  if (!/^[6-9]\d{9}$/.test(clean.mobile)) {
    throw new ApiError('VALIDATION_ERROR', 'Delivery address needs a valid 10-digit mobile number');
  }
  for (const [field, label] of [['houseNo', 'house or flat number'], ['area', 'street or area'], ['city', 'city'], ['state', 'state']]) {
    if (!clean[field]) throw new ApiError('VALIDATION_ERROR', `Delivery address needs a ${label}`);
  }
  const lengths = { fullName: 100, alternateMobile: 20, state: 100, city: 100, houseNo: 160, area: 300, landmark: 200, addressType: 30 };
  for (const [field, max] of Object.entries(lengths)) if (clean[field]?.length > max) throw new ApiError('VALIDATION_ERROR', `Delivery address ${field} is too long`);
  if (clean.alternateMobile && !/^[6-9]\d{9}$/.test(normalizeIndianMobile(clean.alternateMobile))) throw new ApiError('VALIDATION_ERROR', 'Alternate mobile number must be a valid 10-digit number');
  return clean;
}

function isOwnerOrAdmin(order, user, req) {
  const ownerId = String(order.user?._id || order.user || '');
  if (user.role === 'admin' || ownerId === String(user._id)) return true;
  if (req?.storeMember && req?.store?._id && order.storeId && String(order.storeId) === String(req.store._id)) return true;
  return false;
}

/**
 * Returns the authoritative price breakdown plus the payment methods the
 * store currently allows. The checkout screen renders this instead of
 * calculating totals in the browser.
 */
exports.quoteOrder = asyncHandler(async (req, res) => {
  const customerRestrictions = await getCustomerRestrictions({ storeId: req.store?._id, userId: req.user?._id });
  await assertCustomerCanCheckout({ storeId: req.store?._id, userId: req.user?._id, paymentMethod: req.body?.paymentMethod });
  const settings = await getStoreSettings(req.tenantFilter || {});
  const initialPaymentOptions = await applyCustomerRtoToPaymentOptions(buildPaymentOptions(settings, {
    razorpayConfigured: isRazorpayConfigured(), pincode: req.body?.shippingAddress?.pincode,
  }), { userId: req.user?._id, settings, tenantFilter: req.tenantFilter });
  const paymentOptions = applyCustomerRestrictionsToPaymentOptions(initialPaymentOptions, customerRestrictions);

  if (!Array.isArray(req.body?.orderItems) || !req.body.orderItems.length) {
    return res.json({ paymentOptions, totals: null });
  }

  const draft = await buildOrderDraft({
    orderItems: req.body.orderItems,
    couponCode: req.body.coupon?.code || req.body.couponCode,
    paymentMethod: req.body.paymentMethod,
    settings,
    userId: req.user?._id,
    shippingAddress: req.body.shippingAddress,
    tenantFilter: req.tenantFilter,
  });

  return res.json({
    paymentMethod: draft.paymentMethod,
    shipping: draft.shippingQuote,
    totals: draft.totals,
    items: draft.items,
    paymentOptions: applyCustomerRestrictionsToPaymentOptions(await applyCustomerRtoToPaymentOptions(buildPaymentOptions(settings, {
      razorpayConfigured: isRazorpayConfigured(),
      orderAmount: draft.totals.finalAmount - draft.totals.codCharge,
      pincode: req.body?.shippingAddress?.pincode,
    }), { userId: req.user?._id, settings, tenantFilter: req.tenantFilter }), customerRestrictions),
  });
});

/**
 * COD checkout. Order creation, stock deduction and coupon consumption are
 * applied together so we never end up with an order whose stock was never
 * taken, or stock taken for an order that failed to save.
 */
exports.createOrder = asyncHandler(async (req, res) => {
  assertCheckoutReady(req);
  const requestedMethod = String(req.body?.paymentMethod || 'COD').toUpperCase();
  if (requestedMethod !== 'COD') throw new ApiError('PAYMENT_METHOD_UNAVAILABLE', 'Online orders must be created through the secure payment checkout.');
  const attemptId = checkoutAttemptId(req);
  const fingerprint = checkoutFingerprint(req.body, 'COD');
  const existing = await findCheckoutReplay({ userId: req.user._id, attemptId, fingerprint });
  if (existing) {
    await consumePurchasedCart(existing).catch(() => null);
    return res.status(200).json(publicCustomerOrder(existing));
  }
  await assertCustomerCanCheckout({ storeId: req.store?._id, userId: req.user?._id, paymentMethod: 'COD' });

  const shippingAddress = assertShippingAddress(req.body?.shippingAddress);
  const draft = await buildOrderDraft({
    orderItems: req.body?.orderItems,
    couponCode: req.body?.coupon?.code,
    paymentMethod: req.body?.paymentMethod || 'COD',
    userId: req.user?._id,
    shippingAddress,
    tenantFilter: req.tenantFilter,
  });

  const codDecision = await evaluateCodVerification({
    paymentMethod: 'COD', userId: req.user._id, storeId: draft.storeId || req.store?._id,
    settings: draft.settings || {}, phoneVerified: Boolean(req.user.isPhoneVerified),
  });
  if (!codDecision.codAllowed) throw new ApiError('PAYMENT_METHOD_UNAVAILABLE', 'COD is currently unavailable for this order. Please select an online payment method.');

  require('../services/shippingRules').assertQuotedTotal(draft, req.body?.expectedTotal);
  const cartItems = checkoutCartItems(req.body);
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
          codConfirmationStatus: codDecision.verificationRequired ? 'PENDING' : 'NOT_REQUIRED',
          codVerification: orderSnapshot(codDecision, req.user.phone),
          paymentProvider: draft.paymentMethod === 'COD' ? 'COD' : 'Razorpay',
          paymentStatus: 'Pending',
          paymentState: 'PENDING',
          orderStatus: 'Pending',
          inventoryDeducted: true,
          inventoryDeductedAt: new Date(),
          couponConsumed: Boolean(draft.totals.coupon?.code),
          statusTimeline: [{ status: 'Pending', date: new Date(), note: 'Order placed' }],
          ...fraudOrderFields(draft.settings, draft.totals.finalAmount),
          paymentEvents: [{ state: 'PENDING', status: 'Pending', amount: draft.totals.finalAmount, source: 'CHECKOUT', note: draft.paymentMethod === 'COD' ? 'Payment due on delivery' : 'Awaiting online payment', date: new Date() }],
        },
      }),
    }], session ? { session } : {});

    let stockTaken = false;
    try {
      await inventoryService.deductStockForOrder(draft.items, {
        orderId: created._id,
        userId: req.user._id,
        reason: 'Order placed',
        session,
      });
      stockTaken = true;

      if (draft.totals.coupon?.code) {
        await couponService.consumeCoupon(draft.totals.coupon.code, { session, userId: req.user._id, discountAmount: draft.totals.coupon.savingAmount, couponId: draft.totals.coupon.couponId });
      }
    } catch (error) {
      // A transaction rolls all of this back on its own. Without one, undo the
      // side effects by hand so a coupon failure cannot leave stock consumed
      // by an order that was never created.
      if (!session) {
        if (stockTaken) {
          await inventoryService.restoreStockForOrder(draft.items, {
            orderId: created._id,
            userId: req.user._id,
            type: 'CANCELLATION',
            reason: 'Checkout failed after stock was reserved',
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
    if (!isDuplicateKey(error)) throw error;
    order = await findCheckoutReplay({ userId: req.user._id, attemptId, fingerprint });
    if (!order) throw error;
    replayed = true;
  }

  await consumePurchasedCart(order).catch(() => null);
  if (replayed) return res.status(200).json(publicCustomerOrder(order));

  logAudit({ req, action: 'ORDER_CREATE', entityType: 'Order', entityId: order._id, storeId: order.storeId, after: { orderStatus: order.orderStatus, paymentStatus: order.paymentStatus, paymentMethod: order.paymentMethod, finalAmount: order.finalAmount } });

  recordEventLater({
    name: 'PURCHASE',
    storeId: order.storeId,
    userId: req.user._id,
    orderId: order._id,
    source: order.attribution?.source,
    campaign: order.attribution?.campaign,
    reelId: order.attribution?.reelId,
  });

  notifyLater({
    userId: req.user._id,
    storeId: order.storeId,
    event: 'ORDER_PLACED',
    title: 'Order placed',
    message: `Your order ${order.invoiceNumber || ''} has been placed.`,
    metadata: { orderId: String(order._id) },
  });
  require('../services/orderAlertService').queueLater(order._id);

  let verificationDelivery = null;
  if (order.codVerification?.required && order.codVerification.status === 'PENDING') {
    try { verificationDelivery = await sendOrderOtp({ order, phone: req.user.phone, req }); }
    catch (deliveryError) { verificationDelivery = { required: true, status: 'PENDING', deliveryStatus: 'FAILED', message: deliveryError.message }; }
  }
  const response = publicCustomerOrder(order);
  if (verificationDelivery) response.codVerificationDelivery = verificationDelivery;
  res.status(201).json(response);
});

exports.createCodOrder = (req, res, next) => {
  req.body = { ...(req.body || {}), paymentMethod: 'COD', paymentProvider: 'COD' };
  return exports.createOrder(req, res, next);
};

exports.sendCodVerification = asyncHandler(async (req, res) => {
  requireObjectId(req.params.id, 'order id');
  const order = await Order.findOne(andFilter({ _id: req.params.id, user: req.user._id }, req.tenantFilter));
  if (!order) throw notFound('Order not found');
  const result = await sendOrderOtp({ order, phone: req.user.phone, req });
  logAudit({ req, action: 'ORDER_COD_OTP_SENT', entityType: 'Order', entityId: order._id, storeId: order.storeId, after: { status: result.status } });
  res.json(result);
});

exports.verifyCodVerification = asyncHandler(async (req, res) => {
  requireObjectId(req.params.id, 'order id');
  const otp = requireString(req.body?.otp, 'OTP', { max: 6 });
  if (!/^\d{6}$/.test(otp)) throw new ApiError('VALIDATION_ERROR', 'Enter the 6-digit verification code.');
  const order = await Order.findOne(andFilter({ _id: req.params.id, user: req.user._id }, req.tenantFilter));
  if (!order) throw notFound('Order not found');
  const updated = await verifyOrderOtp({ order, phone: req.user.phone, otp, tenantFilter: req.tenantFilter });
  logAudit({ req, action: 'ORDER_COD_VERIFIED', entityType: 'Order', entityId: updated._id, storeId: updated.storeId, after: { orderStatus: updated.orderStatus, codConfirmationStatus: updated.codConfirmationStatus } });
  notifyLater({ userId: req.user._id, storeId: updated.storeId, event: 'ORDER_CONFIRMED', title: 'Order confirmed', message: `Your COD order ${updated.invoiceNumber || ''} is confirmed.`, metadata: { orderId: String(updated._id) } });
  res.json(publicCustomerOrder(updated));
});

exports.myOrders = asyncHandler(async (req, res) => {
  const filter = { user: req.user._id };
  if (req.query.status) filter.orderStatus = requireEnum(req.query.status, ORDER_STATUSES, 'status');
  const search = optionalString(req.query.search, 'search', { max: 100 });
  if (search) {
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [{ 'orderItems.name': { $regex: escaped, $options: 'i' } }, { invoiceNumber: { $regex: escaped, $options: 'i' } }];
    if (/^[a-f\d]{24}$/i.test(search)) filter.$or.push({ _id: search });
    else if (/^[a-f\d]{6,23}$/i.test(search)) filter.$or.push({ $expr: { $regexMatch: { input: { $toString: '$_id' }, regex: `${escaped}$`, options: 'i' } } });
  }
  if (req.query.days) {
    const days = Number(req.query.days);
    if (![30, 180, 365].includes(days)) throw new ApiError('VALIDATION_ERROR', 'Invalid order date filter');
    filter.createdAt = { $gte: new Date(Date.now() - days * 86400000) };
  }
  const paginated = wantsPagination(req.query);
  const { page, limit, skip } = readPagination(req.query, { defaultLimit: paginated ? 12 : 200, maxLimit: 200 });
  const orders = await Order.find(filter).populate('shipment').sort('-createdAt').skip(skip).limit(limit);
  await Promise.all(orders.map((order) => syncPaidOnlineOrderStatus(order)));
  const publicOrders = orders.map(publicCustomerOrder);
  if (paginated) return res.json(buildPaginatedResponse(publicOrders, { page, limit, total: await Order.countDocuments(filter) }));
  res.json(publicOrders);
});

exports.getOrder = asyncHandler(async (req, res) => {
  requireObjectId(req.params.id, 'order id');
  let query = Order.findOne(andFilter({ _id: req.params.id }, req.tenantFilter)).populate('user', 'name email phone isPhoneVerified').populate('shipment');
  if (managerRequest(req)) query = query.select('+staffNotes +paymentEvents');
  const order = await query;
  if (!order) throw notFound('Order not found');
  if (!isOwnerOrAdmin(order, req.user, req)) throw forbidden('Not allowed to view this order');
  await syncPaidOnlineOrderStatus(order);
  if (!managerRequest(req)) return res.json(publicCustomerOrder(order));
  const ReturnExchange = require('../models/ReturnExchange');
  const [returnRequests, customerRisk] = await Promise.all([
    ReturnExchange.find(andFilter({ order: order._id }, req.tenantFilter)).populate('product', 'name images sku').sort('-createdAt').lean(),
    refreshCustomerRisk({ storeId: order.storeId, userId: order.user?._id || order.user }),
  ]);
  const hasOpenReturn = returnRequests.some(item => !['Rejected', 'Refunded', 'Exchanged', 'Closed'].includes(item.status));
  const canRecordRefund = returnRequests.some(item => item.status === 'Refunded' || item.resolutionStatus === 'Refunded');
  res.json({ ...decorateOrder(order, { hasOpenReturn, canRecordRefund }), returnRequests, customerRisk });
});

exports.adminOrders = asyncHandler(async (req, res) => {
  let filter = await adminOrderFilter(req.query, req.tenantFilter);
  if (req.query.deliveryStatus || req.query.deliveryIssue) {
    const Shipment = require('../models/Shipment');
    if (req.query.deliveryIssue && req.query.deliveryIssue !== '1') throw new ApiError('VALIDATION_ERROR', 'Choose a valid delivery issue filter.');
    const status = req.query.deliveryIssue ? null : requireEnum(req.query.deliveryStatus, Shipment.SHIPMENT_STATUSES, 'delivery status');
    const shipments = await Shipment.find(andFilter({ status: status || { $in: ['EXCEPTION', 'FAILED'] } }, req.tenantFilter)).select('_id').lean();
    const booked = { shipment: { $in: shipments.map(s => s._id) } };
    filter = andFilter(filter, status === 'WAITING' ? { $or: [booked, { shipment: null, orderStatus: { $in: ['Pending', 'Confirmed', 'Packed'] } }] } : booked);
  }
  const sort = { newest: { createdAt: -1, _id: -1 }, oldest: { createdAt: 1, _id: 1 }, dispatch_sla: { createdAt: 1, _id: 1 }, amount_high: { finalAmount: -1, createdAt: -1 }, amount_low: { finalAmount: 1, createdAt: -1 } }[req.query.sort || 'newest'];
  if (!sort) throw new ApiError('VALIDATION_ERROR', 'Choose a valid order sort.');
  const finder = () => Order.find(filter).populate('user', 'name email phone').populate('shipment', 'provider courierName status awb trackingNumber bookingState expectedDeliveryAt labelAvailable pickup operation').sort(sort);
  if (wantsPagination(req.query)) {
    const { page, limit, skip } = readPagination(req.query, { defaultLimit: 24, maxLimit: 100 });
    const [items, total] = await Promise.all([
      finder().skip(skip).limit(limit),
      Order.countDocuments(filter),
    ]);
    return res.json({ ...buildPaginatedResponse(items.map(item => decorateOrder(item)), { page, limit, total }) });
  }
  const { limit, skip } = readPagination(req.query, { defaultLimit: 200, maxLimit: 500 });
  res.json((await finder().skip(skip).limit(limit)).map(item => decorateOrder(item)));
});

exports.orderWorkspaceSummary = asyncHandler(async (req, res) => {
  const Shipment = require('../models/Shipment');
  const ReturnExchange = require('../models/ReturnExchange');
  const { dashboardRange, periodFilter } = require('../services/dashboardAnalytics');
  const scope = filter => andFilter(filter, req.tenantFilter);
  const booked = { orderStatus: { $nin: ['Cancelled', 'Returned', 'Refunded'] }, $or: [{ paymentMethod: 'COD' }, { paymentStatus: 'Paid' }] };
  const today = periodFilter(dashboardRange({ range: 'today' }));
  const [pending, packing, todayPacking, dispatch, transit, exceptions, returns, resolution, rto, codRows] = await Promise.all([
    Order.countDocuments(scope({ ...booked, orderStatus: 'Pending' })),
    Order.countDocuments(scope({ ...booked, orderStatus: 'Confirmed' })),
    Order.countDocuments(scope(andFilter({ ...booked, orderStatus: 'Confirmed' }, today))),
    Order.countDocuments(scope({ ...booked, orderStatus: 'Packed' })),
    Order.countDocuments(scope({ orderStatus: { $in: ['Shipped', 'Out for Delivery'] } })),
    Shipment.countDocuments(scope({ status: { $in: ['EXCEPTION', 'FAILED'] } })),
    ReturnExchange.countDocuments(scope({ status: { $in: ['Requested', 'Approved', 'Pickup Scheduled', 'Picked Up', 'In Transit', 'Received', 'Inspection Pending', 'Verified', 'Mismatch Found', 'QC Passed', 'Refund Initiated', 'Exchange Allocated', 'Replacement Shipped', 'Replacement Delivered'] } })),
    Order.countDocuments(scope({ $or: [{ 'cancellationRefund.status': { $in: ['FAILED', 'MANUAL_REQUIRED'] } }, { itemCancellationRefunds: { $elemMatch: { status: { $in: ['FAILED', 'MANUAL_REQUIRED'] } } } }, { 'rto.refundStatus': { $in: ['FAILED', 'MANUAL_REQUIRED'] } }] })),
    Order.countDocuments(scope({ 'rto.status': { $in: ['IN_TRANSIT', 'RECEIVED', 'QC_PENDING', 'RESTOCKED', 'QUARANTINED', 'DAMAGED', 'MISSING', 'REFUND_PENDING'] } })),
    Order.aggregate([
      { $match: scope({ orderStatus: 'Delivered', paymentMethod: 'COD', paymentStatus: 'Pending' }) },
      { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: { $ifNull: ['$adjustedFinalAmount', '$finalAmount'] } } } },
    ]),
  ]);
  res.json({ pending, packing, todayPacking, dispatch, transit, exceptions, returns, resolution, rto, codCollection: codRows[0]?.count || 0, codCollectionAmount: codRows[0]?.amount || 0 });
});

exports.addStaffNote = asyncHandler(async (req, res) => {
  requireObjectId(req.params.id, 'order id');
  const text = requireString(req.body?.text, 'note', { max: 1000 });
  const order = await Order.findOne(andFilter({ _id: req.params.id }, req.tenantFilter)).select('+staffNotes +paymentEvents');
  if (!order) throw notFound('Order not found');
  const expectedRevision = assertCurrentRevision(order, req.body?.revision);
  const entry = { text, author: actorSnapshot(req), date: new Date() };
  const updated = await Order.findOneAndUpdate(andFilter({ _id: order._id, ...revisionFilter(expectedRevision) }, req.tenantFilter), {
    $inc: { revision: 1 },
    $push: { staffNotes: { $each: [entry], $slice: -100 } },
  }, { new: true }).select('+staffNotes +paymentEvents').populate('user', 'name email phone').populate('shipment');
  if (!updated) throw new ApiError('ORDER_CHANGED', 'This order changed in another session. Reload it before continuing.', { statusCode: 409 });
  logAudit({ req, action: 'ORDER_STAFF_NOTE_ADD', entityType: 'Order', entityId: updated._id, storeId: updated.storeId, after: { note: text }, summary: 'Private order note added' });
  res.json(decorateOrder(updated));
});

exports.updateShippingAddress = asyncHandler(async (req, res) => {
  requireObjectId(req.params.id, 'order id');
  const reason = requireString(req.body?.reason, 'reason', { max: 300 });
  const address = assertShippingAddress(req.body?.shippingAddress);
  const order = await Order.findOne(andFilter({ _id: req.params.id }, req.tenantFilter)).populate('shipment');
  if (!order) throw notFound('Order not found');
  const expectedRevision = assertCurrentRevision(order, req.body?.revision);
  if (!['Pending', 'Confirmed', 'Packed'].includes(order.orderStatus)) throw new ApiError('ORDER_TRANSITION_INVALID', 'The delivery address is locked after the parcel leaves the store.', { statusCode: 409 });
  if (order.shipment?.awb || ['BOOKING', 'BOOKED', 'UNKNOWN'].includes(order.shipment?.bookingState)) throw new ApiError('SHIPPING_VALIDATION', 'Cancel the uncollected courier booking before changing this address.');

  const settings = await getStoreSettings(req.tenantFilter || {});
  const merchandiseAmount = Math.max(0, Number(order.finalAmount || 0) - Number(order.deliveryCharge || 0) - Number(order.codCharge || 0) - Number(order.platformFee || 0) + Number(order.prepaidDiscount || 0));
  const quote = await require('../services/deliveryService').checkoutShipping({ items: order.orderItems, settings, address, paymentMethod: order.paymentMethod, amount: merchandiseAmount });
  if (Math.abs(Number(quote.deliveryCharge || 0) - Number(order.deliveryCharge || 0)) > 0.01) throw new ApiError('SHIPPING_QUOTE_CHANGED', 'This PIN code changes the agreed delivery charge. Cancel and place a corrected order instead of changing the customer total.', { statusCode: 409 });
  const before = order.shippingAddress;
  const updated = await Order.findOneAndUpdate(andFilter({ _id: order._id, ...revisionFilter(expectedRevision) }, req.tenantFilter), {
    $set: { shippingAddress: address, shippingQuote: quote },
    $inc: { revision: 1 },
    $push: { statusTimeline: { status: order.orderStatus, date: new Date(), note: `Delivery address corrected: ${reason}` } },
  }, { new: true }).select('+staffNotes +paymentEvents').populate('user', 'name email phone').populate('shipment');
  if (!updated) throw new ApiError('ORDER_CHANGED', 'This order changed in another session. Reload it before continuing.', { statusCode: 409 });
  logAudit({ req, action: 'ORDER_ADDRESS_UPDATE', entityType: 'Order', entityId: updated._id, storeId: updated.storeId, before: { shippingAddress: before }, after: { shippingAddress: address }, summary: reason });
  res.json(decorateOrder(updated));
});

exports.updateOrderStatus = asyncHandler(async (req, res) => {
  requireObjectId(req.params.id, 'order id');
  const orderStatus = requireEnum(req.body?.orderStatus, ORDER_STATUSES, 'orderStatus');
  const note = optionalString(req.body?.note, 'note', { max: 300 });

  const order = await Order.findOne(andFilter({ _id: req.params.id }, req.tenantFilter));
  if (!order) throw notFound('Order not found');
  const expectedRevision = assertCurrentRevision(order, req.body?.revision);
  const shipment = await require('../models/Shipment').findOne({ order: order._id });

  if (orderStatus === 'Cancelled') {
    if (!canCancelOrder(order, shipment)) throw new ApiError('ORDER_NOT_CANCELLABLE', 'This order is already with the courier or completed. Use the return/RTO workflow instead of restoring stock through cancellation.');
    return res.json(decorateOrder(await cancelOrderInternal(order, { req, actor: req.user, note: note || 'Cancelled by staff', reasonCode: optionalString(req.body?.reasonCode, 'reasonCode', { max: 80 }) || 'ADMIN_CANCELLATION', comment: note, expectedRevision })));
  }
  const responseOrder = await require('../services/deliveryService').withOrderLock(order._id, fresh => updateOrderStatusUnderLock(req, fresh, orderStatus, note, expectedRevision));
  res.json(responseOrder);
});

async function updateOrderStatusUnderLock(req, order, orderStatus, note, expectedRevision) {
  assertCurrentRevision(order, expectedRevision);
  const shipment = await require('../models/Shipment').findOne({ order: order._id });
  if (toShipmentStatus(orderStatus) && (!shipment || shipment.provider === 'manual')) await require('../services/shippingService').requireReliableDeliveryWrites();
  if (orderStatus === 'Packed' && order.fraudProtectionSnapshot?.capturedAt && order.packageVerification?.status === 'PENDING') {
    throw new ApiError('PACKING_VERIFICATION_REQUIRED', 'Complete product and packing verification before marking this order packed.', { statusCode: 409 });
  }
  assertCodDispatchable(order);
  const transition = assertOrderTransition(order, orderStatus, shipment);
  if (!transition.changed) return decorateOrder(order);
  const before = { orderStatus: order.orderStatus, codConfirmationStatus: order.codConfirmationStatus };
  const now = new Date();
  const set = { orderStatus };
  if (order.paymentMethod === 'COD' && order.codConfirmationStatus === 'PENDING' && order.codVerification?.required !== true && orderStatus === 'Confirmed') set.codConfirmationStatus = 'CONFIRMED';
  if (orderStatus === 'Delivered') {
    set.deliveredAt = order.deliveredAt || now;
    // Staff confirmation is not an OTP-verified proof of delivery.
    set.deliveryProof = { trackingNumber: shipment?.trackingNumber || shipment?.awb || shipment?.deliveryReference || '', courierName: shipment?.fulfillmentMode === 'SELF' ? 'Store delivery team' : shipment?.courierName || shipment?.provider || '', deliveredAt: order.deliveredAt || now, deliveryOtpVerified: false, source: shipment?.provider && shipment.provider !== 'manual' ? 'COURIER' : 'MANUAL' };
  }
  const updated = await runInTransaction(async session => {
    const updated = await Order.findOneAndUpdate(andFilter({
      _id: order._id,
      orderStatus: order.orderStatus,
      ...revisionFilter(expectedRevision),
    }, req.tenantFilter), {
      $set: set,
      $inc: { revision: 1 },
      $push: { statusTimeline: { status: orderStatus, date: now, note: note || `Marked ${orderStatus} by staff` } },
    }, { new: true, session });
    if (!updated) throw new ApiError('ORDER_CHANGED', 'This order changed in another session. Reload it before continuing.', { statusCode: 409 });
    if (toShipmentStatus(orderStatus) && (!shipment || shipment.provider === 'manual')) {
      await upsertShipmentForOrder(updated, { status: toShipmentStatus(orderStatus), note: note || `Order marked ${orderStatus}` }, { session, notify: false });
    }
    if (['Shipped', 'Delivered'].includes(orderStatus)) {
      await InventoryItem.updateMany(andFilter({ order: updated._id }, req.tenantFilter), { $set: { status: orderStatus === 'Delivered' ? 'DELIVERED' : 'SHIPPED', [orderStatus === 'Delivered' ? 'deliveredAt' : 'shippedAt']: now } }, { session });
    }
    return updated;
  });
  logAudit({ req, action: 'ORDER_STATUS_UPDATE', entityType: 'Order', entityId: updated._id, storeId: updated.storeId, before, after: { orderStatus: updated.orderStatus, codConfirmationStatus: updated.codConfirmationStatus }, summary: note || `Order moved to ${orderStatus}` });
  if (['Shipped', 'Out for Delivery'].includes(orderStatus)) notifyLater({
    userId: updated.user, storeId: updated.storeId, event: orderStatus === 'Shipped' ? 'ORDER_SHIPPED' : 'ORDER_OUT_FOR_DELIVERY',
    title: orderStatus === 'Shipped' ? 'Your order is on the way' : 'Out for delivery',
    message: 'Open your order for the latest delivery details and updates.', metadata: { orderId: String(updated._id) },
  });

  if (orderStatus === 'Delivered') {
    notifyLater({
      userId: updated.user,
      storeId: updated.storeId,
      event: 'ORDER_DELIVERED',
      title: 'Order delivered',
      message: 'Your order has been delivered. You can now rate products or request a return.',
      metadata: { orderId: String(updated._id) },
    });
    const firstProductId = (updated.orderItems || []).map((item) => item.product).find(Boolean);
    notifyLater({
      userId: updated.user,
      storeId: updated.storeId,
      event: 'REVIEW_REQUEST',
      title: 'How was your order?',
      message: 'Your feedback helps other shoppers choose with confidence. Rate the products you received.',
      metadata: { orderId: String(updated._id), productId: firstProductId ? String(firstProductId) : undefined },
      deliverAfter: new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000),
    });
  }

  const populated = await Order.findById(updated._id).populate('shipment');
  return decorateOrder(populated);
}

exports.updatePaymentStatus = asyncHandler(async (req, res) => {
  requireObjectId(req.params.id, 'order id');
  const paymentStatus = requireEnum(req.body?.paymentStatus, PAYMENT_STATUSES, 'paymentStatus');
  const note = optionalString(req.body?.note, 'note', { max: 500 });
  const reference = optionalString(req.body?.reference, 'reference', { max: 120 });
  const order = await Order.findOne(andFilter({ _id: req.params.id }, req.tenantFilter)).select('+paymentEvents');
  if (!order) throw notFound('Order not found');
  if (order.paymentStatus === paymentStatus) {
    if (paymentStatus === 'Refunded' && order.couponConsumed && order.coupon?.restoreOnFullRefund && !order.couponReleased) {
      await couponService.releaseCouponForFullyRefundedOrder(order._id);
    }
    return res.json(decorateOrder(await Order.findById(order._id).select('+paymentEvents')));
  }
  const expectedRevision = assertCurrentRevision(order, req.body?.revision);
  if (order.paymentMethod !== 'COD') throw new ApiError('PAYMENT_MANAGED_BY_PROVIDER', 'Online payment status is controlled by the payment provider. Reconcile it from Razorpay instead of changing it manually.', { statusCode: 409 });
  if (!MANUAL_PAYMENT_TRANSITIONS[order.paymentStatus]?.includes(paymentStatus)) throw new ApiError('PAYMENT_TRANSITION_INVALID', `A COD payment cannot move from ${order.paymentStatus} to ${paymentStatus}.`, { statusCode: 409 });
  if (!note) throw new ApiError('VALIDATION_ERROR', 'Add a payment note so this financial change has a clear audit record.');
  if (paymentStatus === 'Paid' && order.orderStatus !== 'Delivered') throw new ApiError('PAYMENT_TRANSITION_INVALID', 'Record COD collection after the order is delivered.', { statusCode: 409 });
  const settlementAmount = order.paymentMethod === 'COD' ? Number(order.adjustedFinalAmount ?? order.finalAmount ?? 0) : Number(order.finalAmount || 0);

  let refundAmount = 0;
  let paymentState = paymentStatus === 'Paid' ? 'PAID' : 'REFUNDED';
  let resultingPaymentStatus = paymentStatus;
  if (paymentStatus === 'Refunded') {
    const ReturnExchange = require('../models/ReturnExchange');
    const completedReturn = await ReturnExchange.exists(andFilter({ order: order._id, $or: [{ status: 'Refunded' }, { resolutionStatus: 'Refunded' }] }, req.tenantFilter));
    if (!completedReturn) throw new ApiError('PAYMENT_TRANSITION_INVALID', 'Complete the approved return refund step before recording money returned to the customer.', { statusCode: 409 });
    if (reference && (order.refunds || []).some(refund => String(refund.providerRefundId || '') === reference)) throw new ApiError('DUPLICATE_REQUEST', 'This refund reference has already been recorded.', { statusCode: 409 });
    const remaining = Math.round(Math.max(0, settlementAmount - Number(order.refundedAmount || 0)) * 100) / 100;
    refundAmount = Math.round(Number(req.body?.amount) * 100) / 100;
    if (!Number.isFinite(refundAmount) || refundAmount < 0.01 || refundAmount > remaining) throw new ApiError('VALIDATION_ERROR', `Enter a refund amount between Rs. 0.01 and Rs. ${remaining.toFixed(2)}.`);
    const completesRefund = refundAmount >= remaining;
    paymentState = completesRefund ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    resultingPaymentStatus = completesRefund ? 'Refunded' : 'Paid';
  }
  const now = new Date();
  const mutation = {
    $set: { paymentStatus: resultingPaymentStatus, paymentState, ...(paymentStatus === 'Refunded' ? { refundedAmount: Number(order.refundedAmount || 0) + refundAmount } : {}) },
    $inc: { revision: 1 },
    $push: {
      paymentEvents: {
        state: paymentState, status: paymentStatus, amount: paymentStatus === 'Refunded' ? refundAmount : settlementAmount, reference,
        note, source: 'MANUAL', actor: actorSnapshot(req), date: now,
      },
    },
  };
  if (paymentStatus === 'Refunded') mutation.$push.refunds = { providerRefundId: reference || `manual-${order._id}-${expectedRevision + 1}`, provider: 'manual', amount: refundAmount, currency: 'INR', status: 'PROCESSED', sourceType: 'MANUAL', note, processedAt: now };
  const paymentFilter = paymentStatus === 'Refunded'
    ? { $and: [
      { _id: order._id, paymentStatus: order.paymentStatus },
      revisionFilter(expectedRevision),
      Number(order.refundedAmount || 0) === 0 ? { $or: [{ refundedAmount: 0 }, { refundedAmount: { $exists: false } }] } : { refundedAmount: Number(order.refundedAmount) },
    ] }
    : { _id: order._id, paymentStatus: order.paymentStatus, ...revisionFilter(expectedRevision) };
  const updated = await Order.findOneAndUpdate(andFilter(paymentFilter, req.tenantFilter), mutation, { new: true }).select('+paymentEvents');
  if (!updated) throw new ApiError('ORDER_CHANGED', 'This order changed in another session. Reload it before continuing.', { statusCode: 409 });
  if (resultingPaymentStatus === 'Refunded') await couponService.releaseCouponForFullyRefundedOrder(updated._id);
  logAudit({ req, action: paymentStatus === 'Paid' ? 'COD_PAYMENT_COLLECTED' : 'COD_REFUND_RECORDED', entityType: 'Order', entityId: updated._id, storeId: updated.storeId, before: { paymentStatus: order.paymentStatus, paymentState: order.paymentState, refundedAmount: order.refundedAmount || 0 }, after: { paymentStatus: resultingPaymentStatus, paymentState, refundedAmount: updated.refundedAmount || 0, refundAmount, reference }, summary: note });
  res.json(decorateOrder(updated, { canRecordRefund: paymentStatus === 'Refunded' && resultingPaymentStatus === 'Paid' }));
});

/**
 * Orders are financial history, so they are cancelled rather than deleted.
 */
exports.deleteOrder = asyncHandler(async (req, res) => {
  requireObjectId(req.params.id, 'order id');
  const order = await Order.findOne(andFilter({ _id: req.params.id }, req.tenantFilter));
  if (!order) throw notFound('Order not found');

  if (order.orderStatus === 'Cancelled') {
    return res.json({ success: true, message: 'Order is already cancelled', order });
  }
  const shipment = await require('../models/Shipment').findOne({ order: order._id });
  if (!canCancelOrder(order, shipment)) throw new ApiError('ORDER_NOT_CANCELLABLE', 'This order is already with the courier or completed. Use the return/RTO workflow instead.');
  const cancelled = await cancelOrderInternal(order, { req, actor: req.user, note: 'Cancelled by staff' });
  res.json({ success: true, message: 'Order cancelled', order: cancelled });
});

exports.cancelOrder = asyncHandler(async (req, res) => {
  requireObjectId(req.params.id, 'order id');
  const order = await Order.findOne(andFilter({ _id: req.params.id }, req.tenantFilter));
  if (!order) throw notFound('Order not found');
  if (!isOwnerOrAdmin(order, req.user, req)) throw forbidden('Not allowed');

  const reason = optionalString(req.body?.reason, 'reason', { max: 300 });
  const comment = optionalString(req.body?.comment, 'comment', { max: 500 });
  const note = `${req.user.role === 'admin' ? 'Cancelled by admin' : 'Cancelled by customer'}${reason ? `: ${reason}` : ''}`;
  res.json(await cancelOrderInternal(order, { req, actor: req.user, note: comment ? `${note}. ${comment}` : note, reasonCode: reason || 'OTHER', comment }));
});

async function completeItemCancellationInventory(order, operationId, req) {
  const refund = (order.itemCancellationRefunds || []).find(entry => entry.operationId === operationId);
  if (!refund || ['PROCESSED', 'NOT_REQUIRED'].includes(refund.inventoryStatus)) return order;
  const item = (order.orderItems || []).id?.(refund.orderItemId) || (order.orderItems || []).find(entry => String(entry._id) === String(refund.orderItemId));
  const cancellation = item?.cancellations?.find(entry => entry.operationId === operationId);
  if (!item || !cancellation) throw new ApiError('ORDER_CHANGED', 'The cancelled item record could not be reconciled.', { statusCode: 409 });
  try {
    await inventoryService.applyInventoryAdjustment({
      productId: item.product, variantId: item.variantId, mode: 'ADD', bucket: 'SELLABLE', quantity: cancellation.quantity,
      reasonCode: 'CUSTOMER_RETURN', reason: 'Order item cancelled before dispatch', note: cancellation.comment || cancellation.reasonCode,
      reference: `Order ${order._id}`, idempotencyKey: `item-cancel:${operationId}`,
      tenantFilter: req.tenantFilter, userId: req.user._id,
    });
    await Order.updateOne({ _id: order._id }, { $set: { 'itemCancellationRefunds.$[refund].inventoryStatus': 'PROCESSED' } }, { arrayFilters: [{ 'refund.operationId': operationId }] });
  } catch (error) {
    await Order.updateOne({ _id: order._id }, { $set: { 'itemCancellationRefunds.$[refund].inventoryStatus': 'FAILED', 'itemCancellationRefunds.$[refund].lastError': `Inventory: ${String(error.message || 'restore failed').slice(0, 450)}` } }, { arrayFilters: [{ 'refund.operationId': operationId }] });
    throw error;
  }
  return Order.findById(order._id);
}

exports.cancelOrderItem = asyncHandler(async (req, res) => {
  requireObjectId(req.params.id, 'order id');
  requireObjectId(req.params.itemId, 'order item id');
  let order = await Order.findOne(andFilter({ _id: req.params.id }, req.tenantFilter));
  if (!order) throw notFound('Order not found');
  if (!isOwnerOrAdmin(order, req.user, req)) throw forbidden('Not allowed');
  const shipment = await require('../models/Shipment').findOne({ order: order._id });
  if (!canCancelOrder(order, shipment)) throw new ApiError('ORDER_NOT_CANCELLABLE', 'Items cannot be cancelled after courier handover. Use the return workflow after delivery.', { statusCode: 409 });
  const item = order.orderItems.id?.(req.params.itemId) || order.orderItems.find(entry => String(entry._id) === String(req.params.itemId));
  if (!item) throw notFound('Order item not found');
  const available = Math.max(0, Number(item.quantity || 0) - Number(item.cancelledQuantity || 0));
  const quantity = Number(req.body?.quantity ?? available);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > available) throw new ApiError('VALIDATION_ERROR', `Choose a cancellation quantity between 1 and ${available}.`);
  const reasonCode = requireString(req.body?.reasonCode || req.body?.reason, 'cancellation reason', { max: 80 });
  const comment = optionalString(req.body?.comment, 'comment', { max: 500 });
  const operationId = String(req.body?.operationId || crypto.randomUUID()).trim();
  if (!/^[A-Za-z0-9_-]{10,100}$/.test(operationId)) throw new ApiError('VALIDATION_ERROR', 'A valid cancellation operation ID is required.');
  const totalActive = order.orderItems.reduce((sum, entry) => sum + Math.max(0, Number(entry.quantity || 0) - Number(entry.cancelledQuantity || 0)), 0);
  if (quantity === totalActive) {
    const note = `${req.user.role === 'admin' ? 'Cancelled by admin' : 'Cancelled by customer'}: ${reasonCode}${comment ? `. ${comment}` : ''}`;
    return res.json(await cancelOrderInternal(order, { req, actor: req.user, note, reasonCode, comment }));
  }
  if (order.paymentMethod !== 'COD' && order.paymentStatus !== 'Paid' && !['PAID', 'PARTIALLY_REFUNDED'].includes(order.paymentState)) {
    throw new ApiError('ORDER_ITEM_CANCELLATION_UNAVAILABLE', 'A pending online payment amount cannot be changed. Cancel the complete order and place it again with the required items.', { statusCode: 409 });
  }

  const existing = (order.itemCancellationRefunds || []).find(entry => entry.operationId === operationId);
  if (!existing) {
    const delivery = require('../services/deliveryService');
    order = await delivery.withOrderLock(order._id, async fresh => {
      const freshShipment = await require('../models/Shipment').findOne({ order: fresh._id });
      if (!canCancelOrder(fresh, freshShipment)) throw new ApiError('ORDER_NOT_CANCELLABLE', 'This parcel is already with the courier.', { statusCode: 409 });
      if (freshShipment?.awb) await delivery.cancelBooking(fresh);
      const freshItem = fresh.orderItems.id?.(req.params.itemId) || fresh.orderItems.find(entry => String(entry._id) === String(req.params.itemId));
      const alreadyCancelled = Number(freshItem?.cancelledQuantity || 0);
      if (!freshItem || quantity > Number(freshItem.quantity || 0) - alreadyCancelled) throw new ApiError('ORDER_CHANGED', 'The available item quantity changed. Reload before cancelling.', { statusCode: 409 });
      const settings = returnPolicySettings(fresh, await getStoreSettings(req.tenantFilter || (fresh.storeId ? { storeId: fresh.storeId } : {})));
      const estimate = refundEstimate(fresh, freshItem, quantity, settings, { isCancellation: true });
      const amount = Number(estimate.estimatedRefundAmount || 0);
      const paymentCollected = fresh.paymentMethod !== 'COD' && (fresh.paymentStatus === 'Paid' || ['PAID', 'PARTIALLY_REFUNDED'].includes(fresh.paymentState));
      const inventoryStatus = fresh.inventoryDeducted ? 'PENDING' : 'NOT_REQUIRED';
      const refundStatus = paymentCollected && amount > 0 ? 'PENDING' : 'NOT_REQUIRED';
      const elemMatch = alreadyCancelled === 0 ? { _id: freshItem._id, $or: [{ cancelledQuantity: 0 }, { cancelledQuantity: { $exists: false } }] } : { _id: freshItem._id, cancelledQuantity: alreadyCancelled };
      const adjustedFinalAmount = Math.max(0, Number(fresh.adjustedFinalAmount ?? fresh.finalAmount ?? 0) - amount);
      const updated = await Order.findOneAndUpdate(andFilter({ _id: fresh._id, revision: Number(fresh.revision || 0), orderItems: { $elemMatch: elemMatch }, 'itemCancellationRefunds.operationId': { $ne: operationId } }, req.tenantFilter), {
        $inc: { 'orderItems.$.cancelledQuantity': quantity, cancellationAdjustment: amount, revision: 1 },
        $set: { adjustedFinalAmount },
        $push: {
          'orderItems.$.cancellations': { operationId, quantity, reasonCode, comment, amount, actor: actorSnapshot(req), date: new Date() },
          itemCancellationRefunds: { operationId, orderItemId: String(freshItem._id), amount, status: refundStatus, inventoryStatus },
          statusTimeline: { status: 'Item cancelled', date: new Date(), note: `${quantity} × ${freshItem.name || freshItem.productName || 'item'} cancelled: ${reasonCode}` },
        },
      }, { new: true });
      if (!updated) throw new ApiError('ORDER_CHANGED', 'This order changed while the item was being cancelled. Reload and try again.', { statusCode: 409 });
      return updated;
    });
  }
  if (order.inventoryDeducted) order = await completeItemCancellationInventory(order, operationId, req);
  order = await processItemCancellationRefund(order._id, operationId);
  await logAudit({ req, action: 'ORDER_ITEM_CANCEL', entityType: 'Order', entityId: order._id, storeId: order.storeId, after: { orderItemId: req.params.itemId, quantity, reasonCode, operationId, adjustedFinalAmount: order.adjustedFinalAmount } });
  notifyLater({ userId: order.user, storeId: order.storeId, event: 'ORDER_ITEM_CANCELLED', title: 'Order item cancelled', message: `${quantity} unit(s) were cancelled. Refund status is available in order details.`, metadata: { orderId: String(order._id), orderItemId: String(req.params.itemId), operationId } });
  res.json(decorateOrder(order));
});

async function recordManualResolutionRefund(order, { amount, reference, note, sourceType, sourceId }) {
  const safeReference = requireString(reference, 'manual refund reference', { max: 120 });
  const safeNote = requireString(note, 'manual refund note', { max: 500 });
  const refundAmount = Math.round(Number(amount || 0) * 100) / 100;
  if (!(refundAmount > 0)) throw new ApiError('VALIDATION_ERROR', 'The pending refund does not have a valid amount.');
  const existing = (order.refunds || []).find(refund => String(refund.providerRefundId || '') === safeReference);
  if (existing && !(existing.sourceType === sourceType && String(existing.sourceId || '') === String(sourceId))) {
    throw new ApiError('DUPLICATE_REQUEST', 'This refund reference is already attached to another resolution.', { statusCode: 409 });
  }
  const result = existing ? { order, added: false } : await recordProviderRefund({
    orderId: order._id, refundId: safeReference, amount: refundAmount, note: safeNote,
    sourceType, sourceId, source: reqSafeSource(sourceType), provider: 'manual',
  });
  if (!existing && !result.added) throw new ApiError('PAYMENT_TRANSITION_INVALID', 'This refund would exceed the amount collected for the order. Reload and review the payment history.', { statusCode: 409 });
  return { order: result.order || order, reference: safeReference, note: safeNote, amount: refundAmount };
}

function reqSafeSource(sourceType) {
  return ['CANCELLATION', 'ITEM_CANCELLATION', 'RTO'].includes(sourceType) ? 'MANUAL' : 'SYSTEM';
}

exports.retryItemCancellationRefund = asyncHandler(async (req, res) => {
  requireObjectId(req.params.id, 'order id');
  const operationId = requireString(req.body?.operationId, 'operationId', { max: 100 });
  const order = await Order.findOne(andFilter({ _id: req.params.id }, req.tenantFilter));
  if (!order) throw notFound('Order not found');
  const entry = (order.itemCancellationRefunds || []).find(item => item.operationId === operationId);
  if (!entry || !['FAILED', 'PENDING', 'MANUAL_REQUIRED'].includes(entry.status)) throw new ApiError('PAYMENT_TRANSITION_INVALID', 'This item refund is not waiting for retry.', { statusCode: 409 });
  if (entry.status === 'MANUAL_REQUIRED') {
    const manual = await recordManualResolutionRefund(order, { amount: entry.amount, reference: req.body?.manualReference, note: req.body?.manualNote, sourceType: 'ITEM_CANCELLATION', sourceId: operationId });
    const updated = await Order.findOneAndUpdate(andFilter({ _id: order._id, itemCancellationRefunds: { $elemMatch: { operationId, status: 'MANUAL_REQUIRED' } } }, req.tenantFilter), { $set: { 'itemCancellationRefunds.$.status': 'PROCESSED', 'itemCancellationRefunds.$.providerRefundId': manual.reference, 'itemCancellationRefunds.$.processedAt': new Date(), 'itemCancellationRefunds.$.lastError': '' }, $unset: { 'itemCancellationRefunds.$.nextCheckAt': 1 } }, { new: true });
    await logAudit({ req, action: 'ORDER_ITEM_REFUND_RECORDED_MANUALLY', entityType: 'Order', entityId: order._id, storeId: order.storeId, after: { operationId, amount: manual.amount, reference: manual.reference } });
    notifyLater({ userId: order.user, storeId: order.storeId, event: 'REFUND_PROCESSED', title: 'Cancelled item refund recorded', message: `Your refund of Rs. ${manual.amount.toLocaleString('en-IN')} has been completed.`, metadata: { orderId: String(order._id), operationId, amount: manual.amount } });
    return res.json(decorateOrder(updated || await Order.findById(order._id)));
  }
  const updated = await processItemCancellationRefund(order._id, operationId);
  await logAudit({ req, action: 'ORDER_ITEM_REFUND_RETRY', entityType: 'Order', entityId: order._id, storeId: order.storeId, after: { operationId, status: updated.itemCancellationRefunds?.find(item => item.operationId === operationId)?.status } });
  res.json(decorateOrder(updated));
});

exports.retryCancellationRefund = asyncHandler(async (req, res) => {
  requireObjectId(req.params.id, 'order id');
  const order = await Order.findOne(andFilter({ _id: req.params.id }, req.tenantFilter));
  if (!order) throw notFound('Order not found');
  if (order.orderStatus !== 'Cancelled') throw new ApiError('ORDER_NOT_CANCELLABLE', 'Only a cancelled order can retry its cancellation refund.', { statusCode: 409 });
  if (order.cancellationRefund?.status === 'MANUAL_REQUIRED') {
    const remaining = Math.max(0, Number(order.finalAmount || 0) - Number(order.refundedAmount || 0));
    const amount = Math.min(remaining, Number(order.cancellationRefund?.amount || remaining));
    const manual = await recordManualResolutionRefund(order, { amount, reference: req.body?.manualReference, note: req.body?.manualNote, sourceType: 'CANCELLATION', sourceId: order._id });
    const updated = await Order.findOneAndUpdate(andFilter({ _id: order._id, 'cancellationRefund.status': 'MANUAL_REQUIRED' }, req.tenantFilter), { $set: { 'cancellationRefund.status': 'PROCESSED', 'cancellationRefund.providerRefundId': manual.reference, 'cancellationRefund.amount': manual.amount, 'cancellationRefund.processedAt': new Date(), 'cancellationRefund.lastError': '' }, $unset: { 'cancellationRefund.operation': 1, 'cancellationRefund.operationUntil': 1, 'cancellationRefund.nextCheckAt': 1 } }, { new: true });
    await logAudit({ req, action: 'CANCELLATION_REFUND_RECORDED_MANUALLY', entityType: 'Order', entityId: order._id, storeId: order.storeId, after: { amount: manual.amount, reference: manual.reference } });
    notifyLater({ userId: order.user, storeId: order.storeId, event: 'REFUND_PROCESSED', title: 'Cancellation refund recorded', message: `Your refund of Rs. ${manual.amount.toLocaleString('en-IN')} has been completed.`, metadata: { orderId: String(order._id), amount: manual.amount } });
    return res.json(decorateOrder(updated || await Order.findById(order._id)));
  }
  const updated = await processCancellationRefund(order._id);
  logAudit({ req, action: 'CANCELLATION_REFUND_RETRY', entityType: 'Order', entityId: order._id, storeId: order.storeId, after: { cancellationRefund: updated?.cancellationRefund, paymentStatus: updated?.paymentStatus, refundedAmount: updated?.refundedAmount } });
  res.json(decorateOrder(updated));
});

exports.inspectRto = asyncHandler(async (req, res) => {
  requireObjectId(req.params.id, 'order id');
  const disposition = requireEnum(req.body?.disposition, ['RESTOCK', 'QUARANTINE', 'DAMAGED', 'MISSING'], 'inventory disposition');
  const notes = requireString(req.body?.notes, 'inspection notes', { max: 1000 });
  let order = await Order.findOne(andFilter({ _id: req.params.id }, req.tenantFilter));
  if (!order) throw notFound('Order not found');
  if (!['RECEIVED', 'QC_PENDING'].includes(order.rto?.status)) throw new ApiError('ORDER_TRANSITION_INVALID', 'This order is not waiting for an RTO inspection.', { statusCode: 409 });
  const expectedRevision = assertCurrentRevision(order, req.body?.revision);
  const items = (order.orderItems || []).map(item => ({
    product: item.product,
    variantId: item.variantId,
    quantity: Math.max(0, Number(item.quantity || 0) - Number(item.cancelledQuantity || 0)),
  })).filter(item => item.quantity > 0);
  const expectedQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
  const receivedQuantity = Number(req.body?.receivedQuantity ?? (disposition === 'MISSING' ? 0 : expectedQuantity));
  if (!Number.isInteger(receivedQuantity) || receivedQuantity < 0 || receivedQuantity > expectedQuantity) throw new ApiError('VALIDATION_ERROR', `Received quantity must be between 0 and ${expectedQuantity}.`);
  if (disposition !== 'MISSING' && receivedQuantity !== expectedQuantity) throw new ApiError('VALIDATION_ERROR', 'Inspect each returned unit before completing RTO. Use Missing only when the parcel or all products are unavailable.');
  const currentSettings = await getStoreSettings(req.tenantFilter || (order.storeId ? { storeId: order.storeId } : {}));
  const policy = returnPolicySettings(order, currentSettings);
  const remainingPaidAmount = Math.max(0, Number(order.finalAmount || 0) - Number(order.refundedAmount || 0));
  const refundDeduction = req.body?.waiveRefundDeduction === true ? 0 : Math.min(remainingPaidAmount, Math.max(0, Number(policy.rtoRefundDeduction || 0)));
  const rtoRefundAmount = Math.max(0, Math.round((remainingPaidAmount - refundDeduction) * 100) / 100);

  if (disposition !== 'MISSING') {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      await inventoryService.applyInventoryAdjustment({
        productId: item.product, variantId: item.variantId, mode: 'ADD',
        bucket: disposition === 'RESTOCK' ? 'SELLABLE' : disposition,
        quantity: item.quantity,
        reasonCode: disposition === 'DAMAGED' ? 'DAMAGED' : 'CUSTOMER_RETURN',
        reason: `RTO parcel inspected as ${disposition.toLowerCase()}`,
        note: notes, reference: `RTO ${order._id}`,
        idempotencyKey: `rto-disposition:${order._id}:${index}:${disposition}`,
        tenantFilter: req.tenantFilter, userId: req.user._id,
      });
    }
  }
  const statusForDisposition = { RESTOCK: 'RESTOCKED', QUARANTINE: 'QUARANTINED', DAMAGED: 'DAMAGED', MISSING: 'MISSING' }[disposition];
  order = await Order.findOneAndUpdate(andFilter({ _id: order._id, 'rto.inventoryRecorded': { $ne: true }, ...revisionFilter(expectedRevision) }, req.tenantFilter), { $set: { 'rto.status': statusForDisposition, 'rto.disposition': disposition, 'rto.receivedQuantity': receivedQuantity, 'rto.inspectedAt': new Date(), 'rto.inventoryRecorded': true, 'rto.inventoryRecordedAt': new Date(), 'rto.notes': notes, 'rto.lastRefundError': '', 'rto.refundAmount': order.paymentMethod === 'COD' ? 0 : rtoRefundAmount, 'rto.refundDeduction': order.paymentMethod === 'COD' ? 0 : refundDeduction, 'rto.refundStatus': order.paymentMethod === 'COD' ? 'NOT_REQUIRED' : 'PENDING', ...(disposition === 'RESTOCK' ? { inventoryRestored: true, inventoryRestoredAt: new Date() } : {}) }, $inc: { revision: 1 }, $push: { statusTimeline: { status: `RTO ${statusForDisposition.toLowerCase()}`, note: notes, date: new Date() } } }, { new: true });
  if (!order) {
    const current = await Order.findById(req.params.id);
    if (current?.rto?.inventoryRecorded) return res.json(decorateOrder(current));
    throw new ApiError('ORDER_CHANGED', 'This order changed during inspection. Reload it before continuing.', { statusCode: 409 });
  }
  await logAudit({ req, action: 'ORDER_RTO_INSPECTED', entityType: 'Order', entityId: order._id, storeId: order.storeId, after: { disposition, receivedQuantity, refundStatus: order.rto?.refundStatus, refundAmount: order.rto?.refundAmount, refundDeduction: order.rto?.refundDeduction }, summary: notes });
  const resolved = await processRtoRefund(order._id);
  notifyLater({ userId: order.user, storeId: order.storeId, event: 'ORDER_RTO_INSPECTED', title: 'Returned parcel inspected', message: order.paymentMethod === 'COD' ? 'The returned parcel has been inspected and this order is closed.' : 'The returned parcel has been inspected and your prepaid refund is being handled.', metadata: { orderId: String(order._id) } });
  res.json(decorateOrder(resolved));
});

exports.retryRtoRefund = asyncHandler(async (req, res) => {
  requireObjectId(req.params.id, 'order id');
  const order = await Order.findOne(andFilter({ _id: req.params.id }, req.tenantFilter));
  if (!order) throw notFound('Order not found');
  if (!['FAILED', 'PENDING', 'MANUAL_REQUIRED'].includes(order.rto?.refundStatus)) throw new ApiError('PAYMENT_TRANSITION_INVALID', 'This RTO refund is not waiting for retry.', { statusCode: 409 });
  if (order.rto?.refundStatus === 'MANUAL_REQUIRED') {
    const remaining = Math.max(0, Number(order.finalAmount || 0) - Number(order.refundedAmount || 0));
    const amount = Math.min(remaining, Number(order.rto?.refundAmount ?? remaining));
    const manual = await recordManualResolutionRefund(order, { amount, reference: req.body?.manualReference, note: req.body?.manualNote, sourceType: 'RTO', sourceId: order._id });
    const updated = await Order.findOneAndUpdate(andFilter({ _id: order._id, 'rto.refundStatus': 'MANUAL_REQUIRED' }, req.tenantFilter), { $set: { 'rto.refundStatus': 'PROCESSED', 'rto.refundReference': manual.reference, 'rto.status': 'REFUNDED', 'rto.lastRefundError': '' }, $unset: { 'rto.operation': 1, 'rto.operationUntil': 1, 'rto.nextRefundCheckAt': 1 } }, { new: true });
    await logAudit({ req, action: 'ORDER_RTO_REFUND_RECORDED_MANUALLY', entityType: 'Order', entityId: order._id, storeId: order.storeId, after: { amount: manual.amount, reference: manual.reference } });
    notifyLater({ userId: order.user, storeId: order.storeId, event: 'REFUND_PROCESSED', title: 'RTO refund recorded', message: `Your refund of Rs. ${manual.amount.toLocaleString('en-IN')} has been completed.`, metadata: { orderId: String(order._id), amount: manual.amount } });
    return res.json(decorateOrder(updated || await Order.findById(order._id)));
  }
  const updated = await processRtoRefund(order._id);
  await logAudit({ req, action: 'ORDER_RTO_REFUND_RETRY', entityType: 'Order', entityId: order._id, storeId: order.storeId, after: { refundStatus: updated.rto?.refundStatus, refundReference: updated.rto?.refundReference } });
  res.json(decorateOrder(updated));
});

/**
 * Cancellation is idempotent.
 *
 * Stock restore and coupon release are each claimed with a conditional update,
 * so calling this twice cannot restock twice or hand back two redemptions.
 *
 * A parcel that has left the store is handled through RTO/return workflows;
 * cancellation never restores stock after carrier handoff.
 */
async function cancelOrderInternal(order, { req, actor, note, source, reasonCode = 'OTHER', comment = '', expectedRevision }) {
  const delivery = require('../services/deliveryService');
  const cancelled = await delivery.withOrderLock(order._id, async freshOrder => {
    if (expectedRevision !== undefined && Number(freshOrder.revision || 0) !== Number(expectedRevision)) {
      throw new ApiError('ORDER_CHANGED', 'This order changed in another session. Reload it before continuing.', { statusCode: 409 });
    }
    const freshShipment = await require('../models/Shipment').findOne({ order: freshOrder._id });
    if (freshOrder.orderStatus !== 'Cancelled' && !canCancelOrder(freshOrder, freshShipment)) throw new ApiError('ORDER_NOT_CANCELLABLE', 'This order has left the store. Use the return/RTO workflow instead of cancellation.');
    if (freshShipment?.provider === 'manual') await require('../services/shippingService').requireReliableDeliveryWrites();
    await delivery.cancelBooking(freshOrder);
    return cancelAfterCourier(freshOrder, { req, actor, note, source, reasonCode, comment, expectedRevision });
  });
  return processCancellationRefund(cancelled._id);
}

async function cancelAfterCourier(order, { req, actor, note, source, reasonCode, comment, expectedRevision }) {
  if (order.orderStatus === 'Cancelled') {
    await require('../services/shippingService').closeManualShipmentForOrder(order);
    return order;
  }

  const allowed = CANCELLABLE_STATUSES;

  if (!allowed.includes(order.orderStatus)) {
    throw new ApiError('ORDER_NOT_CANCELLABLE', `An order that is already ${order.orderStatus.toLowerCase()} cannot be cancelled`);
  }

  return runInTransaction(async (session) => {
    const claimed = await inventoryService.claimInventoryRestore(Order, order._id, session);
    if (claimed) {
      const activeItems = (claimed.orderItems || []).map(item => ({
        ...(item.toObject ? item.toObject() : item),
        quantity: Math.max(0, Number(item.quantity || 0) - Number(item.cancelledQuantity || 0)),
      })).filter(item => item.quantity > 0);
      await inventoryService.restoreStockForOrder(activeItems, {
        orderId: claimed._id,
        userId: actor?._id,
        type: 'CANCELLATION',
        reason: note,
        session,
      });
    }

    const releaseTarget = await Order.findOneAndUpdate(
      { _id: order._id, couponConsumed: true, couponReleased: { $ne: true } },
      { $set: { couponReleased: true } },
      { new: true, session },
    );
    if (releaseTarget?.coupon?.code) {
      await couponService.releaseCoupon(releaseTarget.coupon.code, { session, userId: releaseTarget.user, discountAmount: releaseTarget.coupon.savingAmount ?? releaseTarget.coupon.discountAmount, couponId: releaseTarget.coupon.couponId });
    }

    const updated = await Order.findOneAndUpdate(
      { _id: order._id, orderStatus: { $ne: 'Cancelled' }, ...(expectedRevision === undefined ? {} : revisionFilter(expectedRevision)) },
      {
        $set: {
          orderStatus: 'Cancelled',
          cancellation: {
            cancelledAt: new Date(),
            cancelledBy: { id: String(actor?._id || ''), name: String(actor?.name || actor?.phone || 'System').slice(0, 100), role: String(req?.storeMember?.role || actor?.role || 'SYSTEM') },
            reasonCode: String(reasonCode || 'OTHER').trim().slice(0, 80),
            comment: String(comment || '').trim().slice(0, 500),
            source: req?.storeMember ? 'SELLER' : actor?.role === 'admin' ? 'ADMIN' : actor ? 'CUSTOMER' : 'SYSTEM',
          },
          ...(order.paymentMethod === 'COD' && order.codConfirmationStatus === 'PENDING' ? { codConfirmationStatus: 'CANCELLED' } : {}),
          ...(order.codVerification?.status === 'PENDING' ? { 'codVerification.status': 'CANCELLED' } : {}),
          ...(order.paymentMethod !== 'COD' && ['Paid', 'Refunded'].includes(order.paymentStatus) && Number(order.refundedAmount || 0) < Number(order.finalAmount || 0) ? {
            'cancellationRefund.status': 'PENDING',
            'cancellationRefund.amount': Math.max(0, Number(order.finalAmount || 0) - Number(order.refundedAmount || 0)),
            'cancellationRefund.lastError': '',
          } : {}),
        },
        $inc: { revision: 1 },
        $push: { statusTimeline: { status: 'Cancelled', date: new Date(), note } },
      },
      { new: true, session },
    );

    if (!updated && expectedRevision !== undefined) {
      const current = await Order.findById(order._id).session(session || null);
      if (current?.orderStatus !== 'Cancelled') throw new ApiError('ORDER_CHANGED', 'This order changed in another session. Reload it before continuing.', { statusCode: 409 });
      return { changed: false, order: current };
    }
    if (updated) await require('../services/shippingService').closeManualShipmentForOrder(updated, { session });
    return { changed: Boolean(updated), order: updated || await Order.findById(order._id).session(session || null) };
  }).then((result) => {
    if (result.changed) logAudit({ req: req || { user: actor }, source, action: 'ORDER_CANCEL', entityType: 'Order', entityId: order._id, before: { orderStatus: order.orderStatus }, after: { orderStatus: 'Cancelled' }, storeId: order.storeId });
    if (result.changed) notifyLater({
      userId: result.order.user, storeId: result.order.storeId, event: 'ORDER_CANCELLED',
      title: 'Order cancelled', message: 'Your order has been cancelled. Check order details for payment and refund updates.',
      metadata: { orderId: String(result.order._id) },
    });
    return result.order;
  });
}

exports.receipt = asyncHandler(async (req, res) => {
  requireObjectId(req.params.id, 'order id');
  const order = await Order.findById(req.params.id).populate('user', 'name email phone').populate('shipment');
  if (!order) throw notFound('Order not found');
  if (!isOwnerOrAdmin(order, req.user, req)) throw forbidden('Not allowed to view this receipt');
  await syncPaidOnlineOrderStatus(order);
  res.json(await buildReceipt(order.toObject ? order.toObject() : order));
});

async function buildReceipt(order) {
  let settings = order.invoiceSeller?.storeName || order.invoiceSeller?.legalBusinessName
    ? order.invoiceSeller
    : await Settings.findOne(order.storeId ? { storeId: order.storeId } : { storeId: null }).lean();
  if (!settings && order.storeId) {
    const store = await require('../models/Store').findById(order.storeId).select('name legalName supportEmail supportPhone whatsappNumber isDefault').lean();
    if (store?.isDefault) settings = await Settings.findOne({ storeId: null }).lean();
    if (!settings && store) settings = { storeName: store.name, legalBusinessName: store.legalName, contactEmail: store.supportEmail, contactPhone: store.supportPhone, whatsappNumber: store.whatsappNumber };
  }
  return {
    orderId: order._id,
    orderDate: order.createdAt,
    customer: order.user,
    shippingAddress: order.shippingAddress,
    items: order.orderItems,
    paymentMethod: order.paymentMethod,
    paymentProvider: order.paymentProvider,
    paymentStatus: order.paymentStatus,
    paymentState: order.paymentState,
    orderStatus: order.orderStatus,
    statusTimeline: order.statusTimeline,
    totalMRP: order.totalMRP,
    productDiscount: order.productDiscount || 0,
    couponDiscount: order.couponDiscount || order.coupon?.discountAmount || 0,
    deliveryCharge: order.deliveryCharge || 0,
    codCharge: order.codCharge || 0,
    platformFee: order.platformFee || 0,
    prepaidDiscount: order.prepaidDiscount || 0,
    taxAmount: order.taxAmount || 0,
    taxRate: order.taxRate || 0,
    finalAmount: order.finalAmount,
    coupon: order.coupon,
    razorpayOrderId: order.razorpayOrderId,
    razorpayPaymentId: order.razorpayPaymentId,
    paymentFailureReason: order.paymentFailureReason,
    refundedAmount: order.refundedAmount || 0,
    refunds: order.refunds || [],
    cancellationAdjustment: order.cancellationAdjustment || 0,
    adjustedFinalAmount: order.adjustedFinalAmount,
    itemCancellationRefunds: order.itemCancellationRefunds || [],
    invoiceNumber: order.invoiceNumber,
    invoiceDate: order.invoiceDate,
    billingAddress: order.billingAddress,
    shipment: require('../services/deliveryService').publicShipment(order.shipment, { customer: true }),
    storeDetails: {
      logoUrl: settings?.logoUrl,
      invoiceNote: settings?.invoiceNote,
      storeName: settings?.storeName || 'Jassi General Store',
      legalBusinessName: settings?.legalBusinessName,
      gstin: settings?.gstin,
      contactEmail: settings?.contactEmail,
      contactPhone: settings?.contactPhone,
      whatsappNumber: settings?.whatsappNumber,
      address: settings?.address,
      billingAddress: settings?.billingAddress,
    },
    policies: {
      returnPolicy: settings?.returnPolicy || 'Return/exchange as per store policy.',
    },
  };
}

exports.updateShipment = asyncHandler(async (req, res) => {
  requireObjectId(req.params.id, 'order id');
  const order = await Order.findOne(andFilter({ _id: req.params.id }, req.tenantFilter));
  if (!order) throw notFound('Order not found');
  const note = optionalString(req.body?.note, 'note', { max: 300 }) || 'Delivery details updated by staff';
  const delivery = require('../services/deliveryService');
  const result = await delivery.withOrderLock(order._id, async fresh => {
    const expectedRevision = assertCurrentRevision(fresh, req.body?.revision);
    const settings = await getStoreSettings(fresh.storeId ? { storeId: fresh.storeId } : {});
    await require('../services/shippingService').requireReliableDeliveryWrites();
    return runInTransaction(session => saveManualShipment(fresh, req.body || {}, { session, expectedRevision, settings }));
  });
  const { shipment, changed } = result;
  if (changed) {
    logAudit({ req, action: 'SHIPMENT_UPDATE', entityType: 'Order', entityId: order._id, storeId: order.storeId, summary: note, after: { status: shipment.status, fulfillmentMode: shipment.fulfillmentMode, courierName: shipment.courierName, trackingNumber: shipment.trackingNumber, deliveryReference: shipment.deliveryReference } });
    notifyLater({ userId: order.user, storeId: order.storeId, event: 'DELIVERY_UPDATED', title: shipment.status === 'EXCEPTION' ? 'Delivery needs attention' : 'Delivery details updated', message: shipment.customerNote || 'The store updated your delivery details. Open your order for tracking and the latest information.', metadata: { orderId: String(order._id), shipmentId: String(shipment._id) } });
  }
  res.json({ ...delivery.publicShipment(shipment), revision: result.revision });
});

exports.assertCheckoutReady = assertCheckoutReady;
exports.assertShippingAddress = assertShippingAddress;
exports.cancelOrderInternal = cancelOrderInternal;
