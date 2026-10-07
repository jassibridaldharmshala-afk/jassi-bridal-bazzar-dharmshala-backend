const crypto = require('node:crypto');
const ReturnExchange = require('../models/ReturnExchange');
const Order = require('../models/Order');
const Product = require('../models/Product');
const { ReverseShipment, ReplacementShipment } = require('../models/Shipment');
const { asyncHandler } = require('../middleware/validate');
const { ApiError, forbidden, notFound } = require('../utils/apiError');
const { optionalString, readPagination, requireEnum, requireObjectId, requireQuantity, requireString, wantsPagination, buildPaginatedResponse } = require('../utils/validators');
const { getStoreSettings } = require('../services/paymentSettingsService');
const inventoryService = require('../services/inventoryService');
const { availableStock, hasManagedVariants, requireVariant, variantId } = require('../services/variantService');
const { notifyLater } = require('../services/notificationService');
const { recordEventLater } = require('../services/analyticsService');
const { returnEligibility, returnOrderStatus } = require('../services/returnEligibilityService');
const { actorSource, assertTransition, nextStatuses, refundEstimate, returnPolicySettings, timelineEntry } = require('../services/returnWorkflowService');
const { runInTransaction } = require('../utils/transaction');
const { andFilter } = require('../services/storeService');
const { roleAllows } = require('../models/StoreMember');
const { logAudit } = require('../services/auditService');
const { snapshotAddress } = require('../services/orderSnapshotService');
const couponService = require('../services/couponService');
const { decryptSecret, encryptSecret } = require('../utils/secretBox');
const { createRazorpayPaymentLink, refundRazorpayPayment, fetchRazorpayRefund, isRazorpayConfigured } = require('../services/razorpayService');
const { recordProviderRefund } = require('../services/paymentRefundService');
const { settleExchangeAdjustment } = require('../services/exchangeAdjustmentService');
const InventoryItem = require('../models/InventoryItem');
const VerificationEvidence = require('../models/VerificationEvidence');
const { refreshCustomerRisk } = require('../services/fraudProtectionService');

const RETURN_STATUSES = ReturnExchange.RETURN_STATUSES;
const REFUND_METHODS = ReturnExchange.REFUND_METHODS;
const INVENTORY_DISPOSITIONS = ReturnExchange.INVENTORY_DISPOSITIONS;
const withSession = (query, session) => session ? query.session(session) : query;
const TERMINAL = new Set(['Rejected', 'Cancelled', 'Refunded', 'Exchanged', 'Closed']);
const EVIDENCE_REASONS = /damaged|defective|wrong item|different from description/i;
const selectQuery = (query, fields) => query?.select ? query.select(fields) : query;

function findOrderItem(order, { productId, variantId: selectedVariantId, size, color, orderItemId }) {
  const items = order.orderItems || [];
  if (orderItemId) {
    const byId = items.id?.(orderItemId) || items.find((item) => String(item._id) === String(orderItemId));
    return byId && String(byId.product) === String(productId) ? byId : null;
  }
  return items.find((item) => {
    if (String(item.product) !== String(productId)) return false;
    if (selectedVariantId && item.variantId && String(item.variantId) !== String(selectedVariantId)) return false;
    if (size && item.size && String(item.size) !== String(size)) return false;
    if (color && item.color && String(item.color) !== String(color)) return false;
    return true;
  });
}

function managedPhoto(url) {
  const value = String(url || '').trim();
  if (/^\/uploads\/[\w./%-]+$/.test(value) && !value.includes('..')) return value;
  return [process.env.R2_PUBLIC_URL, process.env.CLOUDINARY_CLOUD_NAME && `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/`]
    .filter(Boolean).some((base) => {
      try {
        const candidate = new URL(value);
        const allowed = new URL(String(base));
        const allowedPath = allowed.pathname.replace(/\/$/, '');
        return candidate.protocol === 'https:' && candidate.origin === allowed.origin
          && (!allowedPath || candidate.pathname === allowedPath || candidate.pathname.startsWith(`${allowedPath}/`));
      } catch { return false; }
    })
    ? value : '';
}

function readPhotos(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(managedPhoto).filter(Boolean))].slice(0, 5);
}

function readCustomerEvidence(value, photos = []) {
  const records = (Array.isArray(value) ? value : []).slice(0, 8).map(item => ({
    type: String(item?.type || '').toUpperCase(), fileUrl: managedPhoto(item?.fileUrl), mimeType: String(item?.mimeType || '').slice(0, 100), sizeBytes: Math.max(0, Number(item?.sizeBytes || 0)),
  })).filter(item => ['CUSTOMER_PHOTO', 'CUSTOMER_VIDEO'].includes(item.type) && item.fileUrl);
  for (const fileUrl of photos) if (!records.some(item => item.fileUrl === fileUrl)) records.push({ type: 'CUSTOMER_PHOTO', fileUrl });
  return records.slice(0, 8);
}

function returnQuery(query, detail = false) {
  const orderFields = detail
    ? 'invoiceNumber createdAt deliveredAt orderStatus paymentMethod paymentProvider paymentStatus paymentState finalAmount refundedAmount refunds couponDiscount prepaidDiscount shippingAddress orderItems revision packageVerification fraudProtectionSnapshot deliveryProof'
    : 'invoiceNumber createdAt orderStatus paymentStatus paymentMethod finalAmount';
  return query
    .populate('user', 'name phone email')
    .populate('assignee', 'name phone email')
    .populate('order', orderFields)
    .populate('product', 'name images sku category')
    .populate('shipment', 'provider courierName status awb trackingNumber trackingUrl expectedDeliveryAt pickup events bookingState labelAvailable lastError')
    .populate('replacementShipment', 'provider courierName status awb trackingNumber trackingUrl expectedDeliveryAt pickup events bookingState labelAvailable lastError');
}

function maskPhone(value) {
  const phone = String(value || '').replace(/\D/g, '');
  return phone.length >= 4 ? `${'*'.repeat(Math.max(0, phone.length - 4))}${phone.slice(-4)}` : '';
}

function canViewPii(req) {
  return req.user?.role === 'admin' || (req.storeMember && roleAllows(req.storeMember.role, 'returns.refund.pii'));
}

function publicReturn(row, req, { detail = false, revealPii = false } = {}) {
  const data = row?.toObject ? row.toObject() : { ...row };
  const encryptedDestination = data.refundDestinationEncrypted;
  delete data.refundDestinationEncrypted;
  if (detail && revealPii && encryptedDestination && canViewPii(req)) {
    try { data.refundDestination = JSON.parse(decryptSecret(encryptedDestination)); }
    catch { data.refundDestination = undefined; }
  }
  if (data.user && !detail) data.user.phone = maskPhone(data.user.phone);
  if (data.user && !canViewPii(req)) {
    data.user.phone = maskPhone(data.user.phone);
    delete data.user.email;
  }
  if (!canViewPii(req)) {
    if (data.inspection) data.inspection = { status: data.inspection.status, result: data.inspection.status === 'VERIFIED' ? 'VERIFIED' : data.inspection.status === 'NOT_STARTED' ? 'NOT_CHECKED' : 'UNDER_REVIEW', inspectedAt: data.inspection.inspectedAt };
    if (data.refundDecision) data.refundDecision = { decision: data.refundDecision.decision, customerMessage: data.refundDecision.customerMessage, decidedAt: data.refundDecision.decidedAt };
    delete data.customerEvidence;
  }
  if (!detail) {
    delete data.pickupAddress;
    if (data.order?.shippingAddress) delete data.order.shippingAddress;
  }
  data.allowedStatuses = nextStatuses(data);
  return data;
}

exports.revealRefundDestination = asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id, 'return id');
  if (!canViewPii(req)) throw forbidden('You do not have permission to reveal protected refund details.');
  const request = await selectQuery(ReturnExchange.findOne(andFilter({ _id: id }, req.tenantFilter)), '+refundDestinationEncrypted');
  if (!request) throw notFound('Return request not found');
  let destination = null;
  if (request.refundDestinationEncrypted) {
    try { destination = JSON.parse(decryptSecret(request.refundDestinationEncrypted)); }
    catch { throw new ApiError('ENCRYPTED_DATA_UNAVAILABLE', 'Protected refund details could not be read. Ask the customer to confirm them securely.', { statusCode: 409 }); }
  }
  await logAudit({ req, action: 'RETURN_REFUND_DESTINATION_REVEALED', entityType: 'ReturnExchange', entityId: request._id, storeId: request.storeId, after: { method: request.refundMethod, destinationPresent: Boolean(destination) } });
  res.set('Cache-Control', 'no-store');
  res.json({ refundDestination: destination, summary: request.refundDestinationSummary || null });
});

