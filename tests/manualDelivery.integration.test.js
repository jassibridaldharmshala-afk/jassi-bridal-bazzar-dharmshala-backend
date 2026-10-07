const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createAdmin, createCustomer, createProduct, setSettings, validAddress } = require('./factories');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Shipment = require('../models/Shipment');
const InventoryItem = require('../models/InventoryItem');
const InventoryTransaction = require('../models/InventoryTransaction');
const { returnEligibility } = require('../services/returnEligibilityService');

test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(async () => {
  await resetDatabase();
  await setSettings({ shippingProvider: 'manual', smartCodVerificationEnabled: false });
});

const nextDate = () => new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
const pathFor = (id, action) => `/api/admin/orders/${id}/${action}`;
const reject = (result, label) => assert.ok([400, 403, 409, 422].includes(result.status), `${label}: ${result.status} ${JSON.stringify(result.data)}`);

async function revision(id) {
  return Number((await Order.findById(id).select('revision')).revision || 0);
}

async function setStatus(fixture, orderStatus, extra = {}) {
  return request(pathFor(fixture.id, 'status'), {
    method: 'PUT', token: fixture.admin.token,
    body: { orderStatus, revision: await revision(fixture.id), ...extra },
  });
}

async function metadata(fixture, fields, extra = {}) {
  return request(pathFor(fixture.id, 'shipment'), {
    method: 'PUT', token: fixture.admin.token,
    body: { revision: await revision(fixture.id), ...fields, ...extra },
  });
}

async function createOrder({ confirmed = true } = {}) {
  const customer = await createCustomer();
  const admin = await createAdmin();
  const product = await createProduct({ stock: 5 });
  const placed = await request('/api/orders/cod', {
    method: 'POST', token: customer.token,
    body: {
      orderItems: [{ product: String(product._id), quantity: 1, size: 'M', color: 'Red' }],
      paymentMethod: 'COD', shippingAddress: validAddress({ mobile: customer.user.phone }),
    },
  });
  assert.equal(placed.status, 201, JSON.stringify(placed.data));
  const fixture = { id: placed.data._id, customer, admin, product };
  if (confirmed) {
    const result = await setStatus(fixture, 'Confirmed');
    assert.equal(result.status, 200, JSON.stringify(result.data));
  }
  return fixture;
}

async function savedShipment(id) {
  return Shipment.findOne({ order: id });
}

