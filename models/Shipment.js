const mongoose = require('mongoose');
const storeIdPlugin = require('./plugins/storeId');

const SHIPMENT_STATUSES = ['WAITING', 'READY_TO_SHIP', 'PICKUP_SCHEDULED', 'PICKED_UP', 'SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED', 'RTO_IN_TRANSIT', 'RETURNED', 'EXCEPTION', 'FAILED'];

const shipmentSchema = new mongoose.Schema({
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, unique: true },
  courierName: String,
  trackingNumber: String,
  trackingUrl: String,
  awb: String,
  status: { type: String, enum: SHIPMENT_STATUSES, default: 'READY_TO_SHIP' },
  events: [{
    status: String,
    note: String,
    date: { type: Date, default: Date.now },
  }],
  provider: { type: String, default: 'manual' },
  // Manual fulfilment is not a carrier integration. SELF uses an internal
  // delivery reference, never a fabricated courier AWB.
  fulfillmentMode: { type: String, enum: ['COURIER', 'SELF'], default: 'COURIER' },
  deliveryReference: { type: String, maxlength: 80 },
  deliveryContact: { name: { type: String, maxlength: 80 }, phone: { type: String, maxlength: 24 } },
  customerNote: { type: String, maxlength: 300 },
  manualConfiguredAt: Date,
  manualUpdatedAt: Date,
  providerRef: String,
  providerOrderId: String,
  providerShipmentId: String,
  environment: { type: String, enum: ['sandbox', 'production'] },
  returnRequest: { type: mongoose.Schema.Types.ObjectId, ref: 'ReturnExchange' },
  parcel: Object,
  pickupAddress: { type: Object, select: false },
  destination: { type: Object, select: false },
  service: Object,
  pickup: { token: String, date: String, time: String, closeTime: String, areaCode: String, cancelled: Boolean, automatic: Boolean },
  bookingState: { type: String, enum: ['IDLE', 'BOOKING', 'BOOKED', 'UNKNOWN', 'FAILED', 'CANCELLED'], default: 'IDLE' },
  operation: { type: String, default: '' },
  operationStartedAt: Date,
  lastError: String,
  lastSyncedAt: Date,
  nextSyncAt: Date,
  syncLeaseUntil: Date,
  providerStatus: String,
  providerStatusAt: Date,
  expectedDeliveryAt: Date,
  exceptionActions: { type: [{
    action: { type: String, enum: ['CONTACTED_CUSTOMER', 'CONFIRMED_ADDRESS', 'REQUESTED_REDELIVERY', 'REQUESTED_RTO', 'OTHER'] },
    note: { type: String, maxlength: 500 },
    reference: { type: String, maxlength: 120 },
    actor: { id: String, name: String },
    date: { type: Date, default: Date.now },
  }], select: false },
  labelPdf: { type: Buffer, select: false },
  labelAvailable: { type: Boolean, default: false },
  providerCharge: Number,
}, { timestamps: true });

shipmentSchema.plugin(storeIdPlugin);
shipmentSchema.index(
  { storeId: 1, provider: 1, awb: 1 },
  { unique: true, partialFilterExpression: { awb: { $type: 'string', $gt: '' } } },
);
shipmentSchema.index({ storeId: 1, createdAt: -1 });

module.exports = mongoose.model('Shipment', shipmentSchema);
module.exports.SHIPMENT_STATUSES = SHIPMENT_STATUSES;
// Separate collection preserves the existing unique forward-shipment/order index.
const reverseSchema = shipmentSchema.clone();
reverseSchema.remove('order');
reverseSchema.add({ order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true } });
reverseSchema.index({ returnRequest: 1 }, { unique: true });
reverseSchema.index({ provider: 1, nextSyncAt: 1 });
module.exports.ReverseShipment = mongoose.model('ReverseShipment', reverseSchema);
// A replacement is a second forward parcel linked to an exchange case. Keeping
// it in a separate collection avoids weakening the one-forward-shipment rule.
const replacementSchema = shipmentSchema.clone();
replacementSchema.remove('order');
replacementSchema.add({ order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true } });
replacementSchema.index({ returnRequest: 1 }, { unique: true });
replacementSchema.index({ provider: 1, nextSyncAt: 1 });
module.exports.ReplacementShipment = mongoose.model('ReplacementShipment', replacementSchema);