function prepareRefundDestination(method, value) {
  const input = value && typeof value === 'object' ? value : {};
  if (method === 'UPI') {
    const vpa = String(input.vpa || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{2,}@[a-z0-9.-]{2,}$/i.test(vpa) || vpa.length > 100) throw new ApiError('VALIDATION_ERROR', 'Enter a valid UPI ID for the refund.');
    return { encrypted: encryptSecret(JSON.stringify({ type: 'UPI', vpa })), summary: { label: `UPI · ${vpa.replace(/^(.{1,2}).*(@.*)$/, '$1***$2')}` } };
  }
  if (method === 'BANK_TRANSFER') {
    const accountHolder = String(input.accountHolder || '').trim();
    const accountNumber = String(input.accountNumber || '').replace(/\s/g, '');
    const ifsc = String(input.ifsc || '').trim().toUpperCase();
    if (accountHolder.length < 2 || accountHolder.length > 100) throw new ApiError('VALIDATION_ERROR', 'Enter the bank account holder name.');
    if (!/^\d{6,20}$/.test(accountNumber)) throw new ApiError('VALIDATION_ERROR', 'Enter a valid bank account number.');
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) throw new ApiError('VALIDATION_ERROR', 'Enter a valid IFSC code.');
    return { encrypted: encryptSecret(JSON.stringify({ type: 'BANK_TRANSFER', accountHolder, accountNumber, ifsc })), summary: { label: `Bank account ending ${accountNumber.slice(-4)}`, accountLast4: accountNumber.slice(-4) } };
  }
  return { encrypted: '', summary: { label: method === 'ORIGINAL_PAYMENT' ? 'Original payment method' : method === 'STORE_CREDIT' ? 'Store credit' : 'Manual refund arranged with store' } };
}

function validatePickupAddress(value, fallback) {
  const address = snapshotAddress(value && typeof value === 'object' ? value : fallback);
  if (!address.fullName || !/^\d{6}$/.test(address.pincode) || !address.city || !address.state || !address.houseNo || !address.area) {
    throw new ApiError('VALIDATION_ERROR', 'A complete pickup address is required for this return.');
  }
  if (!/^[6-9]\d{9}$/.test(address.mobile)) throw new ApiError('VALIDATION_ERROR', 'A valid pickup mobile number is required.');
  return address;
}

function requireSideEffectPermission(req, status) {
  if (!req.storeMember) return;
  const permission = ['Approved', 'Rejected', 'Cancelled'].includes(status) ? 'returns.review'
    : ['Pickup Scheduled', 'Picked Up', 'In Transit'].includes(status) ? 'returns.ship'
      : ['Received', 'Inspection Pending', 'Verified', 'Mismatch Found', 'QC Passed', 'QC Failed'].includes(status) ? 'returns.qc'
        : ['Refund Initiated', 'Refunded'].includes(status) ? 'returns.refund'
          : ['Exchange Allocated', 'Replacement Shipped', 'Replacement Delivered', 'Exchanged'].includes(status) ? 'returns.fulfil' : 'returns.write';
  if (!roleAllows(req.storeMember.role, permission)) throw forbidden(`You do not have permission to complete the ${status.toLowerCase()} step.`);
}

function exchangeSelection(request) {
  return { product: request.product?._id || request.product, quantity: request.quantity, variantId: request.exchangeVariantId, size: request.exchangeSize, color: request.exchangeColor };
}

exports.createReturn = asyncHandler(async (req, res) => {
  const orderId = requireObjectId(req.body?.order, 'order id');
  const productId = requireObjectId(req.body?.product, 'product id');
  const type = requireEnum(req.body?.type, ['return', 'exchange'], 'type');
  const reason = requireString(req.body?.reason, 'reason', { max: 300 });
  const comment = optionalString(req.body?.comment, 'comment', { max: 2000 });
  const quantity = requireQuantity(req.body?.quantity ?? 1, 'quantity', { min: 1, max: 20 });
  const photos = readPhotos(req.body?.photos);
  const customerEvidence = readCustomerEvidence(req.body?.customerEvidence, photos);

  let created;
  let orderForNotice;
  await runInTransaction(async (session) => {
    const order = await withSession(Order.findOne(andFilter({ _id: orderId, user: req.user._id }, req.tenantFilter)), session);
    if (!order) throw notFound('Order not found');
    if (!['Delivered', 'Return Requested', 'Exchange Requested', 'Returned', 'Refunded'].includes(order.orderStatus)) throw new ApiError('VALIDATION_ERROR', 'Returns can only be requested once the order is delivered');
    const refundMethod = type === 'return'
      ? requireEnum(req.body?.refundMethod || (order.paymentMethod === 'COD' ? 'MANUAL' : 'ORIGINAL_PAYMENT'), REFUND_METHODS, 'refund method')
      : 'ORIGINAL_PAYMENT';
    if (refundMethod === 'STORE_CREDIT') throw new ApiError('VALIDATION_ERROR', 'Store credit is not enabled for checkout yet. Choose UPI, bank transfer or the original online payment so the refund remains usable.');
    if (type === 'return' && refundMethod === 'ORIGINAL_PAYMENT' && order.paymentMethod === 'COD') throw new ApiError('VALIDATION_ERROR', 'Cash on delivery orders need a UPI, bank transfer or manual refund destination.');
    const refundDestination = prepareRefundDestination(refundMethod, req.body?.refundDestination);
    const orderedItem = findOrderItem(order, { productId, variantId: req.body?.variantId, size: req.body?.size, color: req.body?.color, orderItemId: req.body?.orderItemId });
    if (!orderedItem) throw new ApiError('VALIDATION_ERROR', 'That product is not part of this order');
    if (EVIDENCE_REASONS.test(reason) && !photos.length) throw new ApiError('VALIDATION_ERROR', 'Add at least one clear photo for this return reason.');

    const currentSettings = await getStoreSettings(req.tenantFilter || (order.storeId ? { storeId: order.storeId } : {}));
    if (currentSettings.requireReturnPhotos && !customerEvidence.some(item => item.type === 'CUSTOMER_PHOTO')) throw new ApiError('VALIDATION_ERROR', 'Add the required return photos.');
    if (currentSettings.requireReturnVideo && !customerEvidence.some(item => item.type === 'CUSTOMER_VIDEO')) throw new ApiError('VALIDATION_ERROR', 'Add the required return video.');
    const settings = returnPolicySettings(order, currentSettings);
    const prior = await withSession(ReturnExchange.find({ order: orderId, user: req.user._id }), session);
    const eligibility = returnEligibility(order, prior, settings);
    const itemEligibility = eligibility.items.find((item) => item.orderItemId === String(orderedItem._id));
    if (!itemEligibility) throw new ApiError('VALIDATION_ERROR', 'Return eligibility could not be confirmed for this item.');
    const eligibilityErrorCode = itemEligibility.reason === 'The return window has closed.' ? 'RETURN_WINDOW_EXPIRED' : Number(itemEligibility.remainingQuantity || 0) <= 0 ? 'DUPLICATE_REQUEST' : 'VALIDATION_ERROR';
    if (type === 'return' && !itemEligibility.canReturn) throw new ApiError(eligibilityErrorCode, itemEligibility.reason || 'This item cannot be returned.');
    if (type === 'exchange' && !itemEligibility.canExchange) throw new ApiError(eligibilityErrorCode, itemEligibility.reason || 'This item cannot be exchanged.');
    if (quantity > Number(itemEligibility.remainingQuantity || 0)) throw new ApiError(itemEligibility.remainingQuantity ? 'VALIDATION_ERROR' : 'DUPLICATE_REQUEST', itemEligibility.remainingQuantity ? `Only ${itemEligibility.remainingQuantity} unit(s) can still be returned for this item` : 'A request for this item is already in progress');

    let exchangeVariantId = '';
    let exchangeSize = optionalString(req.body?.exchangeSize, 'exchangeSize', { max: 40 });
    let exchangeColor = optionalString(req.body?.exchangeColor, 'exchangeColor', { max: 40 });
    let exchangeUnitPrice = Number(orderedItem.price || 0);
    let product = null;
    if (type === 'exchange') {
      product = await withSession(Product.findOne(andFilter({ _id: productId }, order.storeId ? { storeId: order.storeId } : req.tenantFilter)), session);
      if (!product) throw notFound('Product not found');
      if (product.isActive === false || product.isArchived) throw new ApiError('OUT_OF_STOCK', 'This product is unavailable for exchange');
      if (hasManagedVariants(product)) {
        const variant = requireVariant(product, { variantId: req.body?.exchangeVariantId, size: exchangeSize || orderedItem.size, color: exchangeColor || orderedItem.color });
        if (availableStock(product, { variantId: variantId(variant) }) < quantity) throw new ApiError('OUT_OF_STOCK', 'The requested exchange size or colour is not in stock');
        exchangeVariantId = variantId(variant); exchangeSize = variant.size; exchangeColor = variant.color;
        exchangeUnitPrice = Number(variant.price || product.price || orderedItem.price || 0);
      } else {
        if (availableStock(product) < quantity) throw new ApiError('OUT_OF_STOCK', 'This product is not in stock for exchange');
        exchangeSize = exchangeSize || orderedItem.size; exchangeColor = exchangeColor || orderedItem.color;
        if (product.sizes?.length && !product.sizes.includes(exchangeSize)) throw new ApiError('VARIANT_UNAVAILABLE', 'Choose an available exchange size');
        if (product.colors?.length && !product.colors.includes(exchangeColor)) throw new ApiError('VARIANT_UNAVAILABLE', 'Choose an available exchange colour');
        exchangeUnitPrice = Number(product.price || orderedItem.price || 0);
      }
    }

    const financial = refundEstimate(order, orderedItem, quantity, settings, { priorRequests: prior, sellerFault: EVIDENCE_REASONS.test(reason) });
    const exchangePriceDifference = type === 'exchange' ? Math.round((exchangeUnitPrice - Number(orderedItem.price || 0)) * quantity * 100) / 100 : 0;
    const payload = {
      caseNumber: `RET-${Date.now().toString(36).toUpperCase()}-${String(req.user._id).slice(-4).toUpperCase()}`,
      order: orderId, product: productId, user: req.user._id,
      orderItemId: String(orderedItem._id || ''), variantId: orderedItem.variantId || '', size: orderedItem.size || '', color: orderedItem.color || '', sku: orderedItem.sku || '',
      quantity, type, reason, comment, photos, customerEvidence, refundMethod,
      refundDestinationEncrypted: refundDestination.encrypted || undefined,
      refundDestinationSummary: refundDestination.summary,
      pickupAddress: validatePickupAddress(req.body?.pickupAddress, order.shippingAddress),
      productSnapshot: { name: orderedItem.name || product?.name || 'Ordered product', image: orderedItem.image || '', unitPrice: Number(orderedItem.price || 0), unitMrp: Number(orderedItem.originalPrice || orderedItem.price || 0), tax: Number(orderedItem.tax || 0), returnPolicy: itemEligibility.returnPolicy || '' },
      policySnapshot: { windowDays: itemEligibility.windowDays, deadline: itemEligibility.deadline, returnable: itemEligibility.canReturn, exchangeable: itemEligibility.canExchange, terms: itemEligibility.returnPolicy || order.invoiceSeller?.returnPolicy || settings.returnPolicy || '' },
      financial: { ...financial, approvedRefundAmount: 0, refundedAmount: 0, refundStatus: type === 'return' ? 'PENDING' : 'NOT_REQUIRED', exchangeUnitPrice, exchangePriceDifference, exchangeAdjustmentStatus: exchangePriceDifference > 0 ? 'AMOUNT_DUE' : exchangePriceDifference < 0 ? 'CREDIT_DUE' : 'NOT_REQUIRED' },
      exchangeVariantId, exchangeSize, exchangeColor, status: 'Requested', storeId: order.storeId,
      statusTimeline: [timelineEntry(req, 'Requested', `${type === 'exchange' ? 'Exchange' : 'Return'} requested by customer.`)],
      slaDueAt: new Date(Date.now() + Math.max(1, Number(settings.returnSlaHours || 24)) * 60 * 60 * 1000),
    };
    created = session ? (await ReturnExchange.create([payload], { session }))[0] : await ReturnExchange.create(payload);
    if (customerEvidence.length) await VerificationEvidence.insertMany(customerEvidence.map(item => ({ ...item, fileUrl: item.fileUrl, order: orderId, returnRequest: created._id, orderItemId: String(orderedItem._id || ''), phase: 'RETURN_REQUEST', uploadedBy: req.user._id, storeId: order.storeId })), session ? { session } : {});
    if (orderedItem.uniqueItemIds?.length) await InventoryItem.updateMany(andFilter({ uniqueItemId: { $in: orderedItem.uniqueItemIds } }, order.storeId ? { storeId: order.storeId } : req.tenantFilter), { $set: { status: 'RETURN_REQUESTED' } }, session ? { session } : {});
    try {
      order.orderStatus = type === 'exchange' ? 'Exchange Requested' : 'Return Requested';
      order.statusTimeline.push({ status: order.orderStatus, date: new Date(), note: `${type} requested for ${orderedItem.name || 'item'}` });
      order.revision = Number(order.revision || 0) + 1;
      await order.save(session ? { session } : {});
    } catch (error) {
      if (!session && created?._id) await ReturnExchange.deleteOne({ _id: created._id }).catch(() => null);
      throw error;
    }
    orderForNotice = order;
  });

  recordEventLater({ name: 'RETURN_REQUESTED', storeId: orderForNotice.storeId, userId: req.user._id, orderId: orderForNotice._id, productId });
  await logAudit({ req, action: 'RETURN_REQUEST_CREATE', entityType: 'ReturnExchange', entityId: created._id, storeId: orderForNotice.storeId, after: { type, reason, quantity, orderId: String(orderForNotice._id), orderItemId: created.orderItemId, status: created.status } });
  notifyLater({ userId: req.user._id, storeId: orderForNotice.storeId, event: 'RETURN_REQUESTED', title: type === 'exchange' ? 'Exchange requested' : 'Return requested', message: 'We have received your request and will update you after review.', metadata: { orderId: String(orderForNotice._id), returnId: String(created._id) } });
  res.status(201).json(publicReturn(created, req, { detail: true }));
});