test('self delivery completes the real order lifecycle without fabricated courier AWB or automatic COD collection', async () => {
  const fixture = await createOrder();
  const beforeRevision = await revision(fixture.id);
  const saved = await metadata(fixture, {
    fulfillmentMode: 'SELF', expectedDeliveryAt: nextDate(),
    deliveryContact: { name: 'Store delivery team', phone: '9876543210' },
    customerNote: 'Our store team will call before arrival.',
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  let shipment = await savedShipment(fixture.id);
  assert.equal(shipment.provider, 'manual');
  assert.equal(shipment.fulfillmentMode, 'SELF');
  assert.ok(shipment.deliveryReference, 'self delivery needs a separate internal reference');
  assert.ok(!shipment.awb && !shipment.trackingNumber, 'an internal reference is not a courier AWB');
  assert.equal(await revision(fixture.id), beforeRevision + 1);
  const initialReference = shipment.deliveryReference;
  await InventoryItem.create({
    product: fixture.product._id, order: fixture.id, uniqueItemId: 'SELF-DELIVERY-ITEM-1',
    storeId: shipment.storeId, status: 'PACKED',
  });

  for (const [orderStatus, shipmentStatus] of [
    ['Packed', 'READY_TO_SHIP'], ['Shipped', 'SHIPPED'],
    ['Out for Delivery', 'OUT_FOR_DELIVERY'], ['Delivered', 'DELIVERED'],
  ]) {
    const moved = await setStatus(fixture, orderStatus, { deliveryOtpVerified: true });
    assert.equal(moved.status, 200, `${orderStatus}: ${JSON.stringify(moved.data)}`);
    shipment = await savedShipment(fixture.id);
    assert.equal(shipment.status, shipmentStatus);
    assert.equal(shipment.deliveryReference, initialReference);
  }

  const delivered = await Order.findById(fixture.id);
  assert.equal(delivered.paymentStatus, 'Pending', 'COD collection must be explicitly recorded');
  assert.equal(delivered.deliveryProof.deliveryOtpVerified, false, 'a request flag is not verified delivery OTP proof');
  assert.ok(delivered.deliveredAt);
  assert.equal(returnEligibility(delivered, [], 7).items[0].canRequest, true);
  assert.equal((await InventoryItem.findOne({ order: fixture.id })).status, 'DELIVERED');
  assert.equal((await Product.findById(fixture.product._id)).stock, 4);
  assert.equal(await InventoryTransaction.countDocuments({ order: fixture.id, type: 'CANCELLATION' }), 0);

  const customerView = await request(`/api/orders/${fixture.id}/delivery?refresh=1`, { token: fixture.customer.token });
  assert.equal(customerView.status, 200, JSON.stringify(customerView.data));
  assert.equal(customerView.data.shipment.status, 'DELIVERED');
  assert.equal(customerView.data.shipment.deliveryReference, initialReference);
  assert.equal(customerView.data.shipment.customerNote, 'Our store team will call before arrival.');

  const repeated = await setStatus(fixture, 'Delivered');
  assert.equal(repeated.status, 200, JSON.stringify(repeated.data));
  const afterRepeated = await Order.findById(fixture.id);
  assert.equal(afterRepeated.deliveredAt.getTime(), delivered.deliveredAt.getTime());
  assert.equal(afterRepeated.statusTimeline.filter(entry => entry.status === 'Delivered').length, 1);
  reject(await metadata(fixture, { customerNote: 'Rewriting a completed delivery' }), 'completed delivery metadata');
});

test('manual courier needs real dispatch details and retains customer tracking while identity is locked after dispatch', async () => {
  const fixture = await createOrder();
  assert.equal((await setStatus(fixture, 'Packed')).status, 200);
  reject(await setStatus(fixture, 'Shipped'), 'dispatch without tracking details');
  const saved = await metadata(fixture, {
    fulfillmentMode: 'COURIER', courierName: 'Local Express', trackingNumber: 'LOCAL-REAL-001',
    trackingUrl: 'https://courier.example/track/LOCAL-REAL-001', expectedDeliveryAt: nextDate(),
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  let shipment = await savedShipment(fixture.id);
  assert.equal(shipment.trackingNumber, 'LOCAL-REAL-001');
  assert.equal(shipment.awb, 'LOCAL-REAL-001');
  assert.equal((await setStatus(fixture, 'Shipped')).status, 200);

  for (const fields of [{ fulfillmentMode: 'SELF' }, { courierName: 'Another courier' }, { trackingNumber: 'DIFFERENT-AWB' }]) {
    reject(await metadata(fixture, fields), 'dispatch identity change');
  }
  const edited = await metadata(fixture, {
    trackingUrl: 'https://courier.example/new-tracking/LOCAL-REAL-001',
    expectedDeliveryAt: nextDate(), customerNote: 'Delivery will be attempted in the evening.',
    deliveryContact: { name: 'Courier desk', phone: '9876543210' },
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  const view = await request(`/api/orders/${fixture.id}`, { token: fixture.customer.token });
  assert.equal(view.status, 200, JSON.stringify(view.data));
  assert.equal(view.data.shipment.trackingUrl, 'https://courier.example/new-tracking/LOCAL-REAL-001');
  assert.equal(view.data.shipment.customerNote, 'Delivery will be attempted in the evening.');

  const cleared = await metadata(fixture, { trackingUrl: '', expectedDeliveryAt: '' });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.data));
  shipment = await savedShipment(fixture.id);
  assert.ok(!shipment.trackingUrl && !shipment.expectedDeliveryAt, 'optional link and ETA can be removed');
  assert.equal(shipment.trackingNumber, 'LOCAL-REAL-001');
  assert.equal(shipment.status, 'SHIPPED');
});

test('shipment metadata cannot skip the order lifecycle or restore inventory', async () => {
  const fixture = await createOrder();
  for (const status of ['DELIVERED', 'RETURNED', 'CANCELLED', 'SHIPPED']) {
    reject(await metadata(fixture, { fulfillmentMode: 'SELF', status }), `metadata status ${status}`);
  }
  const unchanged = await Order.findById(fixture.id);
  assert.equal(unchanged.orderStatus, 'Confirmed');
  assert.equal(unchanged.deliveredAt, undefined);
  assert.equal((await Product.findById(fixture.product._id)).stock, 4);
  assert.equal(await InventoryTransaction.countDocuments({ order: fixture.id, type: 'CANCELLATION' }), 0);
  reject(await setStatus(fixture, 'Delivered'), 'skip directly to delivery');
});

test('metadata updates require current revisions and serialize conflicting edits', async () => {
  const fixture = await createOrder();
  const staleRevision = await revision(fixture.id);
  assert.equal((await metadata(fixture, { fulfillmentMode: 'SELF', customerNote: 'Initial message' })).status, 200);
  const stale = await metadata(fixture, { customerNote: 'Stale message' }, { revision: staleRevision });
  assert.equal(stale.status, 409, JSON.stringify(stale.data));
  assert.equal(stale.data.code, 'ORDER_CHANGED');
  const currentRevision = await revision(fixture.id);
  const outcomes = await Promise.all(['First editor', 'Second editor'].map(customerNote =>
    request(pathFor(fixture.id, 'shipment'), {
      method: 'PUT', token: fixture.admin.token, body: { revision: currentRevision, customerNote },
    })));
  assert.equal(outcomes.filter(result => result.status === 200).length, 1, JSON.stringify(outcomes));
  assert.equal(outcomes.filter(result => result.status === 409).length, 1, JSON.stringify(outcomes));
  assert.equal(await revision(fixture.id), currentRevision + 1);
  assert.ok(['First editor', 'Second editor'].includes((await savedShipment(fixture.id)).customerNote));
});

test('unpaid online orders, pending COD verification, and unconfirmed COD cannot acquire delivery metadata', async () => {
  const fixture = await createOrder();
  await Order.updateOne({ _id: fixture.id }, { $set: { paymentMethod: 'UPI', paymentStatus: 'Pending' } });
  reject(await metadata(fixture, { fulfillmentMode: 'SELF' }), 'unpaid online payment');
  await Order.updateOne({ _id: fixture.id }, { $set: { paymentMethod: 'COD', codConfirmationStatus: 'PENDING' } });
  reject(await metadata(fixture, { fulfillmentMode: 'SELF' }), 'unconfirmed COD');
  await Order.updateOne({ _id: fixture.id }, { $set: { codConfirmationStatus: 'CONFIRMED', 'codVerification.required': true, 'codVerification.status': 'PENDING' } });
  reject(await metadata(fixture, { fulfillmentMode: 'SELF' }), 'unverified COD OTP');
  assert.equal(await Shipment.countDocuments({ order: fixture.id }), 0);
  assert.equal((await Product.findById(fixture.product._id)).stock, 4);
});

test('unsafe links, invalid dates, and malformed delivery contact cannot enter customer tracking', async () => {
  const fixture = await createOrder();
  assert.equal((await metadata(fixture, { fulfillmentMode: 'COURIER', courierName: 'Courier', trackingNumber: 'SAFE-AWB-1' })).status, 200);
  const beforeRevision = await revision(fixture.id);
  for (const fields of [
    { trackingUrl: 'javascript:alert(1)' }, { trackingUrl: 'http://courier.example/tracking' },
    { trackingUrl: 'https://user:password@courier.example/tracking' }, { trackingUrl: '//courier.example/tracking' },
    { expectedDeliveryAt: 'not-a-date' }, { expectedDeliveryAt: '2027-02-30' },
    { fulfillmentMode: 'DRONE' }, { deliveryContact: { name: 'Driver', phone: '1234' } },
    { deliveryContact: ['not', 'a', 'contact'] }, { customerNote: 'x'.repeat(2001) },
    { trackingNumber: 'DIFFERENT-A', awb: 'DIFFERENT-B' },
  ]) reject(await metadata(fixture, fields), JSON.stringify(fields));
  assert.equal(await revision(fixture.id), beforeRevision);
  assert.equal((await savedShipment(fixture.id)).trackingNumber, 'SAFE-AWB-1');
});

test('an integrated shipment cannot be silently converted to manual or self delivery', async () => {
  const fixture = await createOrder();
  const current = await Order.findById(fixture.id);
  const integrated = await Shipment.create({
    order: fixture.id, storeId: current.storeId, provider: 'shiprocket', courierName: 'Connected courier',
    trackingNumber: 'INTEGRATED-001', awb: 'INTEGRATED-001', bookingState: 'BOOKED', status: 'READY_TO_SHIP',
  });
  await Order.updateOne({ _id: fixture.id }, { $set: { shipment: integrated._id } });
  reject(await metadata(fixture, { fulfillmentMode: 'SELF' }), 'integrated to self');
  reject(await metadata(fixture, { fulfillmentMode: 'COURIER', courierName: 'Override', trackingNumber: 'OVERRIDE-001' }), 'integrated to manual');
  const unchanged = await savedShipment(fixture.id);
  assert.equal(unchanged.provider, 'shiprocket');
  assert.equal(unchanged.awb, 'INTEGRATED-001');
});

test('customer delivery reads enforce ownership and hide internal provider bookkeeping', async () => {
  const fixture = await createOrder();
  const stranger = await createCustomer();
  assert.equal((await metadata(fixture, { fulfillmentMode: 'SELF', customerNote: 'Visible delivery note' })).status, 200);
  await Shipment.updateOne({ order: fixture.id }, { $set: {
    operation: 'PRIVATE-OPERATION', lastError: 'PRIVATE-ERROR', providerRef: 'PRIVATE-REFERENCE', providerCharge: 61,
    service: { internalCode: 'PRIVATE-SERVICE' }, pickup: { token: 'PRIVATE-PICKUP' },
    pickupAddress: { houseNo: 'PRIVATE-WAREHOUSE' }, destination: { houseNo: 'PRIVATE-DESTINATION' },
    exceptionActions: [{ action: 'OTHER', note: 'PRIVATE-FOLLOWUP', actor: { id: 'staff', name: 'Staff' } }],
  } });
  const own = await request(`/api/orders/${fixture.id}/delivery`, { token: fixture.customer.token });
  assert.equal(own.status, 200, JSON.stringify(own.data));
  assert.equal(own.data.shipment.customerNote, 'Visible delivery note');
  for (const key of ['operation', 'operationStartedAt', 'lastError', 'providerRef', 'providerCharge', 'service', 'pickup', 'pickupAddress', 'destination', 'exceptionActions']) {
    assert.equal(own.data.shipment[key], undefined, `${key} must not be customer-visible`);
  }
  const strangerRead = await request(`/api/orders/${fixture.id}/delivery`, { token: stranger.token });
  assert.ok([403, 404].includes(strangerRead.status), JSON.stringify(strangerRead.data));
  const anonymousRead = await request(`/api/orders/${fixture.id}/delivery`);
  assert.equal(anonymousRead.status, 401);
  const customerWrite = await request(`/api/orders/${fixture.id}/shipment`, { method: 'PUT', token: fixture.customer.token, body: { fulfillmentMode: 'SELF' } });
  assert.equal(customerWrite.status, 403);
});

test('manual tracking numbers are unique per store without reserving the same ID in every store', async () => {
  await Shipment.init();
  const first = await createOrder();
  const second = await createOrder();
  const fields = { fulfillmentMode: 'COURIER', courierName: 'Courier', trackingNumber: 'STORE-SCOPED-AWB' };
  assert.equal((await metadata(first, fields)).status, 200);
  reject(await metadata(second, fields), 'duplicate tracking ID in same store');
  assert.equal(await Shipment.countDocuments({ order: second.id }), 0);
  await Order.updateOne({ _id: second.id }, { $set: { storeId: new mongoose.Types.ObjectId() } });
  const otherStore = await metadata(second, fields);
  assert.equal(otherStore.status, 200, JSON.stringify(otherStore.data));
  assert.equal(await Shipment.countDocuments({ awb: fields.trackingNumber }), 2);
});

test('cancelling an undispatched manual order closes tracking and restores stock exactly once', async () => {
  const fixture = await createOrder();
  assert.equal((await metadata(fixture, { fulfillmentMode: 'SELF' })).status, 200);
  const cancelled = await setStatus(fixture, 'Cancelled', { note: 'Customer no longer needs the item.' });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.data));
  assert.equal((await savedShipment(fixture.id)).status, 'CANCELLED');
  assert.equal((await Product.findById(fixture.product._id)).stock, 5);
  assert.equal(await InventoryTransaction.countDocuments({ order: fixture.id, type: 'CANCELLATION' }), 1);
  reject(await metadata(fixture, { customerNote: 'Reopen cancelled parcel' }), 'cancelled shipment metadata');
  reject(await setStatus(fixture, 'Shipped'), 'cancelled order dispatch');
  assert.equal((await Product.findById(fixture.product._id)).stock, 5);
});

test('dispatch prevents cancellation and stock restoration while manual delivery is in progress', async () => {
  const fixture = await createOrder();
  assert.equal((await metadata(fixture, { fulfillmentMode: 'SELF' })).status, 200);
  assert.equal((await setStatus(fixture, 'Packed')).status, 200);
  assert.equal((await setStatus(fixture, 'Shipped')).status, 200);
  const cancelled = await request(`/api/orders/${fixture.id}/cancel`, { method: 'POST', token: fixture.customer.token, body: {} });
  assert.equal(cancelled.status, 409, JSON.stringify(cancelled.data));
  assert.equal((await Order.findById(fixture.id)).orderStatus, 'Shipped');
  assert.equal((await savedShipment(fixture.id)).status, 'SHIPPED');
  assert.equal((await Product.findById(fixture.product._id)).stock, 4);
  assert.equal(await InventoryTransaction.countDocuments({ order: fixture.id, type: 'CANCELLATION' }), 0);
});

test('manual exceptions and delivery retries inform the customer without bypassing order or payment states', async () => {
  const fixture = await createOrder();
  assert.equal((await metadata(fixture, { fulfillmentMode: 'SELF' })).status, 200);
  reject(await metadata(fixture, { deliveryEvent: 'NOTE', customerNote: 'A progress update before dispatch' }), 'progress before dispatch');
  assert.equal((await setStatus(fixture, 'Packed')).status, 200);
  assert.equal((await setStatus(fixture, 'Shipped')).status, 200);
  for (const deliveryEvent of ['NOTE', 'EXCEPTION']) {
    reject(await metadata(fixture, { deliveryEvent, customerNote: '' }), `${deliveryEvent} without explanation`);
  }
  reject(await metadata(fixture, { deliveryEvent: 'OUT_FOR_DELIVERY' }), 'delivery attempt before order is out for delivery');
  const exception = await metadata(fixture, { deliveryEvent: 'EXCEPTION', customerNote: 'Customer requested delivery tomorrow.' });
  assert.equal(exception.status, 200, JSON.stringify(exception.data));
  let currentOrder = await Order.findById(fixture.id);
  assert.equal(currentOrder.orderStatus, 'Shipped');
  assert.equal(currentOrder.paymentStatus, 'Pending');
  assert.equal((await savedShipment(fixture.id)).status, 'EXCEPTION');
  const note = await metadata(fixture, { deliveryEvent: 'NOTE', customerNote: 'Customer confirmed the revised delivery time.' });
  assert.equal(note.status, 200, JSON.stringify(note.data));
  assert.equal((await savedShipment(fixture.id)).status, 'EXCEPTION', 'a note alone must not claim the issue is resolved');
  const resumed = await metadata(fixture, { deliveryEvent: 'IN_TRANSIT', customerNote: 'The parcel is moving to the delivery address again.' });
  assert.equal(resumed.status, 200, JSON.stringify(resumed.data));
  assert.equal((await savedShipment(fixture.id)).status, 'IN_TRANSIT');
  assert.equal((await setStatus(fixture, 'Out for Delivery')).status, 200);
  reject(await metadata(fixture, { deliveryEvent: 'IN_TRANSIT' }), 'cannot regress an out-for-delivery order');
  assert.equal((await metadata(fixture, { deliveryEvent: 'EXCEPTION', customerNote: 'Delivery contact was temporarily unavailable.' })).status, 200);
  const retry = await metadata(fixture, { deliveryEvent: 'OUT_FOR_DELIVERY', customerNote: 'The store team is making another delivery attempt.' });
  assert.equal(retry.status, 200, JSON.stringify(retry.data));
  const visible = await request(`/api/orders/${fixture.id}/delivery`, { token: fixture.customer.token });
  assert.equal(visible.status, 200);
  assert.equal(visible.data.shipment.status, 'OUT_FOR_DELIVERY');
  assert.ok(visible.data.shipment.events.some(event => event.status === 'EXCEPTION' && event.note === 'Customer requested delivery tomorrow.'));
  assert.equal(visible.data.shipment.events.at(-1).note, 'The store team is making another delivery attempt.');
  currentOrder = await Order.findById(fixture.id);
  assert.equal(currentOrder.orderStatus, 'Out for Delivery');
  assert.equal(currentOrder.paymentStatus, 'Pending');
  assert.equal(currentOrder.deliveredAt, undefined);
  assert.equal((await Product.findById(fixture.product._id)).stock, 4);
});

test('unchanged manual metadata is idempotent and refreshing tracking never calls an integrated courier', async t => {
  const fixture = await createOrder();
  const fields = {
    fulfillmentMode: 'COURIER', courierName: 'Booked outside the app', trackingNumber: 'NO-API-TRACK-1',
    trackingUrl: 'https://courier.example/track/NO-API-TRACK-1', expectedDeliveryAt: nextDate(),
    deliveryContact: { name: 'Store delivery support', phone: '9876543210' }, customerNote: 'Track using the courier link.',
  };
  assert.equal((await metadata(fixture, fields)).status, 200);
  const before = await savedShipment(fixture.id);
  const beforeRevision = await revision(fixture.id);
  const savedAgain = await metadata(fixture, fields);
  assert.equal(savedAgain.status, 200, JSON.stringify(savedAgain.data));
  assert.equal(await revision(fixture.id), beforeRevision, 'identical metadata does not consume a revision');
  assert.equal((await savedShipment(fixture.id)).events.length, before.events.length, 'identical metadata does not append duplicate history');

  const originalFetch = global.fetch;
  const externalCalls = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    if (new URL(url).hostname === '127.0.0.1') return originalFetch(url, options);
    externalCalls.push(String(url));
    throw new Error('Manual tracking must not call any external provider');
  });
  const refreshed = await request(`/api/orders/${fixture.id}/delivery?refresh=1`, { token: fixture.customer.token });
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.data));
  assert.equal(refreshed.data.warning, '');
  assert.equal(refreshed.data.shipment.trackingNumber, fields.trackingNumber);
  assert.equal(refreshed.data.shipment.trackingUrl, fields.trackingUrl);
  assert.deepEqual(externalCalls, []);
  assert.equal((await savedShipment(fixture.id)).events.length, before.events.length);
});

