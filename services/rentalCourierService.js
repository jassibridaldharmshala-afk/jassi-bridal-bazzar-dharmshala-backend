const M = require('../models/Rental');
const A = require('./rentalAlgorithms');
const { ApiError } = require('../utils/apiError');
const { providerFor, isIntegratedProvider } = require('./shippingProvider');
const { pickupAddress, pickupSlot, packageForItems } = require('./shippingRules');
const { defaultStoreFilter } = require('./storeService');
const fail = message => { throw new ApiError('SHIPPING_VALIDATION', message); };
function present(row) {
  if (!row) return null;
  const value = row.toObject ? row.toObject() : { ...row };
  for (const key of ['labelPdf', 'pickupAddress', 'destination', 'service', 'operationStartedAt']) delete value[key];
  return value;
}
async function list(store, bookingId, userId) {
  await require('./rentalService').getBooking(store, bookingId, null, userId);
  return (await M.Courier.find({ storeId: store._id, bookingId }).lean()).map(present);
}
async function operate(store, bookingId, direction, action, input, actorId) {
  if (!['outbound', 'inbound'].includes(direction) || !['book', 'pickup', 'cancel', 'sync', 'reconcile'].includes(action)) fail('Choose a valid rental courier operation.');
  A.operation(input.operationId);
  if (action === 'reconcile' && !A.text(input.note || '', 1000)) fail('Record the carrier dashboard review before reconciliation.');
  const S = require('./rentalService');
  let carrierOrder;
  const row = await S.transaction(store, async session => {
    const b = await S.getBooking(store, bookingId, session);
    const filter = { storeId: store._id, bookingId: b._id, direction };
    let courier = await M.Courier.findOne(filter).session(session);
    if (courier?.operation) fail('A courier operation is pending. Check its outcome; do not submit it again.');
    if (action === 'book' && courier?.awb && courier.status !== 'CANCELLED') return { replay: true, row: courier.toObject() };
    if (courier?.operationId === input.operationId) return { replay: true, row: courier.toObject() };
    if (b.revision !== input.revision) fail('Booking changed. Reload before arranging its courier.');
    if (courier?.status === 'REVIEW' && !['sync', 'reconcile'].includes(action)) fail('Resolve the uncertain courier operation before requesting another booking, pickup or cancellation.');
    if (courier?.environment && providerFor(courier.provider).readiness().mode !== courier.environment) fail('Carrier environment changed. Restore the original account/environment before managing this parcel.');
    if (action === 'book') {
      const config = await S.readConfiguration(store);
      if (!config.policy.courierIntegrationEnabled || !b.policy.deliveryModes.includes('COURIER') || b.quote.deliveryMode !== 'COURIER') fail('Enable integrated rental couriers and select courier delivery for this booking.');
      if ((direction === 'outbound' && (b.status !== 'READY' || A.finances(b).balancePaise)) || (direction === 'inbound' && b.status !== 'OUT')) fail('Outgoing courier needs a ready, fully-paid booking; return pickup needs an active rental.');
      if (direction === 'outbound') await require('./rentalProofService').ensure(b, 'HANDOVER', b.allocations.map(a => String(a.assetId)), session);
      if (courier && ['REVIEW', 'BOOKING'].includes(courier.status)) fail('Resolve the unknown carrier booking before retrying.');
      const manual = b.logistics?.[direction];
      if (manual?.trackingId && !manual.integrated) fail('Manual tracking already exists for this leg. Do not create a second parcel.');
      const settings = await require('./paymentSettingsService').getStoreSettings(store.isDefault ? defaultStoreFilter(store._id) : { storeId: store._id });
      if (String(settings.storeId || '') !== String(store._id) && !store.isDefault) fail('Connect this store’s own delivery account first.');
      if (!isIntegratedProvider(settings.shippingProvider)) fail('Select a connected courier in Delivery settings.');
      const adapter = providerFor(settings.shippingProvider), ready = adapter.readiness();
      if (!ready.liveBooking || (direction === 'inbound' && !ready.reverse)) fail(ready.note || 'This carrier does not support the requested pickup.');
      const savedAddress = b.bookingDetails?.[direction === 'outbound' ? 'deliveryAddress' : 'collectionAddress'];
      const storeAddress = pickupAddress(settings.shippingPickup), customerAddress = pickupAddress(input.address || savedAddress);
      if (savedAddress && JSON.stringify(customerAddress) !== JSON.stringify(pickupAddress(savedAddress))) fail('Courier address differs from the saved booking address. Update approved booking details before booking this leg.');
      // Carriers receive the landmark as part of the street; do not drop a saved delivery instruction.
      if (savedAddress?.landmark) customerAddress.area = `${customerAddress.area}, ${savedAddress.landmark}`;
      const slot = pickupSlot(input.date, input.time, input.closeTime);
      if (direction === 'outbound' && (+slot.at < +b.schedule.blockedFrom || +slot.at > +b.schedule.pickupAt)) fail('Outgoing courier pickup must fall between preparation start and the agreed customer delivery time.');
      const pieces = b.allocations.filter(a => direction === 'outbound' || (!a.receivedAt && !a.lostAt));
      if (!pieces.length) fail('No physical pieces remain for this courier leg.');
      const declaredValuePaise = A.integer(input.declaredValuePaise, 'declared goods value', 1);
      carrierOrder = { _id: b._id, paymentMethod: 'ONLINE', paymentStatus: 'Paid', finalAmount: declaredValuePaise / 100, orderItems: pieces.map(a => ({ name: a.label, sku: a.code, quantity: 1, price: declaredValuePaise / 100 / pieces.length })) };
      const origin = direction === 'outbound' ? storeAddress : customerAddress, destination = direction === 'outbound' ? customerAddress : storeAddress;
      const parcel = packageForItems(carrierOrder.orderItems, settings, input.parcel);
      // Read-only provider check occurs before any durable booking command.
      const checked = await adapter.serviceability({ origin, destination, reverse: direction === 'inbound', cod: false, parcel, amount: declaredValuePaise / 100 });
      courier ||= new M.Courier(filter);
      Object.assign(courier, { provider: settings.shippingProvider, environment: ready.mode, providerRef: `RN${direction === 'outbound' ? 'O' : 'I'}${String(b._id).slice(-12)}${require('node:crypto').createHash('sha256').update(input.operationId).digest('hex').slice(0, 6)}`, status: 'BOOKING', pickupAddress: origin, destination, parcel, slot, service: checked.service, pickup: { areaCode: checked.pickupArea }, awb: '', providerOrderId: '', providerShipmentId: '', labelPdf: undefined, lastError: '' });
    } else {
      if (!courier) fail('Book or reconcile this courier leg first.');
      if (action === 'reconcile' && input.confirmNotCreated === true) {
        if (!A.text(input.note || '', 1000)) fail('Record how the carrier dashboard was checked.');
        if (courier.awb || !['REVIEW', 'BOOKING'].includes(courier.status)) fail('Only an unconfirmed booking can be marked not created.');
        courier.status = 'FAILED'; courier.operationId = input.operationId; courier.lastError = 'Owner checked the courier dashboard and confirmed that no shipment was created.';
        courier.events.push({ action: 'reconcile-not-created', at: new Date(), actorId, note: A.text(input.note, 1000) });
        await courier.save({ session }); return { replay: true, row: courier.toObject() };
      }
      if (action === 'reconcile' && input.awb) {
        if (!/^[A-Za-z0-9-]{6,50}$/.test(input.awb)) fail('Enter the real carrier-confirmed AWB.');
        if (courier.awb && courier.awb !== input.awb) fail('The confirmed AWB cannot be replaced with another parcel.');
        courier.awb = input.awb;
      }
      if (action === 'reconcile' && ['pickup', 'cancel'].includes(courier.uncertainOperation)) {
        if (!A.text(input.note || '', 1000)) fail('Record the carrier dashboard outcome before reconciliation.');
        if (courier.uncertainOperation === 'pickup' && input.pickupToken) courier.pickup = { ...courier.pickup, token: A.text(input.pickupToken, 120) };
        else if (input.confirmOperationNotApplied !== true && courier.uncertainOperation === 'pickup') fail('Enter the confirmed pickup token or confirm no pickup was created.');
      }
      if (!courier.awb) fail('Check the carrier dashboard and reconcile its confirmed AWB first.');
      if (['CANCELLED', 'DELIVERED', 'RETURNED'].includes(courier.status) && ['pickup', 'cancel'].includes(action)) fail('This courier leg is already closed.');
      if (action === 'pickup') {
        if (['CANCELLED', 'EXPIRED', 'RETURNED', 'CLOSED'].includes(b.status)) fail('This rental is no longer awaiting carrier pickup.');
        if (courier.pickup?.token) return { replay: true, row: courier.toObject() };
        courier.slot = pickupSlot(input.date, input.time, input.closeTime);
        if (direction === 'outbound' && (+courier.slot.at < +b.schedule.blockedFrom || +courier.slot.at > +b.schedule.pickupAt)) fail('Outgoing pickup must respect preparation and the promised delivery time.');
      }
    }
    courier.operationId = input.operationId; courier.operation = action; courier.operationStartedAt = new Date();
    await courier.save({ session }); return { row: courier.toObject() };
  });
  if (row.replay) return present(row.row);
  const courier = row.row, adapter = providerFor(courier.provider), reverse = direction === 'inbound';
  try {
    if (action === 'cancel' && courier.pickup?.token && !courier.pickup.cancelled && typeof adapter.cancelPickup === 'function') {
      await adapter.cancelPickup({ booking: courier });
      await M.Courier.updateOne({ _id: courier._id, operationId: input.operationId, operation: action }, { $set: { 'pickup.cancelled': true } });
    }
    const result = action === 'book' ? await adapter.book({ booking: courier, order: carrierOrder, slot: courier.slot, reverse }) : action === 'pickup' ? await adapter.pickup({ booking: courier, slot: courier.slot, reverse }) : action === 'cancel' ? (await adapter.cancel({ booking: courier, reverse }), {}) : await adapter.track({ booking: courier });
    if (action === 'book' && !result.awb) throw new Error('Carrier did not confirm an AWB.');
    if (['sync', 'reconcile'].includes(action) && result.awb && String(result.awb) !== String(courier.awb)) throw new Error('Carrier tracking does not match this AWB.');
    return S.transaction(store, async session => {
      const current = await M.Courier.findOne({ _id: courier._id, operationId: input.operationId, operation: action }).session(session);
      if (!current) fail('Courier operation changed. Reconcile the carrier before retrying.');
      const oldStatus = current.status, oldProviderStatus = current.providerStatus, oldEta = String(current.expectedDeliveryAt || '');
      if (action === 'book') { Object.assign(current, result); current.status = 'BOOKED'; }
      else if (action === 'pickup') { current.pickup = { ...current.pickup, ...result }; current.status = 'PICKUP_REQUESTED'; }
      else if (action === 'cancel') current.status = 'CANCELLED';
      else {
        current.providerStatus = result.providerStatus; current.expectedDeliveryAt = result.expectedDeliveryAt; current.status = result.status || 'BOOKED';
        if (['pickup', 'cancel'].includes(current.uncertainOperation) && !['CANCELLED', 'DELIVERED', 'RETURNED'].includes(current.status) && (action === 'sync' || (current.uncertainOperation === 'cancel' && input.confirmOperationNotApplied !== true))) current.status = 'REVIEW';
      }
      const changed = action !== 'sync' || oldStatus !== current.status || oldProviderStatus !== current.providerStatus || oldEta !== String(current.expectedDeliveryAt || '');
      if (changed) { current.events.push({ action, status: current.status, at: new Date(), actorId }); current.events = current.events.slice(-200); }
      current.operation = ''; if (current.status !== 'REVIEW') current.uncertainOperation = ''; current.lastError = current.status === 'REVIEW' ? 'Tracking refreshed; uncertain pickup/cancellation still requires owner reconciliation.' : ''; current.lastCheckedAt = new Date(); await current.save({ session });
      if (!changed) return present(current);
      const b = await S.getBooking(store, bookingId, session);
      b.logistics[direction] = { mode: 'COURIER', integrated: true, courierId: current._id, carrier: current.courierName || current.provider, trackingId: current.awb, status: current.status, scheduledAt: current.slot?.at, expectedDeliveryAt: current.expectedDeliveryAt };
      b.events.push({ type: `COURIER_${action.toUpperCase()}`, note: `${direction}: ${current.status}. Physical handover/return still requires the piece checklist.`, actorId, at: new Date() });
      b.revision += 1; await b.save({ session });
      return present(current);
    });
  } catch (error) {
    const definite = action === 'book' && [400, 401, 403, 422].includes(error.statusCode) && !error.ambiguous && !error.recovery;
    await M.Courier.updateOne({ _id: courier._id, operationId: input.operationId, operation: action }, { $set: { operation: '', uncertainOperation: ['sync', 'reconcile'].includes(action) ? courier.uncertainOperation || '' : action, status: definite ? 'FAILED' : 'REVIEW', lastError: 'Carrier outcome needs review. Check the carrier dashboard before retrying.', ...(error.recovery || {}) } });
    throw new ApiError('SHIPPING_UNAVAILABLE', 'Courier outcome needs review. No automatic duplicate booking was attempted. Check the carrier dashboard and reconcile this leg.');
  }
}
async function label(store, bookingId, direction) {
  await require('./rentalService').getBooking(store, bookingId);
  const row = await M.Courier.findOne({ storeId: store._id, bookingId, direction }).select('+labelPdf').lean();
  if (!row?.labelPdf) throw new ApiError('NOT_FOUND', 'Carrier label is not available yet; use the carrier dashboard.');
  const bytes = Buffer.isBuffer(row.labelPdf) ? row.labelPdf : Buffer.from(row.labelPdf.buffer);
  return { mimeType: 'application/pdf', base64: bytes.toString('base64') };
}
async function recoverInterrupted(store) {
  // A crashed/timeout command is never automatically submitted again.
  return M.Courier.updateMany({ storeId: store._id, operation: { $nin: ['', null] }, operationStartedAt: { $lt: new Date(Date.now() - 5 * 60000) } }, [{ $set: { uncertainOperation: { $cond: [{ $in: ['$operation', ['sync', 'reconcile']] }, { $ifNull: ['$uncertainOperation', ''] }, '$operation'] }, operation: '', status: 'REVIEW', lastError: 'Interrupted carrier operation. Check the carrier dashboard and reconcile; no automatic duplicate was submitted.' } }]);
}
async function syncDue(store) {
  const { hasStoreFeature } = require('../config/storePlans');
  const platform = await require('./controlPlaneClient').licenseStatus();
  if (!hasStoreFeature(store, 'shippingAutomation') || (platform.managed && (!['ACTIVE', 'TRIAL'].includes(platform.status) || !platform.features?.includes('shippingAutomation')))) return;
  const rows = await M.Courier.find({ storeId: store._id, awb: { $nin: ['', null] }, operation: { $in: ['', null] }, status: { $nin: ['CANCELLED', 'DELIVERED', 'RETURNED', 'REVIEW', 'FAILED'] }, $or: [{ lastCheckedAt: null }, { lastCheckedAt: { $lt: new Date(Date.now() - 15 * 60000) } }] }).sort({ lastCheckedAt: 1 }).limit(5).lean();
  for (const row of rows) {
    try {
      const booking = await M.Booking.findOne({ _id: row.bookingId, storeId: store._id }).select('revision').lean();
      if (booking) await operate(store, row.bookingId, row.direction, 'sync', { operationId: `track_${require('node:crypto').randomUUID()}`, revision: booking.revision });
    } catch { /* Leave the existing AWB intact; the owner sees the review state. */ }
  }
}
module.exports = { operate, list, label, present, recoverInterrupted, syncDue };