exports.myReturns = asyncHandler(async (req, res) => {
  const status = req.query.status ? requireEnum(req.query.status, RETURN_STATUSES, 'status') : '';
  const type = req.query.type ? requireEnum(req.query.type, ['return', 'exchange'], 'type') : '';
  const filter = andFilter({ user: req.user._id, ...(status ? { status } : {}), ...(type ? { type } : {}) }, req.tenantFilter);
  const { page, limit, skip } = readPagination(req.query, { defaultLimit: 20, maxLimit: 50 });
  const [items, total] = await Promise.all([returnQuery(ReturnExchange.find(filter)).sort('-createdAt').skip(skip).limit(limit), ReturnExchange.countDocuments(filter)]);
  const payload = items.map((item) => publicReturn(item, req, { detail: true }));
  res.json(wantsPagination(req.query) ? buildPaginatedResponse(payload, { page, limit, total }) : payload);
});

exports.orderReturns = asyncHandler(async (req, res) => {
  const orderId = requireObjectId(req.params.orderId, 'order id');
  const order = await Order.findOne(andFilter({ _id: orderId, user: req.user._id }, req.tenantFilter));
  if (!order) throw notFound('Order not found');
  const [requests, currentSettings] = await Promise.all([ReturnExchange.find({ order: orderId, user: req.user._id }).sort('-createdAt'), getStoreSettings(req.tenantFilter || {})]);
  res.json({ requests: requests.map((item) => publicReturn(item, req, { detail: true })), ...returnEligibility(order, requests, returnPolicySettings(order, currentSettings)) });
});

function adminFilter(req, { attentionShipmentIds = [] } = {}) {
  const extra = {};
  if (req.query.from || req.query.to || req.query.range) {
    const { dashboardRange, periodFilter } = require('../services/dashboardAnalytics');
    Object.assign(extra, periodFilter(dashboardRange(req.query)));
  }
  if (req.query.id) extra._id = requireObjectId(req.query.id, 'return id');
  if (req.query.orderId) extra.order = requireObjectId(req.query.orderId, 'order id');
  if (req.query.status) extra.status = requireEnum(req.query.status, RETURN_STATUSES, 'status');
  if (req.query.type) extra.type = requireEnum(req.query.type, ['return', 'exchange'], 'type');
  if (req.query.qcStatus) extra['qc.status'] = requireEnum(req.query.qcStatus, ['PENDING', 'PASSED', 'FAILED', 'NOT_REQUIRED'], 'QC status');
  if (req.query.refundStatus) extra['financial.refundStatus'] = requireEnum(req.query.refundStatus, ['NOT_REQUIRED', 'PENDING', 'INITIATED', 'PROCESSED', 'FAILED'], 'refund status');
  if (req.query.sla === 'overdue') { extra.slaDueAt = { $lt: new Date() }; if (!req.query.status) extra.status = { $nin: [...TERMINAL] }; }
  if (req.query.attention === '1') extra.$or = [
    { status: { $in: ['QC Failed', 'Mismatch Found'] } }, { 'financial.refundStatus': 'FAILED' },
    { type: 'exchange', exchangeDeducted: true, exchangeReservationReleased: { $ne: true }, exchangeReservationExpiresAt: { $lt: new Date() } },
    ...(attentionShipmentIds.length ? [{ shipment: { $in: attentionShipmentIds } }, { replacementShipment: { $in: attentionShipmentIds } }] : []),
  ];
  return extra;
}

