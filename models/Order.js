const mongoose = require('mongoose');
const storeIdPlugin = require('./plugins/storeId');

/**
 * Explicit payment lifecycle. `paymentStatus` is kept for the existing admin
 * and customer screens; `paymentState` is the machine-readable state used by
 * the payment flow and the Razorpay webhook.
 */
const PAYMENT_STATES = ['PENDING', 'AUTHORIZED', 'PAID', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED'];

const PAYMENT_STATE_TO_STATUS = {
  PENDING: 'Pending',
  AUTHORIZED: 'Pending',
  PAID: 'Paid',
  FAILED: 'Failed',
  REFUNDED: 'Refunded',
  PARTIALLY_REFUNDED: 'Paid',
};

const orderSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  orderItems: [{
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category' },
    categoryName: String,
    name: String,
    productName: String,
    sku: String,
    image: String,
    size: String,
    color: String,
    variantId: String,
    quantity: Number,
    price: Number,
    originalPrice: Number,
    costPrice: { type: Number, min: 0 },
    discount: Number,
    tax: { type: Number, default: 0 },
    shippingWeightKg: Number,
    returnable: { type: Boolean, default: true },
    exchangeable: { type: Boolean, default: true },
    returnWindowDays: Number,
    returnPolicy: String,
    cancelledQuantity: { type: Number, default: 0, min: 0 },
    cancellations: [{
      operationId: { type: String, required: true },
      quantity: { type: Number, min: 1 },
      reasonCode: String,
      comment: String,
      amount: { type: Number, min: 0 },
      reference: String,
      actor: { id: String, name: String, role: String },
      date: { type: Date, default: Date.now },
    }],
    uniqueItemIds: { type: [String], default: [] },
  }],
  shippingAddress: Object,
  shippingQuote: Object,
  shippingOperation: { type: String, default: '', select: false },
  shippingOperationUntil: { type: Date, select: false },
  billingAddress: Object,
  invoiceNumber: String,
  invoiceDate: Date,
  invoiceSeller: { storeName: String, legalBusinessName: String, gstin: String, contactEmail: String, contactPhone: String, whatsappNumber: String, address: String, billingAddress: String, returnPolicy: String, logoUrl: String, invoiceNote: String },
  returnPolicySnapshot: {
    capturedAt: Date,
    returnsEnabled: Boolean,
    returnWindowDays: Number,
    refundDeliveryChargeOnFullReturn: Boolean,
    refundPlatformFeeOnFullReturn: Boolean,
    refundCodChargeOnFullReturn: Boolean,
    customerReturnShippingCharge: { type: Number, min: 0 },
    customerRestockingFeePercent: { type: Number, min: 0, max: 100 },
    rtoRefundDeduction: { type: Number, min: 0 },
  },
  shipment: { type: mongoose.Schema.Types.ObjectId, ref: 'Shipment' },
  deliveredAt: Date,
  deliveryProof: {
    trackingNumber: String,
    courierName: String,
    deliveredAt: Date,
    deliveryOtpVerified: { type: Boolean, default: false },
    source: { type: String, enum: ['MANUAL', 'COURIER', 'SYSTEM'], default: 'SYSTEM' },
  },
  fraudProtectionSnapshot: {
    capturedAt: Date,
    requireProductQrScan: Boolean,
    requirePackingPhotos: Boolean,
    requirePackingVideo: Boolean,
    requireDispatchWeight: Boolean,
    requireSecuritySeal: Boolean,
    enableSecurityTag: Boolean,
    highValueThreshold: Number,
  },
  packageVerification: {
    status: { type: String, enum: ['NOT_REQUIRED', 'PENDING', 'VERIFIED'], default: 'NOT_REQUIRED' },
    sealId: { type: String, trim: true, uppercase: true, maxlength: 80 },
    securityTagId: { type: String, trim: true, uppercase: true, maxlength: 80 },
    dispatchWeightGrams: { type: Number, min: 1, max: 1000000 },
    evidenceCount: { type: Number, default: 0, min: 0 },
    verifiedAt: Date,
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  paymentMethod: { type: String, enum: ['COD', 'UPI', 'CARD', 'Card', 'NETBANKING', 'WALLET', 'Razorpay'], default: 'COD' },
  paymentProvider: { type: String, default: 'COD' },
  paymentStatus: { type: String, enum: ['Pending', 'Paid', 'Failed', 'Refunded'], default: 'Pending' },
  paymentState: { type: String, enum: PAYMENT_STATES, default: 'PENDING' },
  orderStatus: { type: String, enum: ['Pending', 'Confirmed', 'Packed', 'Shipped', 'Out for Delivery', 'Delivered', 'Cancelled', 'Return Requested', 'Exchange Requested', 'Returned', 'Refunded'], default: 'Pending' },
  coupon: Object,
  totalMRP: Number,
  productDiscount: Number,
  couponDiscount: Number,
  discount: Number,
  deliveryCharge: Number,
  codCharge: Number,
  platformFee: { type: Number, default: 0 },
  taxAmount: { type: Number, default: 0 },
  taxRate: { type: Number, default: 0 },
  finalAmount: Number,
  razorpayOrderId: String,
  razorpayPaymentId: String,
  paymentFailureReason: String,
  checkoutAttemptId: { type: String, trim: true, maxlength: 120 },
  checkoutFingerprint: { type: String, maxlength: 64, select: false },
  checkoutCartItems: { type: [{
    cartItemId: String,
    product: mongoose.Schema.Types.ObjectId,
    size: String,
    color: String,
    variantId: String,
    quantity: { type: Number, min: 1 },
  }], select: false },
  cartCleanupStatus: { type: String, enum: ['NOT_REQUIRED', 'PENDING', 'COMPLETE'], default: 'NOT_REQUIRED' },
  cartCleanupAt: Date,
  refundedAmount: { type: Number, default: 0, min: 0 },
  refunds: [{
    providerRefundId: { type: String, maxlength: 120 },
    paymentId: { type: String, maxlength: 120 },
    provider: { type: String, maxlength: 40 },
    amount: { type: Number, min: 0 },
    currency: { type: String, default: 'INR', maxlength: 10 },
    status: { type: String, enum: ['PROCESSED', 'FAILED'], default: 'PROCESSED' },
    note: { type: String, maxlength: 500 },
    processedAt: Date,
    sourceType: { type: String, enum: ['RETURN', 'CANCELLATION', 'ITEM_CANCELLATION', 'EXCHANGE_ADJUSTMENT', 'RTO', 'MANUAL'] },
    sourceId: String,
  }],
  cancellationRefund: {
    status: { type: String, enum: ['NOT_REQUIRED', 'PENDING', 'PROCESSING', 'INITIATED', 'PROCESSED', 'FAILED', 'MANUAL_REQUIRED'], default: 'NOT_REQUIRED' },
    amount: { type: Number, min: 0, default: 0 },
    providerRefundId: String,
    attemptedAt: Date,
    attemptCount: { type: Number, default: 0, min: 0 },
    nextCheckAt: Date,
    processedAt: Date,
    lastError: String,
    operation: { type: String, select: false },
    operationUntil: { type: Date, select: false },
  },
  paymentEvents: { type: [{
    state: String,
    status: String,
    amount: Number,
    reference: String,
    note: String,
    source: String,
    actor: { id: String, name: String },
    date: { type: Date, default: Date.now },
  }], select: false },

  // Idempotency guards. Each side effect is claimed once via a conditional
  // update so retries, duplicate webhooks and double clicks are no-ops.
  inventoryDeducted: { type: Boolean, default: false },
  inventoryDeductedAt: Date,
  inventoryRestored: { type: Boolean, default: false },
  inventoryRestoredAt: Date,
  couponConsumed: { type: Boolean, default: false },
  couponReleased: { type: Boolean, default: false },

  cancellation: {
    cancelledAt: Date,
    cancelledBy: { id: String, name: String, role: String },
    reasonCode: String,
    comment: String,
    source: { type: String, enum: ['CUSTOMER', 'ADMIN', 'SELLER', 'SYSTEM'] },
  },
  cancellationAdjustment: { type: Number, default: 0, min: 0 },
  adjustedFinalAmount: { type: Number, min: 0 },
  itemCancellationRefunds: [{
    operationId: { type: String, required: true },
    orderItemId: String,
    amount: { type: Number, min: 0 },
    status: { type: String, enum: ['NOT_REQUIRED', 'PENDING', 'PROCESSING', 'INITIATED', 'PROCESSED', 'FAILED', 'MANUAL_REQUIRED'], default: 'NOT_REQUIRED' },
    inventoryStatus: { type: String, enum: ['NOT_REQUIRED', 'PENDING', 'PROCESSED', 'FAILED'], default: 'NOT_REQUIRED' },
    providerRefundId: String,
    attemptCount: { type: Number, default: 0 },
    attemptedAt: Date,
    nextCheckAt: Date,
    processedAt: Date,
    lastError: String,
  }],
  exchangeAdjustments: [{
    returnRequest: { type: mongoose.Schema.Types.ObjectId, ref: 'ReturnExchange' },
    type: { type: String, enum: ['COLLECTED', 'CREDITED'], required: true },
    amount: { type: Number, min: 0, required: true },
    reference: { type: String, required: true },
    provider: { type: String, default: 'manual' },
    processedAt: { type: Date, default: Date.now },
  }],
  exchangeAdjustmentCollected: { type: Number, min: 0, default: 0 },
  rto: {
    status: { type: String, enum: ['NONE', 'IN_TRANSIT', 'RECEIVED', 'QC_PENDING', 'RESTOCKED', 'QUARANTINED', 'DAMAGED', 'MISSING', 'REFUND_PENDING', 'REFUNDED', 'CLOSED'], default: 'NONE' },
    reason: String,
    triggeredAt: Date,
    receivedAt: Date,
    inspectedAt: Date,
    disposition: { type: String, enum: ['PENDING', 'RESTOCK', 'QUARANTINE', 'DAMAGED', 'MISSING'], default: 'PENDING' },
    receivedQuantity: { type: Number, min: 0 },
    inventoryRecorded: { type: Boolean, default: false },
    inventoryRecordedAt: Date,
    refundStatus: { type: String, enum: ['NOT_REQUIRED', 'PENDING', 'PROCESSING', 'PROCESSED', 'FAILED', 'MANUAL_REQUIRED'], default: 'NOT_REQUIRED' },
    refundReference: String,
    refundAmount: { type: Number, min: 0 },
    refundDeduction: { type: Number, min: 0, default: 0 },
    refundAttemptCount: { type: Number, default: 0, min: 0 },
    refundAttemptedAt: Date,
    nextRefundCheckAt: Date,
    lastRefundError: String,
    notes: String,
    operation: { type: String, select: false },
    operationUntil: { type: Date, select: false },
  },

  statusTimeline: [{ status: String, date: Date, note: String }],
  adminNotes: String,
  staffNotes: { type: [{
    text: { type: String, maxlength: 1000 },
    author: { id: String, name: String },
    date: { type: Date, default: Date.now },
  }], select: false },
  attribution: {
    source: String,
    campaign: String,
    reelId: String,
    capturedAt: Date,
    expiresAt: Date,
  },
  traffic: {
    visitorId: { type: String, maxlength: 80 },
    sessionId: { type: String, maxlength: 80 },
  },
  prepaidDiscount: { type: Number, default: 0 },
  codConfirmationStatus: { type: String, enum: ['NOT_REQUIRED', 'PENDING', 'CONFIRMED', 'CANCELLED'], default: 'NOT_REQUIRED' },
  codVerification: {
    required: { type: Boolean, default: false },
    status: { type: String, enum: ['NOT_REQUIRED', 'PENDING', 'VERIFIED', 'CANCELLED'], default: 'NOT_REQUIRED' },
    reason: { type: String, enum: ['PREPAID', 'FIRST_COD_ORDER', 'PHONE_NOT_VERIFIED', 'RTO_HISTORY', 'RTO_LIMIT', 'TRUSTED_CUSTOMER', 'STORE_POLICY', 'NOT_REQUIRED'] },
    trustState: { type: String, enum: ['NEW', 'VERIFIED', 'TRUSTED', 'RESTRICTED'] },
    successfulDeliveries: { type: Number, default: 0, min: 0 },
    rtoCount: { type: Number, default: 0, min: 0 },
    phoneLast4: String,
    evaluatedAt: Date,
    sentAt: Date,
    expiresAt: Date,
    verifiedAt: Date,
    deliveryStatus: { type: String, enum: ['NOT_SENT', 'SENT', 'DELIVERED', 'FAILED'], default: 'NOT_SENT' },
    sendCount: { type: Number, default: 0, min: 0 },
    lastDeliveryError: String,
  },
  revision: { type: Number, default: 0, min: 0 },
  ownerAlertQueued: { type: Boolean, default: false, select: false },
}, { timestamps: true });

