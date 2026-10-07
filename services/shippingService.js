const Order = require('../models/Order');
const Shipment = require('../models/Shipment');
const { ApiError, notFound } = require('../utils/apiError');
const { notifyLater } = require('./notificationService');
const { optionalString } = require('../utils/validators');
const { supportsTransactions } = require('../utils/transaction');

const editableOrders = ['Confirmed', 'Packed', 'Shipped', 'Out for Delivery'];
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const conflict = message => new ApiError('ORDER_CHANGED', message, { statusCode: 409 });
function deliveryText(value, label, max) {
  if (value !== undefined && value !== null && typeof value !== 'string') throw new ApiError('VALIDATION_ERROR', `${label} must be text.`);
  return optionalString(value, label, { max });
}

async function requireReliableDeliveryWrites() {
  // Do not acknowledge a partly applied delivery/payment/inventory update on
  // a production standalone MongoDB. Atlas/replica sets support transactions.
  if (process.env.NODE_ENV === 'production' && !(await supportsTransactions())) throw new ApiError('SERVICE_UNAVAILABLE', 'Delivery updates require a transaction-capable MongoDB replica set. Please ask the store administrator to check the database setup.');
}

function manualShipmentValues(order, shipment, input = {}, settings = {}) {
  const deliveryEvent = input.deliveryEvent === undefined || input.deliveryEvent === '' ? 'NONE' : input.deliveryEvent;
  const returning = shipment?.status === 'RTO_IN_TRANSIT';
  if (!editableOrders.includes(order.orderStatus)) throw new ApiError('SHIPPING_VALIDATION', 'Delivery details can only be edited on a confirmed, active order. Completed and cancelled deliveries are locked.');
  require('./codVerificationService').assertCodDispatchable(order);
  if (order.paymentMethod === 'COD' && order.codConfirmationStatus === 'PENDING') throw new ApiError('SHIPPING_VALIDATION', 'Confirm this COD order before arranging delivery.');
  if ((order.paymentMethod !== 'COD' && order.paymentStatus !== 'Paid') || ['Failed', 'Refunded'].includes(order.paymentStatus)) throw new ApiError('SHIPPING_VALIDATION', 'Confirm payment before arranging delivery.');
  if (shipment?.provider && shipment.provider !== 'manual') throw new ApiError('SHIPPING_VALIDATION', 'This shipment is managed by an integrated courier and cannot be overwritten manually.');
  if (['CANCELLED', 'RETURNED', 'DELIVERED'].includes(shipment?.status) || (order.rto?.status && !['NONE', 'IN_TRANSIT'].includes(order.rto.status))) throw new ApiError('SHIPPING_VALIDATION', 'This delivery is closed. Use the return/RTO inspection workflow.');
  if (returning && !['NONE', 'NOTE', 'RTO_IN_TRANSIT', 'RETURNED'].includes(deliveryEvent)) throw new ApiError('SHIPPING_VALIDATION', 'This parcel is returning to the store. Confirm receipt when it physically arrives.');
  if (input.status !== undefined && input.status !== (toShipmentStatus(order.orderStatus) || 'READY_TO_SHIP')) throw new ApiError('SHIPPING_VALIDATION', 'Use the order status actions to dispatch or complete a delivery.');

  const previousMode = shipment?.fulfillmentMode || 'COURIER';
  const fulfillmentMode = input.fulfillmentMode === undefined
    ? (shipment ? previousMode : order.shippingQuote?.fulfillmentMode || settings.manualDeliveryMode || 'COURIER')
    : input.fulfillmentMode;
  if (!['COURIER', 'SELF'].includes(fulfillmentMode)) throw new ApiError('VALIDATION_ERROR', 'Choose manual courier or self delivery.');
  const text = (key, max) => input[key] === undefined ? String(shipment?.[key] || '') : deliveryText(input[key], key, max);
  const courierName = fulfillmentMode === 'SELF' ? '' : text('courierName', 80);
  if (input.awb && input.trackingNumber && String(input.awb).trim() !== String(input.trackingNumber).trim()) throw new ApiError('VALIDATION_ERROR', 'AWB and tracking number must refer to the same parcel.');
  const trackingNumber = fulfillmentMode === 'SELF' ? ''
    : has(input, 'trackingNumber') ? text('trackingNumber', 80)
      : has(input, 'awb') ? deliveryText(input.awb, 'AWB', 80) : String(shipment?.trackingNumber || shipment?.awb || '');
  if (trackingNumber && !courierName) throw new ApiError('VALIDATION_ERROR', 'Enter the courier name for this tracking number.');
  if (/[\u0000-\u001f\u007f]/.test(trackingNumber)) throw new ApiError('VALIDATION_ERROR', 'Enter a valid tracking number.');
  let trackingUrl = fulfillmentMode === 'SELF' ? '' : text('trackingUrl', 500);
  if (trackingUrl) {
    let url;
    try { url = new URL(trackingUrl); } catch { throw new ApiError('VALIDATION_ERROR', 'Enter a valid tracking URL.'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new ApiError('VALIDATION_ERROR', 'Tracking links must use a secure HTTPS URL without embedded credentials.');
    if (!trackingNumber) throw new ApiError('VALIDATION_ERROR', 'Add the tracking number before its tracking link.');
    trackingUrl = url.href;
  }
  const dispatched = ['Shipped', 'Out for Delivery'].includes(order.orderStatus);
  if (dispatched && (fulfillmentMode !== previousMode || courierName !== String(shipment?.courierName || '') || trackingNumber !== String(shipment?.trackingNumber || shipment?.awb || ''))) {
    throw new ApiError('SHIPPING_VALIDATION', 'Delivery method, courier and tracking identity are locked after dispatch. Contact support for a parcel correction.');
  }
  let expectedDeliveryAt = shipment?.expectedDeliveryAt || null;
  if (has(input, 'expectedDeliveryAt')) {
    if (input.expectedDeliveryAt === '' || input.expectedDeliveryAt === null) expectedDeliveryAt = null;
    else {
      const day = input.expectedDeliveryAt;
      if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new ApiError('VALIDATION_ERROR', 'Expected delivery must be a valid date (YYYY-MM-DD).');
      expectedDeliveryAt = new Date(`${day}T00:00:00.000Z`);
      if (!Number.isFinite(expectedDeliveryAt.getTime()) || expectedDeliveryAt.toISOString().slice(0, 10) !== day) throw new ApiError('VALIDATION_ERROR', 'Expected delivery must be a real calendar date.');
    }
  }
  let deliveryContact = { name: shipment?.deliveryContact?.name || '', phone: shipment?.deliveryContact?.phone || '' };
  if (has(input, 'deliveryContact')) {
    const contact = input.deliveryContact;
    if (!contact || typeof contact !== 'object' || Array.isArray(contact) || Object.keys(contact).some(key => !['name', 'phone'].includes(key))) throw new ApiError('VALIDATION_ERROR', 'Enter a delivery contact name and phone.');
    deliveryContact = { name: deliveryText(contact.name, 'Delivery contact name', 80), phone: deliveryText(contact.phone, 'Delivery contact phone', 24) };
    if (deliveryContact.phone && !/^\+?[1-9]\d{9,14}$/.test(deliveryContact.phone.replace(/[\s()-]/g, ''))) throw new ApiError('VALIDATION_ERROR', 'Delivery contact phone must contain 10 to 15 digits, with an optional leading country-code +.');
    if (deliveryContact.phone && !deliveryContact.name) throw new ApiError('VALIDATION_ERROR', 'Enter the name of the customer-visible delivery contact.');
  }
  const customerNote = text('customerNote', 300);
  if (!['NONE', 'NOTE', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'EXCEPTION', 'RTO_IN_TRANSIT', 'RETURNED'].includes(deliveryEvent)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid delivery update.');
  if (deliveryEvent !== 'NONE' && !dispatched) throw new ApiError('SHIPPING_VALIDATION', 'Dispatch the order before recording delivery progress.');
  if (['NOTE', 'EXCEPTION', 'RTO_IN_TRANSIT', 'RETURNED'].includes(deliveryEvent) && !customerNote) throw new ApiError('VALIDATION_ERROR', 'Add a customer-visible note explaining this delivery update.');
  if ((deliveryEvent === 'IN_TRANSIT' && order.orderStatus !== 'Shipped') || (deliveryEvent === 'OUT_FOR_DELIVERY' && order.orderStatus !== 'Out for Delivery')) throw new ApiError('SHIPPING_VALIDATION', 'Advance the order status before recording this delivery update.');
  if (deliveryEvent === 'RETURNED' && (!returning || input.confirmReturned !== true)) throw new ApiError('SHIPPING_VALIDATION', 'Mark the parcel returning first, then confirm it has physically arrived back at the store.');
  if (returning && (trackingUrl !== String(shipment.trackingUrl || '') || String(expectedDeliveryAt?.toISOString() || '') !== String(shipment.expectedDeliveryAt?.toISOString() || '') || deliveryContact.name !== (shipment.deliveryContact?.name || '') || deliveryContact.phone.replace(/[\s()-]/g, '') !== (shipment.deliveryContact?.phone || '').replace(/[\s()-]/g, ''))) throw new ApiError('SHIPPING_VALIDATION', 'Delivery details are locked while the parcel returns to the store. Only its customer update and receipt confirmation can change.');
  return {
    fulfillmentMode, courierName, trackingNumber, awb: trackingNumber, trackingUrl, expectedDeliveryAt, deliveryContact, customerNote,
    deliveryReference: fulfillmentMode === 'SELF' ? shipment?.deliveryReference || `DLV-${String(order._id).toUpperCase()}` : '',
    status: ['IN_TRANSIT', 'OUT_FOR_DELIVERY', 'EXCEPTION', 'RTO_IN_TRANSIT', 'RETURNED'].includes(deliveryEvent) ? deliveryEvent : shipment?.status || toShipmentStatus(order.orderStatus) || 'READY_TO_SHIP',
  };
}

// Called under delivery.withOrderLock; the order revision serializes this
// metadata edit with every other administrative order change.
async function saveManualShipment(order, input, { session, expectedRevision, settings } = {}) {
  const existing = await Shipment.findOne({ order: order._id }).session(session || null);
  const values = manualShipmentValues(order, existing, input, settings);
  const clean = value => JSON.stringify(value?.toObject ? value.toObject() : value ?? null);
  const changed = !existing || !existing.manualConfiguredAt || Object.keys(values).some(key => clean(existing[key]) !== clean(values[key]));
  if (!changed) return { shipment: existing, revision: Number(order.revision || 0), changed: false };
  const shipment = existing || new Shipment({ order: order._id, storeId: order.storeId || undefined, provider: 'manual' });
  const now = new Date();
  Object.assign(shipment, values, { manualConfiguredAt: shipment.manualConfiguredAt || now, manualUpdatedAt: now });
  const eventNote = values.customerNote || (input.deliveryEvent === 'IN_TRANSIT' ? 'The store reports your parcel is in transit.' : input.deliveryEvent === 'OUT_FOR_DELIVERY' ? 'The store reports another delivery attempt is under way.' : 'Delivery details updated by the store.');
  shipment.events.push({ status: values.status, note: eventNote, date: now });
  await shipment.validate();
  const revision = Number(expectedRevision ?? order.revision ?? 0);
  const filter = { _id: order._id, orderStatus: order.orderStatus, ...(revision === 0 ? { $or: [{ revision: 0 }, { revision: { $exists: false } }] } : { revision }) };
  const update = { $set: { shipment: shipment._id }, $inc: { revision: 1 } };
  if (values.status === 'RTO_IN_TRANSIT' && (!order.rto?.status || order.rto.status === 'NONE')) {
    Object.assign(update.$set, { 'rto.status': 'IN_TRANSIT', 'rto.reason': values.customerNote, 'rto.triggeredAt': now });
    update.$push = { statusTimeline: { status: 'RTO in transit', note: 'The store reports this undelivered parcel is returning to the store.', date: now } };
  } else if (values.status === 'RETURNED') {
    Object.assign(update.$set, { 'rto.status': 'QC_PENDING', 'rto.receivedAt': now, 'rto.disposition': 'PENDING' });
    update.$push = { statusTimeline: { status: 'RTO received', note: 'The store confirmed receipt. Inventory inspection is pending.', date: now } };
  }
  const updated = await Order.findOneAndUpdate(filter, update, { new: true, session });
  if (!updated) throw conflict('This order changed in another session. Reload it before editing delivery.');
  try { await shipment.save({ session }); }
  catch (error) {
    // Atlas rolls back both writes. Preserve the previous link/revision when
    // running against a standalone local MongoDB without transactions.
    if (!session) await Order.updateOne({ _id: order._id, revision: revision + 1 }, { $set: { shipment: order.shipment || null, ...(update.$push ? { rto: order.rto || {}, statusTimeline: order.statusTimeline || [] } : {}) }, $inc: { revision: -1 } });
    if (error.code === 11000) throw new ApiError('VALIDATION_ERROR', 'This tracking number is already assigned to another order in this store.');
    throw error;
  }
  return { shipment, revision: Number(updated.revision), changed: true };
}

function toShipmentStatus(orderStatus) {
  if (orderStatus === 'Packed') return 'READY_TO_SHIP';
  if (orderStatus === 'Shipped') return 'SHIPPED';
  if (orderStatus === 'Out for Delivery') return 'OUT_FOR_DELIVERY';
  if (orderStatus === 'Delivered') return 'DELIVERED';
  return null;
}

async function upsertShipmentForOrder(order, { status, note } = {}, { session, notify = true } = {}) {
  if (!order) throw notFound('Order not found');
  require('./codVerificationService').assertCodDispatchable(order);
  if (order.paymentMethod === 'COD' && order.codConfirmationStatus === 'PENDING') throw new ApiError('VALIDATION_ERROR', 'Confirm this cash-on-delivery order with the customer before arranging shipment.');

  const nextStatus = status || toShipmentStatus(order.orderStatus) || 'READY_TO_SHIP';
  let shipment = await Shipment.findOne({ order: order._id }).session(session || null);

  if (shipment?.provider && shipment.provider !== 'manual') throw new ApiError('SHIPPING_VALIDATION', `This shipment is managed by ${shipment.courierName || 'an integrated courier'}. Use courier booking, pickup and tracking actions.`);
  if (!Shipment.SHIPMENT_STATUSES.includes(nextStatus)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid shipment status.');
  if (!shipment) {
    shipment = new Shipment({
      order: order._id,
      storeId: order.storeId || undefined,
      provider: 'manual',
      events: [{ status: nextStatus, note: note || 'Shipment created', date: new Date() }],
      fulfillmentMode: order.shippingQuote?.fulfillmentMode || 'COURIER',
      status: nextStatus,
    });
    await shipment.save({ session });
    order.shipment = shipment._id;
    await order.save({ session });
  } else {
    if (shipment.status === nextStatus) return shipment;
    shipment.status = nextStatus;
    if (!shipment.storeId && order.storeId) shipment.storeId = order.storeId;
    shipment.events.push({ status: nextStatus, note: note || `Status set to ${nextStatus}`, date: new Date() });
    await shipment.save({ session });
  }

  if (notify && ['SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY'].includes(nextStatus)) {
    notifyLater({
      userId: order.user,
      storeId: order.storeId,
      event: nextStatus === 'OUT_FOR_DELIVERY' ? 'ORDER_OUT_FOR_DELIVERY' : 'ORDER_SHIPPED',
      title: nextStatus === 'OUT_FOR_DELIVERY' ? 'Out for delivery' : 'Your order is on the way',
      message: shipment.trackingNumber
        ? `Tracking ${shipment.trackingNumber}${shipment.courierName ? ` via ${shipment.courierName}` : ''}`
        : nextStatus === 'OUT_FOR_DELIVERY' ? 'Your order is out for delivery.' : 'Your order is on the way.',
      metadata: { orderId: String(order._id), shipmentId: String(shipment._id) },
    });
  }

  return shipment;
}

async function getShipmentForOrder(orderId) {
  const order = await Order.findById(orderId).select('shipment');
  if (!order) throw new ApiError('NOT_FOUND', 'Order not found');
  if (order.shipment) return Shipment.findById(order.shipment);
  return Shipment.findOne({ order: orderId });
}

async function closeManualShipmentForOrder(order, { session } = {}) {
  return Shipment.updateOne({ order: order._id, provider: 'manual', status: { $ne: 'CANCELLED' } }, {
    $set: { status: 'CANCELLED', bookingState: 'CANCELLED', manualUpdatedAt: new Date() },
    $push: { events: { status: 'CANCELLED', note: 'The order was cancelled before dispatch.', date: new Date() } },
  }, { session });
}

module.exports = {
  manualShipmentValues,
  saveManualShipment,
  requireReliableDeliveryWrites,
  closeManualShipmentForOrder,
  getShipmentForOrder,
  toShipmentStatus,
  upsertShipmentForOrder,
};