exports.adminReturns = asyncHandler(async (req, res) => {
  let attentionShipmentIds = [];
  if (req.query.attention === '1') {
    const [reverse, replacement] = await Promise.all([
      ReverseShipment.distinct('_id', andFilter({ status: { $in: ['EXCEPTION', 'FAILED'] } }, req.tenantFilter)),
      ReplacementShipment.distinct('_id', andFilter({ status: { $in: ['EXCEPTION', 'FAILED', 'RTO_IN_TRANSIT', 'RETURNED'] } }, req.tenantFilter)),
    ]);
    attentionShipmentIds = [...reverse, ...replacement];
  }
  const extra = adminFilter(req, { attentionShipmentIds });
  const search = optionalString(req.query.search, 'search', { max: 100 });
  if (search) {
    const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const [users, products, orders, shipments] = await Promise.all([
      require('../models/User').find({ $or: [{ name: regex }, { phone: regex }] }).select('_id').lean(),
      Product.find(andFilter({ $or: [{ name: regex }, { sku: regex }] }, req.tenantFilter)).select('_id').lean(),
      Order.find(andFilter({ invoiceNumber: regex }, req.tenantFilter)).select('_id').lean(),
      ReverseShipment.find(andFilter({ $or: [{ courierName: regex }, { provider: regex }, { awb: regex }, { trackingNumber: regex }] }, req.tenantFilter)).select('_id').lean(),
    ]);
    const searchConditions = [{ user: { $in: users.map(user => user._id) } }, { product: { $in: products.map(product => product._id) } }, { order: { $in: orders.map(order => order._id) } }, { shipment: { $in: shipments.map(shipment => shipment._id) } }, { reason: regex }, { type: regex }, { $expr: { $regexMatch: { input: { $toString: '$_id' }, regex: regex.source, options: 'i' } } }];
    if (extra.$or) { extra.$and = [{ $or: extra.$or }, { $or: searchConditions }]; delete extra.$or; }
    else extra.$or = searchConditions;
  }
  const filter = andFilter(extra, req.tenantFilter);
  const { page, limit, skip } = readPagination(req.query, { defaultLimit: 25, maxLimit: 100 });
  const [items, total] = await Promise.all([returnQuery(ReturnExchange.find(filter)).sort('-createdAt').skip(skip).limit(limit), ReturnExchange.countDocuments(filter)]);
  const rows = items.map((item) => publicReturn(item, req));
  res.json(wantsPagination(req.query) ? buildPaginatedResponse(rows, { page, limit, total }) : rows);
});