test('an order retains its checkout self-delivery choice when the store later changes its default', async () => {
  await setSettings({ shippingProvider: 'manual', manualDeliveryMode: 'SELF' });
  const self = await createOrder();
  assert.equal((await Order.findById(self.id)).shippingQuote.fulfillmentMode, 'SELF');
  await setSettings({ shippingProvider: 'manual', manualDeliveryMode: 'COURIER' });
  assert.equal((await setStatus(self, 'Packed')).status, 200);
  const configured = await metadata(self, { deliveryContact: { name: 'Our store team', phone: '9876543210' } });
  assert.equal(configured.status, 200, JSON.stringify(configured.data));
  const shipment = await savedShipment(self.id);
  assert.equal(shipment.fulfillmentMode, 'SELF');
  assert.ok(shipment.deliveryReference);
  assert.ok(!shipment.awb);
  assert.equal((await setStatus(self, 'Shipped')).status, 200);

  const courier = await createOrder();
  assert.equal((await Order.findById(courier.id)).shippingQuote.fulfillmentMode, 'COURIER');
  assert.equal((await metadata(courier, { courierName: 'New default courier', trackingNumber: 'NEW-DEFAULT-001' })).status, 200);
  assert.equal((await savedShipment(courier.id)).fulfillmentMode, 'COURIER');
  assert.equal((await savedShipment(self.id)).fulfillmentMode, 'SELF');
});

