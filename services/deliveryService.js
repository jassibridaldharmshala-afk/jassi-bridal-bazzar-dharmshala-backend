const { randomUUID } = require('crypto');
const Order = require('../models/Order');
const Shipment = require('../models/Shipment');
const { ReverseShipment } = Shipment;
const { ReplacementShipment } = Shipment;
const ReturnExchange = require('../models/ReturnExchange');
const { getStoreSettings } = require('./paymentSettingsService');
const { isIntegratedProvider, providerFor, providerLabel } = require('./shippingProvider');
const { packageForItems, deliveryPrice, pickupAddress, pickupSlot } = require('./shippingRules');
const { ApiError } = require('../utils/apiError');
const { notifyLater } = require('./notificationService');

const privateFields = '+pickupAddress +destination +exceptionActions';
const conflict = message => new ApiError('DUPLICATE_REQUEST', message);
const terminal = ['DELIVERED', 'CANCELLED', 'RETURNED'];
const EXCEPTION_ACTIONS = ['CONTACTED_CUSTOMER', 'CONFIRMED_ADDRESS', 'REQUESTED_REDELIVERY', 'REQUESTED_RTO', 'OTHER'];
async function assertCarrierStore(storeId, settings) {
  if (!storeId) return;
  const accountStore = settings.storeId || (await require('../models/Store').findOne({ isDefault: true }).select('_id').lean())?._id;
  if (!accountStore || String(accountStore) !== String(storeId)) throw new ApiError('SHIPPING_UNAVAILABLE', 'This store does not have a connected delivery account.', { statusCode: 503 });
}
function publicShipment(row, { customer = false } = {}) {
  if (!row) return null;
  const data = row.toObject ? row.toObject() : { ...row };
  for (const key of ['labelPdf', 'pickupAddress', 'destination', 'syncLeaseUntil']) delete data[key];
  if (customer) {
    const allowed = new Set(['_id', 'order', 'provider', 'courierName', 'trackingNumber', 'trackingUrl', 'awb', 'status', 'events', 'fulfillmentMode', 'deliveryReference', 'deliveryContact', 'customerNote', 'expectedDeliveryAt', 'environment', 'providerStatus', 'lastSyncedAt', 'manualUpdatedAt', 'createdAt', 'updatedAt']);
    for (const key of Object.keys(data)) if (!allowed.has(key)) delete data[key];
  }
  return data;
}
async function checkoutShipping({ items, settings, address, paymentMethod, amount }) {
  const integrated = isIntegratedProvider(settings.shippingProvider);
  const parcel = integrated || settings.shippingPricingMode === 'weight' ? packageForItems(items, settings) : null;
  if (!integrated) {
    const pricing = deliveryPrice(amount, address, parcel, settings);
    return { provider: 'manual', fulfillmentMode: settings.manualDeliveryMode || 'COURIER', deliveryCharge: pricing.charge, pricingSource: pricing.pricingSource, parcel };
  }
  const adapter = providerFor(settings.shippingProvider), ready = adapter.readiness();
  await assertCarrierStore(items[0]?.storeId, settings);
  if (!ready.configured || !ready.liveBooking || ready.mode !== 'production') throw new ApiError('SHIPPING_UNAVAILABLE', 'Delivery setup is being completed. Please contact the store before placing your order.', { statusCode: 503 });
  const result = await adapter.serviceability({ origin: pickupAddress(settings.shippingPickup), destination: address || {}, cod: paymentMethod === 'COD', parcel, amount });
  const pricing = deliveryPrice(amount, address, parcel, settings, result.providerRate);
  // Contracted carrier cost is an internal merchant value. Checkout only needs
  // the customer-facing charge and the selected service identity.
  const { providerRate: _providerRate, ...publicResult } = result;
  return { ...publicResult, destinationPincode: address.pincode, parcel, deliveryCharge: pricing.charge, pricingSource: pricing.pricingSource };
}
async function withOrderLock(orderId, action) {
  const key = randomUUID();
  const row = await Order.findOneAndUpdate({ _id: orderId, $or: [{ shippingOperation: '' }, { shippingOperation: { $exists: false } }, { shippingOperationUntil: { $lt: new Date() } }] }, { $set: { shippingOperation: key, shippingOperationUntil: new Date(Date.now() + 300000) } }, { new: true });
  if (!row) throw conflict('Another delivery action is in progress. Refresh before trying again.');
  try { return await action(row); }
  finally { await Order.updateOne({ _id: orderId, shippingOperation: key }, { $set: { shippingOperation: '' } }); }
}
function bookingModel(returnRequest, direction = 'reverse') { return returnRequest ? (direction === 'replacement' ? ReplacementShipment : ReverseShipment) : Shipment; }
function bookingFilter(order, returnRequest) { return returnRequest ? { returnRequest: returnRequest._id } : { order: order._id }; }
async function findBooking(order, returnRequest, direction = 'reverse') { return bookingModel(returnRequest, direction).findOne(bookingFilter(order, returnRequest)).select(privateFields); }
async function advanceReturnFromCourier(returnId, status, allowedFrom, note, date = new Date(), extra = {}) {
  if (!returnId) return null;
  const updated = await ReturnExchange.findOneAndUpdate(
    { _id: returnId, status: { $in: allowedFrom } },
    { $set: { status, ...extra }, $inc: { revision: 1 }, $push: { statusTimeline: { status, note, source: 'COURIER', date } } },
    { new: true },
  );
  if (updated) notifyLater({ userId: updated.user, storeId: updated.storeId, event: 'RETURN_UPDATED', title: `${updated.type === 'exchange' ? 'Exchange' : 'Return'} ${status.toLowerCase()}`, message: note, metadata: { returnId: String(updated._id), orderId: String(updated.order) } });
  return updated;
}
function assertBookable(order, returnRequest) {
  if (returnRequest) {
    if (!['Approved', 'Pickup Scheduled'].includes(returnRequest.status)) throw new ApiError('SHIPPING_VALIDATION', 'Approve this return before arranging reverse pickup.');
  } else {
    require('./codVerificationService').assertCodDispatchable(order);
    if (!['Pending', 'Confirmed', 'Packed'].includes(order.orderStatus)) throw new ApiError('SHIPPING_VALIDATION', 'Only an unshipped, active order can be booked.');
    if (order.paymentMethod === 'COD' && order.codConfirmationStatus === 'PENDING') throw new ApiError('SHIPPING_VALIDATION', 'Confirm this COD order with the customer before booking delivery.');
    if (order.paymentMethod !== 'COD' && order.paymentStatus !== 'Paid') throw new ApiError('SHIPPING_VALIDATION', 'Online payment must be confirmed before booking delivery.');
    if (['Failed', 'Refunded'].includes(order.paymentStatus)) throw new ApiError('SHIPPING_VALIDATION', 'This order cannot be shipped with its current payment status.');
  }
}
function replacementItems(order, request) {
  return order.orderItems.filter(item => String(item._id) === request.orderItemId).map(item => ({
    ...(item.toObject ? item.toObject() : item),
    quantity: request.quantity,
    variantId: request.exchangeVariantId || item.variantId,
    size: request.exchangeSize || item.size,
    color: request.exchangeColor || item.color,
    price: Number(request.financial?.exchangeUnitPrice || item.price || 0),
  }));
}
function assertReplacementBookable(request) {
  if (request?.type !== 'exchange') throw new ApiError('SHIPPING_VALIDATION', 'A replacement shipment is available only for an exchange case.');
  if (!['Exchange Allocated', 'Replacement Shipped'].includes(request.status)) throw new ApiError('SHIPPING_VALIDATION', 'Allocate the replacement before creating its delivery.');
  if (!request.exchangeDeducted || request.exchangeReservationReleased) throw new ApiError('SHIPPING_VALIDATION', 'The replacement inventory reservation is not active.');
}
async function createBooking(order, body, returnRequest, direction = 'reverse') {
  return withOrderLock(order._id, async freshOrder => {
    if (returnRequest && direction === 'replacement') assertReplacementBookable(returnRequest);
    else assertBookable(freshOrder, returnRequest);
    const settings = await getStoreSettings(order.storeId ? { storeId: order.storeId } : {});
    if (!isIntegratedProvider(settings.shippingProvider)) throw new ApiError('SHIPPING_VALIDATION', 'Select a connected delivery provider in store settings before booking.');
    const adapter = providerFor(settings.shippingProvider);
    await assertCarrierStore(order.storeId, settings);
    const ready = adapter.readiness();
    if (!ready.liveBooking) throw new ApiError('SHIPPING_UNAVAILABLE', ready.note, { statusCode: 503 });
    const Model = bookingModel(returnRequest, direction), filter = bookingFilter(order, returnRequest);
    let existing = await findBooking(order, returnRequest, direction);
    if (existing?.provider === 'manual' && (existing.manualConfiguredAt || existing.fulfillmentMode === 'SELF')) throw new ApiError('SHIPPING_VALIDATION', 'This order already uses store-managed delivery. Do not create a second courier booking for the same parcel.');
    if (existing?.awb || existing?.bookingState === 'BOOKED') return publicShipment(existing);
    if (existing?.operation || ['BOOKING', 'UNKNOWN', 'CANCELLED'].includes(existing?.bookingState)) throw conflict('This shipment needs reconciliation before another booking. Use Check booking outcome.');
    const slot = pickupSlot(body.date, body.time, body.closeTime);
    const replacement = returnRequest && direction === 'replacement';
    const origin = returnRequest && !replacement ? (returnRequest.pickupAddress || order.shippingAddress) : pickupAddress(settings.shippingPickup);
    const destination = returnRequest && !replacement ? pickupAddress(settings.shippingPickup) : (returnRequest?.pickupAddress || order.shippingAddress);
    const items = replacement ? replacementItems(order, returnRequest) : returnRequest ? order.orderItems.filter(item => String(item._id) === returnRequest.orderItemId).map(item => ({ ...(item.toObject ? item.toObject() : item), quantity: returnRequest.quantity })) : order.orderItems.map(item => ({ ...(item.toObject ? item.toObject() : item), quantity: Math.max(0, Number(item.quantity || 0) - Number(item.cancelledQuantity || 0)) })).filter(item => item.quantity > 0);
    if (!items.length) throw new ApiError('SHIPPING_VALIDATION', 'The return item could not be matched to this order.');
    const parcel = packageForItems(items, settings, body.parcel);
    const payableAmount = Math.max(0, Number(order.adjustedFinalAmount ?? order.finalAmount ?? 0));
    const checked = await adapter.serviceability({ origin, destination, cod: !returnRequest && order.paymentMethod === 'COD' && order.paymentStatus !== 'Paid', reverse: !!returnRequest && !replacement, parcel, amount: replacement ? items.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 0), 0) : payableAmount });
    const providerRef = `${replacement ? 'X' : returnRequest ? 'R' : 'S'}${String(returnRequest?._id || order._id).slice(-19)}`;
    const providerCharge = Number(checked.providerRate);
    const base = { provider: settings.shippingProvider, environment: ready.mode, courierName: checked.courierName || adapter.label || providerLabel(settings.shippingProvider), providerRef, parcel, pickupAddress: origin, destination, service: checked.service, pickup: { areaCode: checked.pickupArea }, status: 'WAITING', bookingState: 'IDLE', ...(Number.isFinite(providerCharge) && providerCharge >= 0 ? { providerCharge } : {}) };
    if (!existing) existing = await Model.findOneAndUpdate(filter, { $setOnInsert: { ...filter, order: order._id, storeId: order.storeId, ...base } }, { upsert: true, new: true, setDefaultsOnInsert: true }).select(privateFields);
    if (returnRequest) await ReturnExchange.updateOne({ _id: returnRequest._id }, { $set: { [replacement ? 'replacementShipment' : 'shipment']: existing._id } });
    else await Order.updateOne({ _id: order._id }, { $set: { shipment: existing._id } });
    const booking = await Model.findOneAndUpdate({ _id: existing._id, $and: [{ $or: [{ bookingState: { $in: ['IDLE', 'FAILED'] } }, { bookingState: { $exists: false } }] }, { $or: [{ operation: '' }, { operation: { $exists: false } }] }] }, { $set: { ...base, bookingState: 'BOOKING', operation: 'book', operationStartedAt: new Date(), lastError: '' } }, { new: true }).select(privateFields);
    if (!booking) throw conflict('This booking is already being processed. Refresh its status.');
    try {
      const carrierOrder = returnRequest
        ? { ...(order.toObject ? order.toObject() : order), orderItems: items, finalAmount: Math.round(items.reduce((sum, item) => sum + Number(item.price) * Number(item.quantity), 0) * 100) / 100 }
        : { ...(order.toObject ? order.toObject() : order), orderItems: items, finalAmount: payableAmount };
      const details = await adapter.book({ booking, order: carrierOrder, slot, reverse: !!returnRequest && !replacement });
      // Persist the AWB independently of pickup so a failed pickup is never rebooked.
      const autoPickup = Boolean(details.pickup?.token);
      Object.assign(booking, details, { trackingNumber: details.awb, bookingState: 'BOOKED', status: autoPickup ? 'PICKUP_SCHEDULED' : 'READY_TO_SHIP', labelAvailable: !!details.labelPdf, operation: '', nextSyncAt: new Date() });
      booking.events.push({ status: booking.status, note: autoPickup ? `${booking.courierName} AWB created and pickup requested.` : `${booking.courierName} AWB created. Pack and label the parcel, then request pickup.`, date: new Date() });
      await booking.save();
      if (returnRequest && !replacement && autoPickup) await advanceReturnFromCourier(returnRequest._id, 'Pickup Scheduled', ['Approved'], `${booking.courierName} confirmed reverse pickup.`, details.pickup?.at || new Date(), { pickupScheduledAt: details.pickup?.at || new Date() });
      return publicShipment(booking);
    } catch (e) {
      const ambiguous = e.ambiguous || !(e instanceof ApiError);
      await Model.updateOne({ _id: booking._id }, { $set: { ...(e.recovery || {}), bookingState: ambiguous ? 'UNKNOWN' : 'FAILED', operation: '', lastError: ambiguous ? `Booking outcome is uncertain at ${booking.courierName}. Check by reference before retrying; do not create a second shipment.` : e.message } });
      throw e instanceof ApiError ? e : conflict('The booking outcome needs reconciliation. Refresh the shipment and check its reference.');
    }
  });
}
async function schedulePickup(order, body, returnRequest, direction = 'reverse') {
  return withOrderLock(order._id, async freshOrder => {
    if (returnRequest && direction === 'replacement') assertReplacementBookable(returnRequest);
    else assertBookable(freshOrder, returnRequest);
    const Model = bookingModel(returnRequest, direction), current = await findBooking(order, returnRequest, direction);
    if (!current || current.bookingState !== 'BOOKED') throw new ApiError('SHIPPING_VALIDATION', 'Create the shipment and download its label before requesting pickup.');
    if (current.pickup?.token && !current.pickup.cancelled) return publicShipment(current);
    if (current.operation) throw conflict('A pickup request is awaiting confirmation. Reconcile it before retrying.');
    if (!['READY_TO_SHIP', 'WAITING'].includes(current.status)) throw new ApiError('SHIPPING_VALIDATION', 'Pickup cannot be requested in this delivery state.');
    const slot = pickupSlot(body.date, body.time, body.closeTime);
    const booking = await Model.findOneAndUpdate({ _id: current._id, operation: '' }, { $set: { operation: 'pickup', operationStartedAt: new Date(), 'pickup.date': slot.date, 'pickup.time': slot.time, 'pickup.closeTime': slot.closeTime } }, { new: true }).select(privateFields);
    if (!booking) throw conflict('Pickup is already being requested.');
    try {
      const result = await providerFor(booking.provider).pickup({ booking, slot, reverse: !!returnRequest && direction !== 'replacement' });
      booking.pickup = { ...booking.pickup.toObject(), ...result, cancelled: false };
      booking.operation = ''; booking.lastError = ''; booking.status = 'PICKUP_SCHEDULED';
      booking.events.push({ status: booking.status, note: `${booking.courierName} confirmed the pickup request.`, date: new Date() });
      await booking.save();
      if (returnRequest && direction !== 'replacement') await advanceReturnFromCourier(returnRequest._id, 'Pickup Scheduled', ['Approved'], `${booking.courierName} confirmed reverse pickup.`, slot.at, { pickupScheduledAt: slot.at });
      return publicShipment(booking);
    } catch (e) {
      const uncertain = e.ambiguous || !(e instanceof ApiError);
      await Model.updateOne({ _id: booking._id }, { $set: { operation: uncertain ? 'pickup-unknown' : '', lastError: uncertain ? `Pickup outcome is uncertain. Confirm the existing request with ${booking.courierName} before retrying.` : e.message } });
      throw e instanceof ApiError ? e : conflict('Pickup needs reconciliation. Do not request another pickup yet.');
    }
  });
}
async function cancelBooking(order, returnRequest, direction = 'reverse') {
  const booking = await findBooking(order, returnRequest, direction);
  if (!booking || booking.provider === 'manual') return null;
  if (booking.bookingState === 'CANCELLED') return publicShipment(booking);
  if (booking.operation || ['UNKNOWN', 'BOOKING'].includes(booking.bookingState)) throw conflict('Check the outstanding courier request before cancelling this order.');
  if (!['WAITING', 'READY_TO_SHIP', 'PICKUP_SCHEDULED', 'FAILED'].includes(booking.status)) throw new ApiError('ORDER_NOT_CANCELLABLE', `This parcel may already be with ${booking.courierName || 'the courier'}. Arrange a return instead of restoring stock through cancellation.`);
  if (booking.awb) {
    booking.operation = 'cancel'; await booking.save();
    try {
      const adapter = providerFor(booking.provider);
      if (booking.pickup?.token && !booking.pickup.cancelled && typeof adapter.cancelPickup === 'function') {
        await adapter.cancelPickup({ booking });
        booking.pickup.cancelled = true; await booking.save();
      }
      await adapter.cancel({ booking });
    } catch (e) {
      booking.operation = e.ambiguous || !(e instanceof ApiError) ? 'cancel-unknown' : '';
      booking.lastError = 'Courier cancellation was not confirmed. The order and inventory have not been cancelled.';
      await booking.save();
      throw e;
    }
  }
  booking.bookingState = 'CANCELLED'; booking.status = 'CANCELLED'; booking.operation = ''; booking.lastError = '';
  booking.events.push({ status: 'CANCELLED', note: 'Courier booking cancelled.', date: new Date() });
  await booking.save();
  return publicShipment(booking);
}
async function recordExceptionAction(order, body, returnRequest, actor, direction = 'reverse') {
  return withOrderLock(order._id, async () => {
    const booking = await findBooking(order, returnRequest, direction);
    if (!booking || !['EXCEPTION', 'FAILED'].includes(booking.status)) throw new ApiError('SHIPPING_VALIDATION', 'This shipment does not currently have an open delivery exception. Refresh tracking first.');
    const action = String(body.action || '').trim().toUpperCase();
    const note = String(body.note || '').trim();
    const reference = String(body.reference || '').trim();
    if (!EXCEPTION_ACTIONS.includes(action)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid delivery exception follow-up.');
    if (note.length < 3 || note.length > 500) throw new ApiError('VALIDATION_ERROR', 'Add a delivery follow-up note between 3 and 500 characters.');
    if (reference.length > 120) throw new ApiError('VALIDATION_ERROR', 'Courier reference must be 120 characters or fewer.');
    const entry = {
      action,
      note,
      reference,
      actor: { id: String(actor?._id || ''), name: String(actor?.name || actor?.phone || 'Staff').slice(0, 100) },
      date: new Date(),
    };
    booking.exceptionActions.push(entry);
    booking.events.push({ status: booking.status, note: `Delivery issue follow-up recorded: ${action.replaceAll('_', ' ').toLowerCase()}.`, date: entry.date });
    await booking.save();
    return publicShipment(booking);
  });
}
async function reconcile(order, body, returnRequest, direction = 'reverse') {
  return withOrderLock(order._id, async () => {
    const booking = await findBooking(order, returnRequest, direction);
    if (!booking || booking.provider === 'manual') throw new ApiError('SHIPPING_VALIDATION', 'There is no integrated courier booking to reconcile.');
    const adapter = providerFor(booking.provider);
    if (['BOOKING', 'UNKNOWN'].includes(booking.bookingState)) {
      if (booking.operationStartedAt && Date.now() - booking.operationStartedAt < 60000) throw conflict('The carrier request may still be running. Check again in a minute.');
      if (body.confirmedWithCarrier === true && body.confirmedNoRequest === true) {
        booking.bookingState = 'FAILED'; booking.operation = ''; booking.lastError = '';
        booking.events.push({ status: 'WAITING', note: `Administrator confirmed with ${booking.courierName || 'the courier'} that no AWB exists for this reference. Booking retry unlocked.`, date: new Date() });
        await booking.save();
        return publicShipment(booking);
      }
      const tracked = await adapter.track({ booking, byReference: true });
      booking.awb = tracked.awb; booking.trackingNumber = tracked.awb; booking.bookingState = 'BOOKED'; booking.operation = ''; booking.lastError = ''; booking.status = tracked.status || 'READY_TO_SHIP';
      booking.events.push({ status: booking.status, note: 'Existing AWB recovered using the booking reference.', date: new Date() });
      await booking.save();
    } else if (booking.operation) {
      // A tracking lookup cannot prove that no pickup/cancellation exists.
      // A carrier tracking lookup cannot prove that no pickup/cancellation exists.
      if (body.confirmedWithCarrier !== true) throw new ApiError('SHIPPING_VALIDATION', `Confirm the existing pickup/cancellation outcome with ${booking.courierName || 'the courier'} before recording the result.`);
      if (booking.operation === 'pickup-unknown' || booking.operation === 'pickup') {
        if (body.confirmedNoRequest === true) booking.status = 'READY_TO_SHIP';
        else {
          if (!/^[A-Za-z0-9._-]{1,100}$/.test(String(body.pickupToken || ''))) throw new ApiError('SHIPPING_VALIDATION', `Enter the pickup token confirmed by ${booking.courierName || 'the courier'}.`);
          booking.pickup.token = String(body.pickupToken); booking.status = 'PICKUP_SCHEDULED';
          if (returnRequest && direction !== 'replacement') await advanceReturnFromCourier(returnRequest._id, 'Pickup Scheduled', ['Approved'], `${booking.courierName || 'Courier'} pickup was confirmed during reconciliation.`, new Date(), { pickupScheduledAt: new Date() });
        }
      } else if (booking.operation.startsWith('cancel')) {
        const checked = await adapter.track({ booking });
        if (checked.status !== 'CANCELLED') throw conflict(`${booking.courierName || 'The courier'} has not confirmed shipment cancellation yet.`);
        booking.status = 'CANCELLED'; booking.bookingState = 'CANCELLED';
      }
      booking.operation = ''; booking.lastError = ''; await booking.save();
    }
    return publicShipment(booking);
  });
}
async function syncBooking(booking, Model = Shipment) {
  if (!booking?.awb || booking.provider === 'manual' || booking.bookingState !== 'BOOKED') return publicShipment(booking);
  const now = new Date();
  const leased = await Model.findOneAndUpdate({ _id: booking._id, $and: [ { $or: [{ lastSyncedAt: { $lt: new Date(Date.now() - 60000) } }, { lastSyncedAt: { $exists: false } }] }, { $or: [{ syncLeaseUntil: { $lt: now } }, { syncLeaseUntil: { $exists: false } }] } ] }, { $set: { syncLeaseUntil: new Date(Date.now() + 90000) } }, { new: true });
  if (!leased) return publicShipment(booking);
  try {
    const tracked = await providerFor(booking.provider).track({ booking: leased });
    const newer = tracked.providerStatusAt && (!leased.providerStatusAt || tracked.providerStatusAt >= leased.providerStatusAt);
    if (newer && !terminal.includes(leased.status)) {
      if (tracked.status) leased.status = tracked.status;
      leased.providerStatus = tracked.providerStatus; leased.providerStatusAt = tracked.providerStatusAt;
    }
    if (tracked.expectedDeliveryAt) leased.expectedDeliveryAt = tracked.expectedDeliveryAt;
    const keys = new Set(leased.events.map(e => `${e.date?.toISOString()}:${e.status}:${e.note}`));
    for (const event of tracked.events) if (!keys.has(`${event.date.toISOString()}:${event.status}:${event.note}`)) leased.events.push(event);
    leased.events = leased.events.sort((a, b) => a.date - b.date).slice(-250);
    leased.lastSyncedAt = now; leased.nextSyncAt = new Date(Date.now() + 15 * 60000); leased.syncLeaseUntil = new Date(0);
    if (!leased.operation) leased.lastError = '';
    await leased.save();
    if (!leased.returnRequest && leased.environment === 'production') {
      const eventDate = tracked.providerStatusAt || now;
      const mapped = { PICKED_UP: 'Shipped', SHIPPED: 'Shipped', IN_TRANSIT: 'Shipped', OUT_FOR_DELIVERY: 'Out for Delivery', DELIVERED: 'Delivered' }[leased.status];
      const prior = mapped && await Order.findOneAndUpdate({ _id: leased.order, orderStatus: { $in: mapped === 'Shipped' ? ['Pending', 'Confirmed', 'Packed'] : mapped === 'Out for Delivery' ? ['Pending', 'Confirmed', 'Packed', 'Shipped'] : ['Pending', 'Confirmed', 'Packed', 'Shipped', 'Out for Delivery'] } }, { $set: { orderStatus: mapped, ...(mapped === 'Delivered' ? { deliveredAt: tracked.providerStatusAt || now } : {}) }, $inc: { revision: 1 }, $push: { statusTimeline: { status: mapped, note: `Confirmed by ${leased.courierName || providerLabel(leased.provider)} tracking`, date: tracked.providerStatusAt || now } } }, { new: false });
      if (prior) notifyLater({ userId: prior.user, storeId: prior.storeId, event: mapped === 'Delivered' ? 'ORDER_DELIVERED' : mapped === 'Out for Delivery' ? 'ORDER_OUT_FOR_DELIVERY' : 'ORDER_SHIPPED', title: `Order ${mapped.toLowerCase()}`, message: `${leased.courierName || providerLabel(leased.provider)}: ${tracked.providerStatus}`, metadata: { orderId: String(prior._id), shipmentId: String(leased._id) } });
      if (leased.status === 'RTO_IN_TRANSIT') {
        const priorRto = await Order.findOneAndUpdate({ _id: leased.order, 'rto.status': { $nin: ['IN_TRANSIT', 'RECEIVED', 'QC_PENDING', 'RESTOCKED', 'QUARANTINED', 'DAMAGED', 'MISSING', 'REFUND_PENDING', 'REFUNDED', 'CLOSED'] } }, { $set: { 'rto.status': 'IN_TRANSIT', 'rto.reason': tracked.providerStatus || 'Courier marked the parcel return to origin.', 'rto.triggeredAt': eventDate }, $inc: { revision: 1 }, $push: { statusTimeline: { status: 'RTO in transit', note: `${leased.courierName || providerLabel(leased.provider)} is returning the parcel to the store.`, date: eventDate } } });
        if (priorRto) notifyLater({ userId: priorRto.user, storeId: priorRto.storeId, event: 'ORDER_DELIVERY_EXCEPTION', title: 'Delivery could not be completed', message: 'The courier is returning this parcel to the store. Payment and refund updates will appear in your order.', metadata: { orderId: String(priorRto._id), shipmentId: String(leased._id) } });
      } else if (leased.status === 'RETURNED') {
        const priorRto = await Order.findOneAndUpdate({ _id: leased.order, 'rto.status': { $in: ['NONE', 'IN_TRANSIT'] } }, { $set: { 'rto.status': 'QC_PENDING', 'rto.receivedAt': eventDate, 'rto.disposition': 'PENDING' }, $inc: { revision: 1 }, $push: { statusTimeline: { status: 'RTO received', note: 'The parcel reached the store and is waiting for inventory inspection.', date: eventDate } } });
        if (priorRto) notifyLater({ userId: priorRto.user, storeId: priorRto.storeId, event: 'ORDER_RTO_RECEIVED', title: 'Parcel returned to store', message: 'The returned parcel is being inspected. Any applicable prepaid refund will be updated here.', metadata: { orderId: String(priorRto._id), shipmentId: String(leased._id) } });
      }
    }
    if (leased.returnRequest && leased.environment === 'production' && Model === ReverseShipment) {
      const carrier = leased.courierName || providerLabel(leased.provider);
      const eventDate = tracked.providerStatusAt || now;
      if (leased.status === 'PICKED_UP') await advanceReturnFromCourier(leased.returnRequest, 'Picked Up', ['Approved', 'Pickup Scheduled'], `${carrier} collected the return parcel.`, eventDate, { pickedUpAt: eventDate });
      else if (['SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY'].includes(leased.status)) await advanceReturnFromCourier(leased.returnRequest, 'In Transit', ['Approved', 'Pickup Scheduled', 'Picked Up'], `${carrier}: ${tracked.providerStatus || 'Return parcel is in transit.'}`, eventDate, { pickedUpAt: eventDate });
      else if (leased.status === 'DELIVERED') await advanceReturnFromCourier(leased.returnRequest, 'Received', ['Approved', 'Pickup Scheduled', 'Picked Up', 'In Transit'], `${carrier} delivered the parcel to the return address. Quality inspection is pending.`, eventDate, { receivedAt: eventDate });
    }
    if (leased.returnRequest && leased.environment === 'production' && Model === ReplacementShipment) {
      const carrier = leased.courierName || providerLabel(leased.provider);
      const eventDate = tracked.providerStatusAt || now;
      if (['PICKED_UP', 'SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY'].includes(leased.status)) await advanceReturnFromCourier(leased.returnRequest, 'Replacement Shipped', ['Exchange Allocated'], `${carrier} collected the replacement parcel.`, eventDate);
      else if (leased.status === 'DELIVERED') await advanceReturnFromCourier(leased.returnRequest, 'Replacement Delivered', ['Exchange Allocated', 'Replacement Shipped'], `${carrier} delivered the replacement parcel.`, eventDate);
    }
    // COD payment, refunds, reverse inspection and inventory are deliberately
    // handled by their existing financial/returns workflows, never scan text.
    return publicShipment(leased);
  } catch (e) {
    await Model.updateOne({ _id: leased._id }, { $set: { nextSyncAt: new Date(Date.now() + 15 * 60000), syncLeaseUntil: new Date(0), lastSyncedAt: now, lastError: 'Latest courier updates are temporarily unavailable. The last confirmed status is shown.' } });
    throw e;
  }
}
let worker;
function startDeliveryWorker() {
  if (worker) return stopDeliveryWorker;
  let active = false;
  const tick = async () => {
    if (active) return; active = true;
    try {
      for (const Model of [Shipment, ReverseShipment, ReplacementShipment]) {
        const due = await Model.find({ provider: { $ne: 'manual' }, bookingState: 'BOOKED', status: { $nin: terminal }, $or: [{ nextSyncAt: { $lte: new Date() } }, { nextSyncAt: { $exists: false } }] }).sort({ nextSyncAt: 1 }).limit(20);
        for (const booking of due) await syncBooking(booking, Model).catch(() => null);
      }
    } catch { /* Disconnected databases are retried on the next tick. */ }
    finally { active = false; }
  };
  worker = setInterval(tick, 60000); worker.unref();
  tick().catch(() => null);
  return stopDeliveryWorker;
}
function stopDeliveryWorker() {
  if (worker) clearInterval(worker);
  worker = null;
}
module.exports = { advanceReturnFromCourier, checkoutShipping, createBooking, schedulePickup, cancelBooking, recordExceptionAction, reconcile, syncBooking, findBooking, publicShipment, withOrderLock, startDeliveryWorker, stopDeliveryWorker, assertBookable };