exports.adminReturnStats = asyncHandler(async (req, res) => {
  const filter = andFilter(adminFilter(req), req.tenantFilter);
  const [rows, money, overdue, refundPending, refundFailed, reservationExpired, courierExceptions, qcFailedIds] = await Promise.all([
    ReturnExchange.aggregate([{ $match: filter }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    ReturnExchange.aggregate([{ $match: andFilter({ type: 'return' }, filter) }, { $group: { _id: null, estimated: { $sum: '$financial.estimatedRefundAmount' }, approved: { $sum: '$financial.approvedRefundAmount' }, refunded: { $sum: '$financial.refundedAmount' } } }]),
    ReturnExchange.countDocuments(andFilter({ slaDueAt: { $lt: new Date() }, status: { $nin: [...TERMINAL] } }, filter)),
    ReturnExchange.countDocuments(andFilter({ type: 'return', status: { $in: ['QC Passed', 'Refund Initiated'] } }, filter)),
    ReturnExchange.distinct('_id', andFilter({ 'financial.refundStatus': 'FAILED' }, filter)),
    ReturnExchange.distinct('_id', andFilter({ type: 'exchange', exchangeDeducted: true, exchangeReservationReleased: { $ne: true }, exchangeReservationExpiresAt: { $lt: new Date() }, status: { $nin: ['Replacement Shipped', 'Replacement Delivered', 'Exchanged', 'Closed', 'Cancelled'] } }, filter)),
    Promise.all([
      ReverseShipment.distinct('returnRequest', andFilter({ status: { $in: ['EXCEPTION', 'FAILED'] } }, req.tenantFilter)),
      ReplacementShipment.distinct('returnRequest', andFilter({ status: { $in: ['EXCEPTION', 'FAILED', 'RTO_IN_TRANSIT', 'RETURNED'] } }, req.tenantFilter)),
    ]).then(values => [...new Set(values.flat().map(String))]),
    ReturnExchange.distinct('_id', andFilter({ status: { $in: ['QC Failed', 'Mismatch Found'] } }, filter)),
  ]);
  const byStatus = Object.fromEntries(rows.map(row => [row._id, row.count]));
  const openStatuses = RETURN_STATUSES.filter(status => !TERMINAL.has(status));
  const exceptions = new Set([...qcFailedIds, ...refundFailed, ...reservationExpired, ...courierExceptions].map(String)).size;
  res.json({ total: rows.reduce((sum, row) => sum + row.count, 0), awaitingReview: byStatus.Requested || 0, pickupDue: (byStatus.Approved || 0) + (byStatus['Pickup Scheduled'] || 0), inTransit: (byStatus['Picked Up'] || 0) + (byStatus['In Transit'] || 0), qcPending: (byStatus.Received || 0) + (byStatus['Inspection Pending'] || 0) + (byStatus['Mismatch Found'] || 0), refundPending, refundFailed: refundFailed.length, reservationExpired: reservationExpired.length, courierExceptions: courierExceptions.length, exceptions, overdue, open: openStatuses.reduce((sum, status) => sum + Number(byStatus[status] || 0), 0), financial: money[0] || { estimated: 0, approved: 0, refunded: 0 }, byStatus });
});

exports.getReturnDetail = asyncHandler(async (req, res) => {
  requireObjectId(req.params.id, 'return id');
  const request = await returnQuery(selectQuery(ReturnExchange.findOne(andFilter({ _id: req.params.id }, req.tenantFilter)), '+refundDestinationEncrypted'), true);
  if (!request) throw notFound('Return request not found');
  const [evidence, risk] = await Promise.all([
    VerificationEvidence.find(andFilter({ order: request.order?._id || request.order, $or: [{ returnRequest: request._id }, { phase: 'PACKING' }] }, req.tenantFilter)).sort('uploadedAt').lean(),
    refreshCustomerRisk({ storeId: request.storeId, userId: request.user?._id || request.user }),
  ]);
  res.set('Cache-Control', 'private, no-store').json({ ...publicReturn(request, req, { detail: true }), verificationEvidence: evidence, customerRisk: risk });
});

async function restoreOriginalIfSellable(request, req, session) {
  if (request.inventoryRestored || request.qc?.disposition !== 'RESTOCK') return;
  const quantity = Math.min(Number(request.quantity || 1), Number(request.qc?.receivedQuantity || request.quantity || 1));
  const claim = await ReturnExchange.findOneAndUpdate({ _id: request._id, inventoryRestored: { $ne: true } }, { $set: { inventoryRestored: true, inventoryRestoredAt: new Date() } }, { new: true, session });
  if (!claim) return;
  try {
    await inventoryService.restoreStockForOrder([{ product: request.product, quantity, variantId: request.variantId }], { orderId: request.order, userId: req.user._id, type: 'RETURN', reason: 'Return passed quality inspection', session });
    request.inventoryRestored = true; request.inventoryRestoredAt = new Date();
  } catch (error) {
    if (!session) await ReturnExchange.updateOne({ _id: request._id }, { $set: { inventoryRestored: false }, $unset: { inventoryRestoredAt: 1 } });
    throw error;
  }
}

async function recordReturnedNonSellableStock(request, req, session) {
  if (request.inventoryDispositionRecorded || !['DAMAGED', 'QUARANTINE'].includes(request.qc?.disposition)) return;
  const quantity = Math.min(Number(request.quantity || 1), Number(request.qc?.receivedQuantity || request.quantity || 1));
  if (quantity < 1) return;
  await inventoryService.applyInventoryAdjustment({
    productId: request.product,
    variantId: request.variantId,
    mode: 'ADD',
    bucket: request.qc.disposition,
    quantity,
    reasonCode: request.qc.disposition === 'DAMAGED' ? 'DAMAGED' : 'CUSTOMER_RETURN',
    reason: `Returned item moved to ${request.qc.disposition.toLowerCase()}`,
    note: request.qc?.notes,
    reference: `Return ${request._id}`,
    idempotencyKey: `return-disposition:${request._id}:${request.qc.disposition}`,
    tenantFilter: request.storeId ? { storeId: request.storeId } : req.tenantFilter,
    userId: req.user?._id,
  }, session);
  await ReturnExchange.updateOne(
    { _id: request._id, inventoryDispositionRecorded: { $ne: true } },
    { $set: { inventoryDispositionRecorded: true, inventoryDispositionRecordedAt: new Date() } },
    { session },
  );
  request.inventoryDispositionRecorded = true;
  request.inventoryDispositionRecordedAt = new Date();
}

async function reserveExchange(request, req, session) {
  if (request.type !== 'exchange' || request.exchangeDeducted) return;
  const product = await withSession(Product.findOne(andFilter({ _id: request.product }, request.storeId ? { storeId: request.storeId } : req.tenantFilter)), session);
  const selection = exchangeSelection(request);
  if (product && hasManagedVariants(product) && !selection.variantId) selection.variantId = variantId(requireVariant(product, { size: request.exchangeSize, color: request.exchangeColor }));
  const settings = await getStoreSettings(request.storeId ? { storeId: request.storeId } : req.tenantFilter || {});
  const reservedAt = new Date();
  const expiresAt = new Date(reservedAt.getTime() + Math.max(1, Number(settings.exchangeReservationHours || 168)) * 60 * 60 * 1000);
  const claim = await ReturnExchange.findOneAndUpdate({ _id: request._id, exchangeDeducted: { $ne: true } }, { $set: { exchangeDeducted: true, exchangeReservedAt: reservedAt, exchangeReservationExpiresAt: expiresAt, exchangeReservationReleased: false } }, { new: true, session });
  if (!claim) return;
  try {
    await inventoryService.deductStockForOrder([selection], { orderId: request.order, userId: req.user._id, reason: 'Exchange stock reserved', session });
    request.exchangeDeducted = true; request.exchangeReservedAt = reservedAt; request.exchangeReservationExpiresAt = expiresAt; request.exchangeReservationReleased = false;
  } catch (error) {
    if (!session) await ReturnExchange.updateOne({ _id: request._id }, { $set: { exchangeDeducted: false, exchangeReservationReleased: false }, $unset: { exchangeReservedAt: 1 } });
    throw error;
  }
}

async function releaseExchange(request, req, session) {
  if (request.type !== 'exchange' || !request.exchangeDeducted || request.exchangeReservationReleased) return;
  const claim = await ReturnExchange.findOneAndUpdate({ _id: request._id, exchangeDeducted: true, exchangeReservationReleased: { $ne: true } }, { $set: { exchangeReservationReleased: true } }, { new: true, session });
  if (!claim) return;
  try {
    await inventoryService.restoreStockForOrder([exchangeSelection(request)], { orderId: request.order, userId: req.user._id, type: 'CANCELLATION', reason: 'Exchange reservation released', session });
    request.exchangeReservationReleased = true;
  } catch (error) {
    if (!session) await ReturnExchange.updateOne({ _id: request._id }, { $set: { exchangeReservationReleased: false } });
    throw error;
  }
}

function applyQc(request, body, req) {
  const status = body.status;
  if (!['QC Passed', 'QC Failed'].includes(status)) return;
  const defaultDisposition = status === 'QC Failed' ? 'QUARANTINE' : '';
  const disposition = requireEnum(body.inventoryDisposition || defaultDisposition, INVENTORY_DISPOSITIONS.filter(value => value !== 'PENDING'), 'inventory disposition');
  if (status === 'QC Passed' && disposition === 'MISSING') throw new ApiError('VALIDATION_ERROR', 'A received item cannot pass inspection as missing.');
  const receivedQuantity = requireQuantity(body.receivedQuantity ?? request.quantity, 'received quantity', { min: disposition === 'MISSING' ? 0 : 1, max: Number(request.quantity || 1) });
  request.qc = { status: status === 'QC Passed' ? 'PASSED' : 'FAILED', disposition, receivedQuantity, notes: optionalString(body.qcNotes, 'QC notes', { max: 1000 }), inspectedAt: new Date(), inspectedBy: req.user._id };
}

function applyRefund(request, order, body, status, req) {
  if (request.type !== 'return' || !['Refund Initiated', 'Refunded'].includes(status)) return false;
  const paymentCollected = order.paymentStatus === 'Paid' || ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(order.paymentState);
  if (!paymentCollected) throw new ApiError('PAYMENT_NOT_COLLECTED', 'A refund cannot be recorded until payment collection is confirmed.', { statusCode: 409 });
  if (!request.financial) request.financial = {};
  const estimated = Number(request.financial?.estimatedRefundAmount || 0);
  const approved = Math.round(Number(body.refundAmount ?? request.financial?.approvedRefundAmount ?? estimated) * 100) / 100;
  const settlementAmount = order.paymentMethod === 'COD' ? Number(order.adjustedFinalAmount ?? order.finalAmount ?? 0) : Number(order.finalAmount || 0);
  const remaining = Math.round(Math.max(0, settlementAmount - Number(order.refundedAmount || 0)) * 100) / 100;
  const maximum = Math.round(Math.min(remaining, estimated > 0 ? estimated : remaining) * 100) / 100;
  if (!Number.isFinite(approved) || approved <= 0 || approved > maximum) throw new ApiError('VALIDATION_ERROR', `Refund amount must be between Rs. 0.01 and Rs. ${maximum.toFixed(2)}.`);
  request.financial.approvedRefundAmount = approved;
  if (status === 'Refund Initiated') {
    const initiatedAt = new Date();
    const configuredDays = Number(process.env.REFUND_EXPECTED_DAYS || 7);
    const expectedDays = Number.isFinite(configuredDays) ? Math.min(30, Math.max(1, Math.round(configuredDays))) : 7;
    request.financial.refundStatus = 'INITIATED'; request.financial.initiatedAt = initiatedAt;
    request.financial.expectedBy = new Date(initiatedAt.getTime() + expectedDays * 24 * 60 * 60 * 1000);
    return false;
  }
  const reference = requireString(body.refundReference, 'refund reference', { max: 120 });
  const priorForReturn = (order.refunds || []).find(refund => refund.sourceType === 'RETURN' && String(refund.sourceId || '') === String(request._id));
  if (priorForReturn) {
    request.financial.refundStatus = 'PROCESSED'; request.financial.refundedAmount = Number(priorForReturn.amount || approved);
    request.financial.refundReference = priorForReturn.providerRefundId; request.financial.processedAt = priorForReturn.processedAt || new Date();
    return Number(order.refundedAmount || 0) >= settlementAmount;
  }
  if ((order.refunds || []).some(refund => String(refund.providerRefundId || '') === reference)) {
    throw new ApiError('DUPLICATE_REQUEST', 'This refund reference is already attached to another refund.', { statusCode: 409 });
  }
  request.financial.refundStatus = 'PROCESSED'; request.financial.refundedAmount = approved; request.financial.refundReference = reference; request.financial.processedAt = new Date();
  const total = Math.round((Number(order.refundedAmount || 0) + approved) * 100) / 100;
  order.refundedAmount = total;
  const full = total >= settlementAmount;
  order.paymentState = full ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
  if (full) order.paymentStatus = 'Refunded';
  if (!Array.isArray(order.refunds)) order.refunds = [];
  if (!Array.isArray(order.paymentEvents)) order.paymentEvents = [];
  order.refunds.push({ providerRefundId: reference, paymentId: order.razorpayPaymentId, provider: request.refundMethod === 'STORE_CREDIT' ? 'store_credit' : order.paymentMethod === 'COD' ? 'manual' : String(order.paymentProvider || 'manual').toLowerCase(), amount: approved, currency: 'INR', status: 'PROCESSED', sourceType: 'RETURN', sourceId: String(request._id), note: optionalString(body.adminComment, 'adminComment', { max: 1000 }) || `Refund recorded for return ${request._id}`, processedAt: new Date() });
  order.paymentEvents.push({ state: order.paymentState, status: 'Refunded', amount: approved, reference, note: `Refund recorded for return ${request._id}`, source: actorSource(req), actor: { id: String(req.user._id), name: req.user.name || 'Account' }, date: new Date() });
  return full;
}

async function applyReturnStatus(req, id, body) {
  const status = requireEnum(body?.status, RETURN_STATUSES, 'status');
  const adminComment = optionalString(body?.adminComment, 'adminComment', { max: 1000 });
  requireSideEffectPermission(req, status);
  let fullRefund = false;
  const operation = `return-status:${crypto.randomUUID()}`;
  let locked = null;
  for (let attempt = 0; attempt < 12 && !locked; attempt += 1) {
    locked = await ReturnExchange.findOneAndUpdate(andFilter({ _id: id, $or: [{ operation: '' }, { operation: { $exists: false } }, { operationUntil: { $lt: new Date() } }] }, req.tenantFilter), { $set: { operation, operationUntil: new Date(Date.now() + 60000) } }, { new: true });
    if (locked) break;
    const current = await ReturnExchange.findOne(andFilter({ _id: id }, req.tenantFilter)).select('+operation +operationUntil');
    if (!current) throw notFound('Return request not found');
    if (current.status === status && body?.processWithProvider !== true) return current;
    if (!current.operation || !current.operationUntil || current.operationUntil < new Date()) continue;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  if (!locked) {
    const exists = await ReturnExchange.exists(andFilter({ _id: id }, req.tenantFilter));
    if (!exists) throw notFound('Return request not found');
    throw new ApiError('RETURN_CHANGED', 'This return is already being updated. Reload it before continuing.', { statusCode: 409 });
  }
  let result;
  try {
    result = await runInTransaction(async (session) => {
    const request = await withSession(selectQuery(ReturnExchange.findOne(andFilter({ _id: id }, req.tenantFilter)), '+operation +operationUntil'), session);
    if (!request) throw notFound('Return request not found');
    if (body?.revision !== undefined && Number(body.revision) !== Number(request.revision || 0)) throw new ApiError('RETURN_CHANGED', 'This return changed in another session. Reload it before continuing.', { statusCode: 409 });
    if (request.status === status && body?.processWithProvider !== true) return { request, changed: false };
    assertTransition(request, status);
    if (['Rejected', 'Cancelled', 'QC Failed'].includes(status) && !adminComment && !body?.qcNotes) throw new ApiError('VALIDATION_ERROR', `Add a note before marking this request ${status.toLowerCase()}.`);
    const orderQuery = req.tenantFilter && Object.keys(req.tenantFilter).length
      ? Order.findOne(andFilter({ _id: request.order }, req.tenantFilter))
      : Order.findById(request.order);
    const order = await withSession(selectQuery(orderQuery, '+paymentEvents'), session);
    if (!order) throw notFound('Order not found');
    const before = { status: request.status, revision: request.revision, qc: request.qc, financial: request.financial };
    // Terminal moves do not start a new SLA. Avoid an unnecessary settings
    // lookup so closing an already-resolved case remains reliable even when the
    // settings service is temporarily unavailable.
    const workflowSettings = TERMINAL.has(status)
      ? null
      : await getStoreSettings(request.storeId ? { storeId: request.storeId } : req.tenantFilter || {});

    const protectedReturn = Boolean(order.fraudProtectionSnapshot?.capturedAt && order.packageVerification?.status !== 'NOT_REQUIRED');
    if (protectedReturn && ['Verified', 'Mismatch Found'].includes(status)) {
      const requiredInspectionStatus = status === 'Verified' ? 'VERIFIED' : 'MISMATCH_FOUND';
      if (request.inspection?.status !== requiredInspectionStatus) throw new ApiError('RETURN_INSPECTION_REQUIRED', 'Use the item comparison inspection before recording this verification result.', { statusCode: 409 });
    }
    if (protectedReturn && status === 'QC Passed' && request.inspection?.status !== 'VERIFIED') {
      throw new ApiError('RETURN_INSPECTION_REQUIRED', 'The returned item must pass identity and evidence verification before quality control can pass.', { statusCode: 409 });
    }
    if (['Refund Initiated', 'Refunded'].includes(status) && protectedReturn) {
      if (!['APPROVED', 'PARTIAL'].includes(request.refundDecision?.decision)) throw new ApiError('REFUND_VERIFICATION_REQUIRED', 'Record an approved refund decision after return inspection before initiating payment.', { statusCode: 409 });
      if (request.inspection?.status === 'MISMATCH_FOUND' && !request.refundDecision?.reason) throw new ApiError('MANUAL_REVIEW_REQUIRED', 'A flagged mismatch needs a documented manual override before refund.', { statusCode: 409 });
    }

    if (status === 'Cancelled') {
      const [reverseBooking, replacementBooking] = await Promise.all([
        withSession(ReverseShipment.findOne({ returnRequest: request._id }), session),
        withSession(ReplacementShipment.findOne({ returnRequest: request._id }), session),
      ]);
      const activeBooking = [reverseBooking, replacementBooking].find(booking => booking?.awb && booking.status !== 'CANCELLED' && booking.bookingState !== 'CANCELLED');
      if (activeBooking) throw new ApiError('SHIPPING_VALIDATION', `Cancel the ${activeBooking === replacementBooking ? 'replacement shipment' : 'reverse pickup'} with ${activeBooking.courierName || 'the courier'} before cancelling this case.`, { statusCode: 409 });
    }

    if (status === 'Replacement Shipped') {
      const replacement = await withSession(ReplacementShipment.findOne({ returnRequest: request._id }), session);
      if (!replacement?.awb) request.replacementManualReference = requireString(body.replacementTrackingReference, 'replacement tracking reference', { max: 120 });
    }
    if (status === 'Replacement Delivered') {
      const replacement = await withSession(ReplacementShipment.findOne({ returnRequest: request._id }), session);
      if (replacement?.awb && replacement.status !== 'DELIVERED' && body.confirmCarrierDelivery !== true) throw new ApiError('SHIPPING_VALIDATION', 'Refresh replacement tracking and confirm courier delivery before completing this step.', { statusCode: 409 });
      if (!replacement?.awb && !request.replacementManualReference) throw new ApiError('SHIPPING_VALIDATION', 'Add the manual replacement tracking reference before recording delivery.', { statusCode: 409 });
    }

    applyQc(request, body || {}, req);
    if (status === 'Exchange Allocated' && request.type === 'exchange' && !['NOT_REQUIRED', 'SETTLED'].includes(request.financial?.exchangeAdjustmentStatus)) {
      const paymentCollected = order.paymentStatus === 'Paid' || ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(order.paymentState);
      if (!paymentCollected) throw new ApiError('PAYMENT_NOT_COLLECTED', 'Confirm the original order payment before settling an exchange price difference.', { statusCode: 409 });
      if (body?.exchangeAdjustmentSettled !== true) throw new ApiError('VALIDATION_ERROR', 'Settle the exchange price difference before allocating the replacement.');
      const adjustmentReference = requireString(body.exchangeAdjustmentReference, 'exchange adjustment reference', { max: 120 });
      const duplicateAdjustment = (order.exchangeAdjustments || []).some(entry => String(entry.returnRequest) === String(request._id));
      if (!duplicateAdjustment) {
        const difference = Number(request.financial.exchangePriceDifference || 0);
        const amount = Math.abs(difference);
        if (amount > 0) {
          const type = difference > 0 ? 'COLLECTED' : 'CREDITED';
          order.exchangeAdjustments.push({ returnRequest: request._id, type, amount, reference: adjustmentReference, provider: 'manual', processedAt: new Date() });
          order.paymentEvents.push({ state: order.paymentState, status: type === 'COLLECTED' ? 'Exchange difference collected' : 'Exchange credit completed', amount, reference: adjustmentReference, note: `Exchange price difference ${type.toLowerCase()} for ${request.caseNumber || request._id}`, source: actorSource(req), actor: { id: String(req.user._id), name: req.user.name || 'Account' }, date: new Date() });
          if (type === 'COLLECTED') order.exchangeAdjustmentCollected = Number(order.exchangeAdjustmentCollected || 0) + amount;
          else {
            if ((order.refunds || []).some(refund => String(refund.providerRefundId || '') === adjustmentReference)) throw new ApiError('DUPLICATE_REQUEST', 'This exchange credit reference is already recorded.', { statusCode: 409 });
            order.refundedAmount = Math.round((Number(order.refundedAmount || 0) + amount) * 100) / 100;
            const settlementAmount = order.paymentMethod === 'COD' ? Number(order.adjustedFinalAmount ?? order.finalAmount ?? 0) : Number(order.finalAmount || 0);
            order.paymentState = order.refundedAmount >= settlementAmount ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
            if (order.paymentState === 'REFUNDED') order.paymentStatus = 'Refunded';
            order.refunds.push({ providerRefundId: adjustmentReference, paymentId: order.razorpayPaymentId, provider: 'manual', amount, currency: 'INR', status: 'PROCESSED', sourceType: 'EXCHANGE_ADJUSTMENT', sourceId: String(request._id), note: `Exchange credit for ${request.caseNumber || request._id}`, processedAt: new Date() });
          }
        }
      }
      request.financial.exchangeAdjustmentReference = adjustmentReference;
      request.financial.exchangeAdjustmentStatus = 'SETTLED'; request.financial.exchangeAdjustmentSettledAt = new Date();
    }
    if (status === 'Exchange Allocated') await reserveExchange(request, req, session);
    if (status === 'QC Passed') await restoreOriginalIfSellable(request, req, session);
    if (['QC Passed', 'QC Failed'].includes(status)) await recordReturnedNonSellableStock(request, req, session);
    if (['Cancelled', 'QC Failed'].includes(status)) await releaseExchange(request, req, session);
    fullRefund = applyRefund(request, order, body || {}, status, req);

    if (status === 'Pickup Scheduled') request.pickupScheduledAt = request.pickupScheduledAt || new Date();
    if (status === 'Picked Up') request.pickedUpAt = request.pickedUpAt || new Date();
    if (status === 'Received') request.receivedAt = request.receivedAt || new Date();
    if (status === 'Cancelled') request.cancelledAt = request.cancelledAt || new Date();
    const trackedItemIds = order.orderItems.id?.(request.orderItemId)?.uniqueItemIds
      || order.orderItems.find(item => String(item._id) === String(request.orderItemId))?.uniqueItemIds
      || [];
    if (trackedItemIds.length && status === 'Received') {
      await InventoryItem.updateMany(andFilter({ uniqueItemId: { $in: trackedItemIds } }, req.tenantFilter), { $set: { status: 'RETURNED', returnedAt: new Date() } }, session ? { session } : {});
    }
    if (trackedItemIds.length && ['Rejected', 'Cancelled'].includes(status) && !request.receivedAt) {
      await InventoryItem.updateMany(andFilter({ uniqueItemId: { $in: trackedItemIds } }, req.tenantFilter), { $set: { status: 'DELIVERED' }, $unset: { returnedAt: 1 } }, session ? { session } : {});
    }
    if (['Refunded', 'Exchanged'].includes(request.status)) request.resolutionStatus = request.status;
    request.status = status;
    if (['Refunded', 'Exchanged'].includes(status)) request.resolutionStatus = status;
    if (TERMINAL.has(status)) request.completedAt = request.completedAt || new Date();
    if (TERMINAL.has(status)) request.active = false;
    request.slaDueAt = TERMINAL.has(status) ? undefined : new Date(Date.now() + Math.max(1, Number(workflowSettings?.returnSlaHours || 24)) * 60 * 60 * 1000);
    if (Object.prototype.hasOwnProperty.call(body || {}, 'adminComment')) request.adminComment = adminComment;
    if (!Array.isArray(request.statusTimeline)) request.statusTimeline = [];
    request.statusTimeline.push(timelineEntry(req, status, adminComment || body?.qcNotes || `${request.type === 'exchange' ? 'Exchange' : 'Return'} marked ${status}.`));
    request.revision = Number(request.revision || 0) + 1;
    if (status === 'Refunded') await order.save(session ? { session } : {});
    await request.save(session ? { session } : {});

    const requests = await withSession(ReturnExchange.find({ order: request.order }), session);
    order.orderStatus = returnOrderStatus(order, requests);
    order.statusTimeline.push({ status: order.orderStatus, date: new Date(), note: `${request.type === 'exchange' ? 'Exchange' : 'Return'} request marked ${status}` });
    order.revision = Number(order.revision || 0) + 1;
    await order.save(session ? { session } : {});
    return { request, order, changed: true, before };
    });
  } finally {
    await ReturnExchange.updateOne({ _id: id, operation }, { $set: { operation: '' }, $unset: { operationUntil: 1 } }).catch(() => null);
  }
  if (fullRefund) await couponService.releaseCouponForFullyRefundedOrder(result.request.order);
  if (result.changed) {
    await logAudit({ req, action: 'RETURN_STATUS_UPDATE', entityType: 'ReturnExchange', entityId: result.request._id, storeId: result.request.storeId, before: result.before, after: { status: result.request.status, revision: result.request.revision, qc: result.request.qc, financial: result.request.financial }, summary: adminComment || `${result.request.type} marked ${status}` });
    notifyLater({ userId: result.request.user, storeId: result.request.storeId, event: 'RETURN_UPDATED', title: `${result.request.type === 'exchange' ? 'Exchange' : 'Return'} ${status.toLowerCase()}`, message: adminComment || `Your ${result.request.type} request is now ${status}.`, metadata: { returnId: String(result.request._id), orderId: String(result.request.order) } });
  }
  if (status === 'Refund Initiated' && body?.processWithProvider === true) {
    const order = result.order;
    if (result.request.refundMethod !== 'ORIGINAL_PAYMENT' || String(order?.paymentProvider || '').toLowerCase() !== 'razorpay') throw new ApiError('PAYMENT_REFUND_MANUAL_REQUIRED', 'This refund destination must be paid manually and then recorded with its reference.', { statusCode: 409 });
    if (!isRazorpayConfigured() || !order.razorpayPaymentId) throw new ApiError('PAYMENT_PROVIDER_UNAVAILABLE', 'Razorpay refund is not available for this order.', { statusCode: 503 });
    let gateway;
    try {
      gateway = await refundRazorpayPayment({ paymentId: order.razorpayPaymentId, amountInPaise: Math.round(Number(result.request.financial.approvedRefundAmount) * 100), idempotencyKey: `return_${result.request._id}`, notes: { orderId: String(order._id), returnId: String(result.request._id) } });
    } catch (error) {
      await ReturnExchange.updateOne({ _id: result.request._id }, { $set: { 'financial.refundStatus': 'FAILED', 'financial.lastRefundError': String(error.message || 'Refund request failed').slice(0, 500), 'financial.lastRefundAttemptAt': new Date(), 'financial.nextRefundCheckAt': new Date(Date.now() + 15 * 60 * 1000) }, $inc: { 'financial.refundAttemptCount': 1 } });
      throw new ApiError('PAYMENT_PROVIDER_UNAVAILABLE', `Razorpay could not process this refund: ${error.message}`, { statusCode: Number(error.statusCode) || 502 });
    }
    await ReturnExchange.updateOne({ _id: result.request._id }, { $set: { 'financial.lastRefundAttemptAt': new Date(), 'financial.lastRefundError': '', 'financial.nextRefundCheckAt': new Date(Date.now() + 15 * 60 * 1000) }, $inc: { 'financial.refundAttemptCount': 1 } });
    if (String(gateway.status || '').toLowerCase() === 'processed') return applyReturnStatus(req, id, { status: 'Refunded', revision: result.request.revision, refundAmount: result.request.financial.approvedRefundAmount, refundReference: gateway.id, adminComment: 'Refund processed through Razorpay.' });
    await ReturnExchange.updateOne({ _id: result.request._id, status: 'Refund Initiated' }, { $set: { 'financial.refundReference': gateway.id, 'financial.refundStatus': 'INITIATED' } });
    result.request.financial.refundReference = gateway.id;
  }
  return result.request;
}

exports.updateReturnMeta = asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id, 'return id');
  const priority = req.body?.priority === undefined ? undefined : requireEnum(req.body.priority, ['LOW', 'NORMAL', 'HIGH', 'URGENT'], 'priority');
  const tags = req.body?.tags === undefined ? undefined : [...new Set((Array.isArray(req.body.tags) ? req.body.tags : String(req.body.tags).split(',')).map(value => String(value).trim().toLowerCase()).filter(Boolean))].slice(0, 12);
  if (tags?.some(tag => tag.length > 32)) throw new ApiError('VALIDATION_ERROR', 'Each return tag must be 32 characters or fewer.');
  const internalNote = optionalString(req.body?.internalNote, 'internalNote', { max: 1000 });
  const assignment = req.body?.assignment === undefined ? undefined : requireEnum(req.body.assignment, ['ME', 'UNASSIGN'], 'assignment');
  const update = { $inc: { revision: 1 } };
  if (priority !== undefined || tags !== undefined || assignment === 'ME') update.$set = { ...(priority !== undefined ? { priority } : {}), ...(tags !== undefined ? { tags } : {}), ...(assignment === 'ME' ? { assignee: req.user._id } : {}) };
  if (assignment === 'UNASSIGN') update.$unset = { assignee: 1 };
  if (internalNote) update.$push = { internalNotes: { text: internalNote, author: { id: String(req.user._id), name: req.user.name || req.user.phone || 'Staff' }, date: new Date() } };
  if (!update.$set && !update.$unset && !update.$push) throw new ApiError('VALIDATION_ERROR', 'Choose a priority, tags, assignment or add an internal note.');
  const request = await ReturnExchange.findOneAndUpdate(andFilter({ _id: id }, req.tenantFilter), update, { new: true });
  if (!request) throw notFound('Return request not found');
  await logAudit({ req, action: 'RETURN_CASE_META_UPDATE', entityType: 'ReturnExchange', entityId: request._id, storeId: request.storeId, after: { priority: request.priority, tags: request.tags, assignment, internalNoteAdded: Boolean(internalNote) } });
  res.json(publicReturn(await returnQuery(selectQuery(ReturnExchange.findById(request._id), '+refundDestinationEncrypted'), true), req, { detail: true }));
});

