require('./rentalPaymentFixture');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startTestEnvironment, stopTestEnvironment, resetDatabase, request } = require('./helpers');
const { createCustomer, createAdmin, createProduct, validAddress, setSettings } = require('./factories');
const { ensureDefaultStore } = require('../services/storeService');
const Store = require('../models/Store');
const M = require('../models/Rental');
const S = require('../services/rentalService');
const A = require('../services/rentalAlgorithms');
const C = require('../services/rentalCourierService');
const op = () => 'details_' + crypto.randomUUID();
let store, customer, admin, listing, asset;
const rentalAddress = overrides => { const { addressType, ...value } = validAddress(overrides); return value; };
const details = () => ({ version: 1, deliveryAddress: rentalAddress({ fullName: 'Buyer', mobile: '9876543210' }), collectionAddress: rentalAddress({ fullName: 'Return contact', mobile: '9876543211', city: 'Delhi', pincode: '110001' }), sameAsDelivery: false, occasion: 'Wedding', fittingInstructions: 'Check blouse fit', deliveryInstructions: 'Call on arrival', alternateContact: { name: 'Sister', phone: '9876543211' }, pickupContact: null, returnContact: null });
before(startTestEnvironment); after(stopTestEnvironment);
beforeEach(async () => {
  await resetDatabase(); store = await ensureDefaultStore(); await require('./rentalPaymentFixture').configure(store); customer = await createCustomer(); admin = await createAdmin();
  const product = await createProduct({ storeId: store._id, commerceMode: 'SALE_AND_RENTAL' });
  await S.saveConfiguration(store, { revision: 0, mode: 'SALE_AND_RENTAL', policy: { ...A.DEFAULT_POLICY, deliveryModes: ['STORE_PICKUP', 'SELF_DELIVERY', 'COURIER'], tailoringEnabled: true } });
  asset = await S.saveAsset(store, { productId: String(product._id), poolKey: 'outfit', code: 'LEHENGA-001', label: 'Lehenga' });
  listing = await S.saveListing(store, { productId: String(product._id), title: 'Lehenga', active: true, dailyRatePaise: 100000, depositPaise: 500000, requirements: [{ poolKey: 'outfit', label: 'Outfit', quantity: 1 }] });
});
async function payload(extra = {}) {
  const key = new Date(Date.now() + 3 * A.DAY).toISOString().slice(0, 10), pickupAt = `${key}T10:00:00+05:30`;
  const value = { pickupAt, returnDueAt: new Date(+new Date(pickupAt) + 2 * A.DAY).toISOString(), items: [{ listingId: String(listing._id), quantity: 1 }], acceptTerms: true, attemptId: op(), policyRevision: (await S.readConfiguration(store)).revision, ...extra };
  const quote = await S.publicQuote(store, value); return { ...value, quoteFingerprint: quote.quoteFingerprint };
}
const hold = async extra => S.hold(store, await payload(extra), customer.user);
const action = (b, action, extra = {}) => S.mutateBooking(store, b._id, { operationId: op(), revision: b.revision, action, ...extra }, admin.user._id);
const clean = b => { const value = JSON.parse(JSON.stringify(b.bookingDetails)); for (const key of ['pickupContact', 'returnContact']) if (value[key]) { delete value[key].authorisedAt; delete value[key].authorisedBy; } return value; };
async function ready(extra = {}) {
  let b = await hold(extra);
  b = await S.recordCollection(store, b._id, { revision: b.revision, operationId: op(), amountPaise: b.quote.totalPaise, method: 'CASH', reference: op() }, admin.user._id);
  return action(await action(b, 'PREPARE'), 'READY');
}
async function pickupNow(b) {
  await M.Booking.updateOne({ _id: b._id }, { $set: { 'schedule.pickupAt': new Date(Date.now() - 60000) } }); return S.getBooking(store, b._id);
}
test('structured fields survive booking, customer/admin retrieval and cross-customer/store isolation', async () => {
  const value = await payload({ deliveryMode: 'SELF_DELIVERY', bookingDetails: details() });
  const created = await request('/api/rentals/bookings', { method: 'POST', token: customer.token, body: value });
  assert.equal(created.status, 200); const b = created.data;
  assert.equal(b.bookingDetails.collectionAddress.city, 'Delhi'); assert.equal(b.bookingDetails.occasion, 'Wedding'); assert.match(b.logistics.address, /Buyer/);
  const own = await request( `/api/rentals/bookings/${b._id}`, { token: customer.token });
  assert.equal(own.status, 200); assert.equal(own.data.bookingDetails.fittingInstructions, 'Check blouse fit');
  const other = await createCustomer(); assert.equal((await request( `/api/rentals/bookings/${b._id}`, { token: other.token })).status, 404);
  const otherStore = await Store.create({ name: 'Other', slug: 'other-details' });
  await assert.rejects(() => S.getBooking(otherStore, b._id), /not found/);
});
test('new-field idempotency detects changed address or instructions without creating duplicate reservations', async () => {
  const value = await payload({ deliveryMode: 'COURIER', bookingDetails: details() });
  const b = await S.hold(store, value, customer.user); assert.equal(String((await S.hold(store, value, customer.user))._id), String(b._id));
  await assert.rejects(() => S.hold(store, { ...value, bookingDetails: { ...details(), occasion: 'Festival' } }, customer.user), /different details/);
  assert.equal(await M.Reservation.countDocuments({ bookingId: b._id }), 1);
});
test('legacy delivery payloads retain their address and omitted structured piece data is preserved', async () => {
  const b = await hold({ deliveryMode: 'SELF_DELIVERY', address: 'Legacy customer address' }); assert.equal(b.logistics.address, 'Legacy customer address'); assert.equal(b.bookingDetails, undefined);
  const fitProfile = { kind: 'APPAREL', unit: 'in', values: { waist: 30 }, alterationsAllowed: true, alterationLimits: { waist: { min: 28, max: 34 } } };
  let a = await S.saveAsset(store, { ...asset, measurements: 'Original fitting notes', fitProfile });
  const { fitProfile: omitted, ...oldInput } = a; a = await S.saveAsset(store, { ...oldInput, condition: 'Good' });
  assert.equal(a.fitProfile.values.waist, 30); assert.equal(a.measurements, 'Original fitting notes');
  a = await S.saveAsset(store, { ...a, fitProfile: null }); assert.equal(a.fitProfile, null); assert.equal(a.measurements, 'Original fitting notes');
});
test('invalid details and unapproved delegates fail without a booking or reservation', async () => {
  const value = await payload({ bookingDetails: { pickupContact: { name: 'Friend', phone: '9876543210', authorised: false } } });
  await assert.rejects(() => S.hold(store, value, customer.user), /authorise/);
  const invalid = await payload({ deliveryMode: 'COURIER', bookingDetails: { ...details(), deliveryAddress: { ...details().deliveryAddress, pincode: '000000' } } });
  await assert.rejects(() => S.hold(store, invalid, customer.user), /PIN/);
  assert.equal(await M.Booking.countDocuments(), 0); assert.equal(await M.Reservation.countDocuments(), 0);
});
test('approved detail edits use revisions, retain pricing and authorisation history, and reject stale edits', async () => {
  let b = await hold({ bookingDetails: { pickupContact: { name: 'Sister', phone: '9876543210', authorised: true } } });
  const originalQuote = b.quote, authorisation = b.bookingDetails.pickupContact.authorisedAt;
  const update = { bookingDetails: { ...clean(b), occasion: 'Engagement' }, customerApproved: true, note: 'Customer confirmed occasion' };
  await assert.rejects(() => action(b, 'DETAILS', { ...update, customerApproved: false }), /approval/);
  const old = b; b = await action(b, 'DETAILS', update);
  assert.deepEqual(b.quote, originalQuote); assert.equal(+b.bookingDetails.pickupContact.authorisedAt, +authorisation);
  assert.equal(b.bookingDetailsHistory.length, 1); assert.equal(b.bookingDetailsHistory[0].before.pickupContact.name, 'Sister');
  await assert.rejects(() => action(old, 'DETAILS', update), /Booking changed/);
  const publicValue = S.present(await S.getBooking(store, b._id), { staff: false }); assert.equal(publicValue.bookingDetailsHistory, undefined); assert.equal(publicValue.bookingDetails.pickupContact.authorisedBy, undefined);
});
test('delegate checks cannot be bypassed at handover/partial return; successful checks are audited', async () => {
  let b = await ready({ bookingDetails: { pickupContact: { name: 'Sister', phone: '9876543210', authorised: true }, returnContact: { name: 'Brother', phone: '9876543211', authorised: true } } });
  b = await pickupNow(b); const assetIds = b.allocations.map(a => String(a.assetId));
  await assert.rejects(() => action(b, 'HANDOVER', { assetIds, note: 'Checklist reviewed' }), /named contact/);
  b = await action(b, 'HANDOVER', { assetIds, note: 'Checklist reviewed', contactVerified: true }); assert.equal(b.contactChecks.length, 1); assert.equal(b.contactChecks[0].name, 'Sister');
  await assert.rejects(() => action(b, 'RECEIVE', { assetIds, note: 'Return' }), /named contact/);
  b = await action(b, 'RECEIVE', { assetIds, note: 'Returned', contactVerified: true }); assert.equal(b.status, 'RETURNED'); assert.equal(b.contactChecks[1].name, 'Brother');
});
test('after handover outbound details lock while approved return contact changes remain possible', async () => {
  let b = await pickupNow(await ready({ bookingDetails: { occasion: 'Wedding' } }));
  b = await action(b, 'HANDOVER', { assetIds: b.allocations.map(a => String(a.assetId)), note: 'Checklist' });
  await assert.rejects(() => action(b, 'DETAILS', { bookingDetails: { ...clean(b), occasion: 'Festival' }, customerApproved: true, note: 'Change' }), /locked after handover/);
  b = await action(b, 'DETAILS', { bookingDetails: { ...clean(b), returnContact: { name: 'Sister', phone: '9876543211', authorised: true } }, customerApproved: true, note: 'Customer approved sister returning' });
  assert.equal(b.bookingDetails.returnContact.name, 'Sister'); assert.equal(b.status, 'OUT');
});
test('a connected courier leg prevents silent edits of its committed address', async () => {
  const b = await hold({ deliveryMode: 'COURIER', bookingDetails: details() });
  await M.Courier.create({ storeId: store._id, bookingId: b._id, direction: 'outbound', operationId: op(), status: 'BOOKED', awb: '1234567890' });
  await assert.rejects(() => action(b, 'DETAILS', { bookingDetails: { ...clean(b), deliveryAddress: { ...details().deliveryAddress, city: 'Mumbai' } }, customerApproved: true, note: 'Move' }), /courier leg/);
});
test('legacy dispatched delivery keeps its historical address while structured return details can be added', async () => {
  let b = await pickupNow(await ready({ deliveryMode: 'SELF_DELIVERY', address: 'Original legacy address' }));
  b = await action(b, 'HANDOVER', { assetIds: b.allocations.map(a => String(a.assetId)), note: 'Checklist' });
  const update = { deliveryAddress: null, collectionAddress: details().collectionAddress, sameAsDelivery: false, returnContact: { name: 'Sister', phone: '9876543211', authorised: true } };
  b = await action(b, 'DETAILS', { bookingDetails: update, customerApproved: true, note: 'Customer approved collection from another address' });
  assert.equal(b.logistics.address, 'Original legacy address'); assert.equal(b.bookingDetails.deliveryAddress, null); assert.equal(b.bookingDetails.collectionAddress.city, 'Delhi');
  await assert.rejects(() => S.hold(store, { deliveryMode: 'COURIER', bookingDetails: update, attemptId: op(), acceptTerms: true }, customer.user), /delivery address/);
});
test('connected courier uses the correct saved address for each leg and rejects mismatched overrides', async t => {
  const configuration = await S.readConfiguration(store); await S.saveConfiguration(store, { ...configuration, policy: { ...configuration.policy, courierIntegrationEnabled: true } });
  await setSettings({ razorpayEnabled: true, storeId: store._id, shippingProvider: 'bluedart', shippingPickup: validAddress({ fullName: 'Store' }) });
  const adapter = require('../services/blueDartProvider'); let destinations = [];
  t.mock.method(adapter, 'readiness', () => ({ mode: 'test', liveBooking: true, reverse: true }));
  t.mock.method(adapter, 'serviceability', async input => { destinations.push(input); return { service: { productCode: 'A' }, pickupArea: 'JAI' }; });
  t.mock.method(adapter, 'book', async () => ({ awb: '12345678901' }));
  let b = await ready({ deliveryMode: 'COURIER', bookingDetails: details() });
  const command = { revision: b.revision, operationId: op(), declaredValuePaise: 1000000, date: A.localKey(new Date(+new Date(b.schedule.pickupAt) - 2 * A.HOUR), 'Asia/Kolkata'), time: '08:00', closeTime: '18:00' };
  await assert.rejects(() => C.operate(store, b._id, 'outbound', 'book', { ...command, address: validAddress({ city: 'Wrong city' }) }, admin.user._id), /differs/);
  await C.operate(store, b._id, 'outbound', 'book', command, admin.user._id); assert.equal(destinations[0].destination.city, details().deliveryAddress.city);
  // Reverse serviceability can be exercised without an external carrier or a dispatch side effect.
  await M.Booking.updateOne({ _id: b._id }, { $set: { status: 'OUT' } }); b = await S.getBooking(store, b._id);
  await C.operate(store, b._id, 'inbound', 'book', { ...command, revision: b.revision, operationId: op(), date: A.localKey(new Date(Date.now() + A.DAY), 'Asia/Kolkata') }, admin.user._id);
  assert.equal(destinations[1].origin.city, 'Delhi');
});
test('piece alteration prohibition is enforced and legacy pieces still support existing tailoring', async () => {
  asset = await S.saveAsset(store, { ...asset, fitProfile: { kind: 'JEWELLERY', unit: 'cm', values: { bangleInnerDiameter: 6.2 }, alterationsAllowed: false } });
  const X = require('../services/rentalStudioService');
  await assert.rejects(() => X.createTask(store, { operationId: op(), assetId: String(asset._id), type: 'ALTERATION', dueAt: new Date(Date.now() + A.DAY).toISOString(), assignee: 'Tailor', instructions: 'Resize' }, admin.user._id), /not alterable/);
  asset = await S.saveAsset(store, { ...asset, fitProfile: null });
  let b = await hold();
  b = await S.recordCollection(store, b._id, { revision: b.revision, operationId: op(), amountPaise: b.quote.totalPaise, method: 'CASH', reference: op() }, admin.user._id);
  const task = await X.createTask(store, { operationId: op(), assetId: String(asset._id), bookingId: String(b._id), type: 'ALTERATION', dueAt: new Date(Date.now() + A.DAY).toISOString(), assignee: 'Tailor', instructions: 'Resize after customer review' }, admin.user._id);
  assert.equal(task.status, 'OPEN');
});