orderSchema.plugin(storeIdPlugin);

orderSchema.index({ razorpayOrderId: 1 }, { sparse: true });
orderSchema.index({ user: 1, checkoutAttemptId: 1 }, { unique: true, partialFilterExpression: { checkoutAttemptId: { $type: 'string' } }, name: 'one_order_per_checkout_attempt' });
orderSchema.index({ user: 1, paymentStatus: 1, createdAt: -1 });
orderSchema.index({ orderStatus: 1, createdAt: -1 });
orderSchema.index({ createdAt: -1 });
orderSchema.index({ storeId: 1, createdAt: -1 });
orderSchema.index({ storeId: 1, ownerAlertQueued: 1, createdAt: 1 });
orderSchema.index({ storeId: 1, user: 1, createdAt: -1 });
orderSchema.index({ storeId: 1, 'traffic.sessionId': 1, 'traffic.visitorId': 1, createdAt: 1 }, { partialFilterExpression: { 'traffic.sessionId': { $type: 'string' } }, name: 'traffic_verified_order_lookup' });
orderSchema.index({ storeId: 1, orderStatus: 1, createdAt: -1 });
orderSchema.index({ storeId: 1, paymentStatus: 1, createdAt: -1 });
orderSchema.index({ storeId: 1, 'coupon.couponId': 1, createdAt: -1 });
orderSchema.index({ storeId: 1, 'coupon.code': 1, createdAt: -1 });
orderSchema.index({ storeId: 1, 'orderItems.uniqueItemIds': 1 });
orderSchema.index({ invoiceNumber: 1 }, { sparse: true });

module.exports = mongoose.model('Order', orderSchema);
module.exports.PAYMENT_STATES = PAYMENT_STATES;
module.exports.PAYMENT_STATE_TO_STATUS = PAYMENT_STATE_TO_STATUS;