exports.prepareExchangeAdjustment = asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id, 'return id');
  let request = await ReturnExchange.findOne(andFilter({ _id: id }, req.tenantFilter));
  if (!request) throw notFound('Exchange request not found');
  if (request.type !== 'exchange' || request.status !== 'QC Passed') throw new ApiError('RETURN_TRANSITION_INVALID', 'Complete return receipt and quality inspection before settling the exchange difference.', { statusCode: 409 });
  const difference = Number(request.financial?.exchangePriceDifference || 0);
  if (!difference || request.financial?.exchangeAdjustmentStatus === 'SETTLED') {
    return res.json(publicReturn(await returnQuery(ReturnExchange.findById(request._id), true), req, { detail: true }));
  }
  if (req.storeMember) {
    const permission = difference < 0 ? 'returns.refund' : 'returns.fulfil';
    if (!roleAllows(req.storeMember.role, permission)) throw forbidden('You do not have permission to settle this exchange difference.');
  }
  if (!isRazorpayConfigured()) throw new ApiError('PAYMENT_PROVIDER_UNAVAILABLE', 'Connect Razorpay before using automatic exchange settlement.', { statusCode: 503 });
  const order = await Order.findOne(andFilter({ _id: request.order }, req.tenantFilter)).populate('user', 'name phone email').select('+paymentEvents');
  if (!order) throw notFound('Order not found');
  const amount = Math.abs(difference);

  if (difference > 0) {
    if (request.financial?.exchangePaymentLinkUrl && request.financial?.exchangePaymentLinkExpiresAt > new Date()) {
      return res.json(publicReturn(await returnQuery(ReturnExchange.findById(request._id), true), req, { detail: true }));
    }
    const expireBy = Math.floor((Date.now() + 7 * 24 * 60 * 60 * 1000) / 1000);
    let link;
    try {
      link = await createRazorpayPaymentLink({
        amountInPaise: Math.round(amount * 100),
        referenceId: `exchange_${request._id}`,
        description: `Exchange price difference for ${request.caseNumber || String(request._id).slice(-8).toUpperCase()}`,
        customer: { name: order.user?.name, email: order.user?.email, contact: order.user?.phone },
        expireBy,
        notes: { returnId: String(request._id), orderId: String(order._id), purpose: 'exchange_adjustment' },
      });
    } catch (error) {
      await ReturnExchange.updateOne({ _id: request._id }, { $set: { 'financial.exchangeAdjustmentLastError': String(error.message || 'Payment link creation failed').slice(0, 500) } });
      throw new ApiError('PAYMENT_PROVIDER_UNAVAILABLE', `Razorpay could not create the payment link: ${error.message}`, { statusCode: Number(error.statusCode) || 502 });
    }
    request = await ReturnExchange.findByIdAndUpdate(request._id, { $set: {
      'financial.exchangeAdjustmentStatus': 'PAYMENT_LINK_CREATED',
      'financial.exchangePaymentLinkId': link.id,
      'financial.exchangePaymentLinkUrl': link.short_url,
      'financial.exchangePaymentLinkExpiresAt': new Date(Number(link.expire_by || expireBy) * 1000),
      'financial.exchangeAdjustmentLastError': '',
    }, $inc: { revision: 1 }, $push: { statusTimeline: timelineEntry(req, 'QC Passed', 'Secure payment link created for the exchange price difference.') } }, { new: true });
    notifyLater({ userId: request.user, storeId: request.storeId, event: 'EXCHANGE_PAYMENT_DUE', title: 'Payment needed for your exchange', message: `Pay Rs. ${amount.toLocaleString('en-IN')} through the secure link in your order details to continue the exchange.`, metadata: { orderId: String(order._id), returnId: String(request._id), paymentLink: link.short_url } });
    await logAudit({ req, action: 'EXCHANGE_PAYMENT_LINK_CREATED', entityType: 'ReturnExchange', entityId: request._id, storeId: request.storeId, after: { amount, paymentLinkId: link.id, expiresAt: request.financial.exchangePaymentLinkExpiresAt } });
  } else {
    if (String(order.paymentProvider || '').toLowerCase() !== 'razorpay' || !order.razorpayPaymentId) throw new ApiError('PAYMENT_REFUND_MANUAL_REQUIRED', 'This exchange credit must be recorded manually because the original payment was not collected through Razorpay.', { statusCode: 409 });
    let gateway;
    try {
      gateway = await refundRazorpayPayment({ paymentId: order.razorpayPaymentId, amountInPaise: Math.round(amount * 100), idempotencyKey: `exchange_credit_${request._id}`, notes: { orderId: String(order._id), returnId: String(request._id), purpose: 'exchange_adjustment' } });
    } catch (error) {
      await ReturnExchange.updateOne({ _id: request._id }, { $set: { 'financial.exchangeAdjustmentStatus': 'FAILED', 'financial.exchangeAdjustmentLastError': String(error.message || 'Exchange credit failed').slice(0, 500) }, $inc: { revision: 1 } });
      throw new ApiError('PAYMENT_PROVIDER_UNAVAILABLE', `Razorpay could not process the exchange credit: ${error.message}`, { statusCode: Number(error.statusCode) || 502 });
    }
    const reference = String(gateway.id || '').trim();
    await ReturnExchange.updateOne({ _id: request._id }, { $set: { 'financial.exchangeAdjustmentStatus': 'CREDIT_PROCESSING', 'financial.exchangeAdjustmentReference': reference, 'financial.exchangeAdjustmentLastError': '', 'financial.nextRefundCheckAt': new Date(Date.now() + 30 * 60 * 1000) }, $inc: { revision: 1 } });
    if (String(gateway.status || '').toLowerCase() === 'processed') {
      await recordProviderRefund({ orderId: order._id, refundId: reference, paymentId: order.razorpayPaymentId, amount, note: 'Exchange price difference credited to customer', sourceType: 'EXCHANGE_ADJUSTMENT', sourceId: request._id });
      ({ request } = await settleExchangeAdjustment(request._id, { type: 'CREDITED', reference, paymentId: order.razorpayPaymentId, source: 'SYSTEM' }));
    } else request = await ReturnExchange.findById(request._id);
    notifyLater({ userId: request.user, storeId: request.storeId, event: 'EXCHANGE_CREDIT_UPDATED', title: 'Exchange price credit updated', message: String(gateway.status || '').toLowerCase() === 'processed' ? `Rs. ${amount.toLocaleString('en-IN')} has been credited for your exchange.` : `Your Rs. ${amount.toLocaleString('en-IN')} exchange credit is being processed.`, metadata: { orderId: String(order._id), returnId: String(request._id), refundId: reference } });
    await logAudit({ req, action: 'EXCHANGE_CREDIT_STARTED', entityType: 'ReturnExchange', entityId: request._id, storeId: request.storeId, after: { amount, refundId: reference, status: request.financial?.exchangeAdjustmentStatus } });
  }
  res.json(publicReturn(await returnQuery(ReturnExchange.findById(request._id), true), req, { detail: true }));
});