for (const fulfillmentMode of ['SELF', 'COURIER']) {
  test(`${fulfillmentMode}: failed delivery returns to the store for explicit inspection, never automatic stock or COD changes`, async () => {
    const fixture = await createOrder();
    const fields = fulfillmentMode === 'SELF'
      ? { fulfillmentMode }
      : { fulfillmentMode, courierName: 'Manual return courier', trackingNumber: 'MANUAL-RTO-001' };
    assert.equal((await metadata(fixture, fields)).status, 200);
    assert.equal((await setStatus(fixture, 'Packed')).status, 200);
    reject(await metadata(fixture, { deliveryEvent: 'RTO_IN_TRANSIT', customerNote: 'This parcel has not left the store.' }), 'RTO before dispatch');
    assert.equal((await setStatus(fixture, 'Shipped')).status, 200);
    reject(await metadata(fixture, { deliveryEvent: 'RETURNED', confirmReturned: true, customerNote: 'Cannot skip return transit.' }), 'direct return without RTO');
    reject(await metadata(fixture, { deliveryEvent: 'RTO_IN_TRANSIT', customerNote: '' }), 'return transit without customer explanation');

    const inTransit = await metadata(fixture, {
      deliveryEvent: 'RTO_IN_TRANSIT', customerNote: 'Delivery could not be completed. The parcel is returning to our store.',
    });
    assert.equal(inTransit.status, 200, JSON.stringify(inTransit.data));
    let order = await Order.findById(fixture.id);
    assert.equal((await savedShipment(fixture.id)).status, 'RTO_IN_TRANSIT');
    assert.equal(order.rto.status, 'IN_TRANSIT');
    assert.equal(order.paymentStatus, 'Pending');
    assert.equal(order.rto.inventoryRecorded, false);
    assert.equal(order.deliveredAt, undefined);
    assert.equal((await Product.findById(fixture.product._id)).stock, 4);
    reject(await setStatus(fixture, 'Out for Delivery'), 'cannot redeliver a returning parcel');
    reject(await setStatus(fixture, 'Delivered'), 'cannot mark a returning parcel delivered');
    const adminView = await request(`/api/admin/orders/${fixture.id}`, { token: fixture.admin.token });
    assert.equal(adminView.status, 200);
    assert.ok(!adminView.data.allowedActions.includes('MARK_OUT_FOR_DELIVERY'));
    assert.ok(!adminView.data.allowedActions.includes('MARK_DELIVERED'));
    const prematureInspection = await request(pathFor(fixture.id, 'rto/inspect'), {
      method: 'POST', token: fixture.admin.token,
      body: { disposition: 'RESTOCK', notes: 'Cannot inspect before physical receipt.', revision: await revision(fixture.id) },
    });
    reject(prematureInspection, 'inspection before receipt');
    reject(await metadata(fixture, { deliveryEvent: 'RETURNED', customerNote: 'Parcel arrived, but receipt is not confirmed.' }), 'physical receipt confirmation required');
    reject(await metadata(fixture, { deliveryEvent: 'RETURNED', confirmReturned: true, customerNote: '' }), 'receipt without explanation');

    const received = await metadata(fixture, {
      deliveryEvent: 'RETURNED', confirmReturned: true,
      customerNote: 'The store received the returned parcel. Quality inspection is pending.',
    });
    assert.equal(received.status, 200, JSON.stringify(received.data));
    order = await Order.findById(fixture.id);
    assert.equal((await savedShipment(fixture.id)).status, 'RETURNED');
    assert.equal(order.rto.status, 'QC_PENDING');
    assert.equal(order.rto.disposition, 'PENDING');
    assert.ok(order.rto.receivedAt);
    assert.equal(order.rto.inventoryRecorded, false);
    assert.equal(order.paymentStatus, 'Pending');
    assert.equal((await Product.findById(fixture.product._id)).stock, 4, 'physical receipt must not put uninspected goods back on sale');
    assert.equal(returnEligibility(order, [], 7).items[0].canRequest, false, 'RTO receipt is not a successful customer delivery');
    reject(await metadata(fixture, { customerNote: 'Attempt to edit a closed parcel' }), 'metadata after physical return');
    reject(await setStatus(fixture, 'Delivered'), 'cannot mark a returned parcel delivered');

    const customerView = await request(`/api/orders/${fixture.id}/delivery`, { token: fixture.customer.token });
    assert.equal(customerView.status, 200);
    assert.equal(customerView.data.shipment.status, 'RETURNED');
    assert.ok(customerView.data.shipment.events.some(event => event.status === 'RTO_IN_TRANSIT'));
    assert.equal(customerView.data.shipment.events.at(-1).status, 'RETURNED');

    const inspection = { disposition: 'RESTOCK', receivedQuantity: 1, notes: 'All units physically received and inspected as sellable.' };
    const restocked = await request(pathFor(fixture.id, 'rto/inspect'), {
      method: 'POST', token: fixture.admin.token, body: { ...inspection, revision: await revision(fixture.id) },
    });
    assert.equal(restocked.status, 200, JSON.stringify(restocked.data));
    order = await Order.findById(fixture.id);
    assert.equal(order.rto.inventoryRecorded, true);
    assert.equal(order.rto.disposition, 'RESTOCK');
    assert.equal(order.rto.refundStatus, 'NOT_REQUIRED', 'an unpaid COD parcel does not create a refund');
    assert.equal(order.paymentStatus, 'Pending');
    assert.equal((await Product.findById(fixture.product._id)).stock, 5);
    const repeated = await request(pathFor(fixture.id, 'rto/inspect'), {
      method: 'POST', token: fixture.admin.token, body: { ...inspection, revision: await revision(fixture.id) },
    });
    reject(repeated, 'repeated completed inspection');
    assert.equal((await Product.findById(fixture.product._id)).stock, 5, 'repeat requests cannot restock the parcel twice');
  });
}