exports.retryReturnRefund = asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id, 'return id');
  const request = await ReturnExchange.findOne(andFilter({ _id: id }, req.tenantFilter));
  if (!request) throw notFound('Return request not found');
  requireSideEffectPermission(req, 'Refund Initiated');
  if (request.type !== 'return' || request.status !== 'Refund Initiated' || !['FAILED', 'INITIATED'].includes(request.financial?.refundStatus)) {
    throw new ApiError('RETURN_TRANSITION_INVALID', 'Only an initiated or failed original-payment refund can be retried.', { statusCode: 409 });
  }
  const updated = await applyReturnStatus(req, id, {
    status: 'Refund Initiated', revision: request.revision, processWithProvider: true,
    refundAmount: request.financial?.approvedRefundAmount || request.financial?.estimatedRefundAmount,
    adminComment: optionalString(req.body?.adminComment, 'adminComment', { max: 1000 }) || 'Refund retried with the payment provider.',
  });
  await logAudit({ req, action: 'RETURN_REFUND_RETRY', entityType: 'ReturnExchange', entityId: request._id, storeId: request.storeId, after: { refundStatus: updated.financial?.refundStatus, attemptCount: updated.financial?.refundAttemptCount } });
  res.json(publicReturn(updated, req, { detail: true }));
});

exports.reconcileReturnRefund = asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id, 'return id');
  const request = await ReturnExchange.findOne(andFilter({ _id: id }, req.tenantFilter));
  if (!request) throw notFound('Return request not found');
  requireSideEffectPermission(req, 'Refund Initiated');
  const reference = String(request.financial?.refundReference || '').trim();
  if (request.status !== 'Refund Initiated' || !reference) throw new ApiError('RETURN_TRANSITION_INVALID', 'This return does not have an initiated provider refund to reconcile.', { statusCode: 409 });
  let gateway;
  try { gateway = await fetchRazorpayRefund(reference); }
  catch (error) {
    await ReturnExchange.updateOne({ _id: request._id }, { $set: { 'financial.lastRefundError': String(error.message || 'Refund lookup failed').slice(0, 500), 'financial.nextRefundCheckAt': new Date(Date.now() + 30 * 60 * 1000) } });
    throw new ApiError('PAYMENT_PROVIDER_UNAVAILABLE', `Razorpay refund status could not be checked: ${error.message}`, { statusCode: Number(error.statusCode) || 502 });
  }
  const providerStatus = String(gateway.status || '').toLowerCase();
  if (providerStatus === 'processed') {
    const updated = await applyReturnStatus(req, id, { status: 'Refunded', revision: request.revision, refundAmount: request.financial.approvedRefundAmount, refundReference: reference, adminComment: 'Refund confirmed through provider reconciliation.' });
    return res.json(publicReturn(updated, req, { detail: true }));
  }
  const failed = ['failed', 'rejected'].includes(providerStatus);
  const updated = await ReturnExchange.findByIdAndUpdate(request._id, { $set: { 'financial.refundStatus': failed ? 'FAILED' : 'INITIATED', 'financial.lastRefundError': failed ? `Provider status: ${providerStatus}.` : '', 'financial.nextRefundCheckAt': new Date(Date.now() + 30 * 60 * 1000) } }, { new: true });
  res.json(publicReturn(updated, req, { detail: true }));
});

exports.updateReturnStatus = asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id, 'return id');
  const request = await applyReturnStatus(req, id, req.body || {});
  res.json(publicReturn(request, req, { detail: true }));
});

exports.cancelMyReturn = asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id, 'return id');
  const comment = optionalString(req.body?.comment, 'comment', { max: 500 }) || 'Cancelled by customer before approval.';
  const now = new Date();
  const request = await ReturnExchange.findOneAndUpdate(
    andFilter({ _id: id, user: req.user._id, status: 'Requested' }, req.tenantFilter),
    { $set: { status: 'Cancelled', active: false, cancelledAt: now, completedAt: now, adminComment: comment }, $inc: { revision: 1 }, $push: { statusTimeline: timelineEntry(req, 'Cancelled', comment) } },
    { new: true },
  );
  if (!request) {
    const exists = await ReturnExchange.exists(andFilter({ _id: id, user: req.user._id }, req.tenantFilter));
    if (!exists) throw notFound('Return request not found');
    throw new ApiError('RETURN_TRANSITION_INVALID', 'Only a request awaiting review can be cancelled.', { statusCode: 409 });
  }
  const before = { status: 'Requested', revision: Math.max(0, Number(request.revision || 1) - 1) };
  const order = await Order.findOne(andFilter({ _id: request.order, user: req.user._id }, req.tenantFilter));
  if (order && order.orderStatus !== 'Cancelled') {
    const requests = await ReturnExchange.find({ order: request.order });
    order.orderStatus = returnOrderStatus(order, requests); order.statusTimeline.push({ status: order.orderStatus, date: new Date(), note: 'Customer cancelled a return request' }); order.revision = Number(order.revision || 0) + 1; await order.save();
  }
  await logAudit({ req, action: 'RETURN_CUSTOMER_CANCEL', entityType: 'ReturnExchange', entityId: request._id, storeId: request.storeId, before, after: { status: request.status, revision: request.revision } });
  res.json(publicReturn(request, req, { detail: true }));
});

exports.RETURN_STATUSES = RETURN_STATUSES;
exports.applyReturnStatus = applyReturnStatus;
