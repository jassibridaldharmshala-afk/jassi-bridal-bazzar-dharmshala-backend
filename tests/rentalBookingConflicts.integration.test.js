const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const H = require('./helpers'), F = require('./factories');
const S = require('../services/rentalService'), A = require('../services/rentalAlgorithms');
const M = require('../models/Rental'), Setup = require('../services/rentalSetupService');
const op = () => 'conflict_' + crypto.randomUUID();
let store, product, listing, customer, other;
before(H.startTestEnvironment); after(H.stopTestEnvironment);
beforeEach(async () => {
  await H.resetDatabase(); store = await require('../services/storeService').ensureDefaultStore();
  customer = await F.createCustomer(); other = await F.createCustomer();
  await F.setSettings({ storeId: store._id, acceptingOrders: true, razorpayEnabled: false });
  await S.saveConfiguration(store, { revision: 0, mode: 'SALE_AND_RENTAL', policy: { ...A.DEFAULT_POLICY, balanceDueHours: 0 } });
  product = await F.createProduct({ storeId: store._id, commerceMode: 'SALE_AND_RENTAL', sizingMode: 'free-size' });
  listing = await S.saveListing(store, { productId: String(product._id), title: 'Orange Lehenga', active: false,
    dailyRatePaise: 100000, depositPaise: 50000, requirements: [{ poolKey: 'orange', label: 'Lehenga', quantity: 1 }] });
  await addPiece(); listing = await S.saveListing(store, { ...listing, active: true });
});
async function addPiece() {
  await Setup.registerPieces(store, String(listing._id), { operationId: op(), revision: listing.revision, componentIndex: 0, quantity: 1 });
}
function plan(offset = 7, id = listing._id) {
  const day = n => A.localKey(new Date(Date.now() + n * A.DAY), 'Asia/Kolkata');
  return { items: [{ listingId: String(id), quantity: 1 }], pickupAt: day(offset) + 'T10:00:00+05:30',
    useDates: [day(offset + 1)], returnDueAt: day(offset + 2) + 'T10:00:00+05:30', paymentPlan: 'PICKUP' };
}
async function accepted(input = plan()) {
  const q = await S.publicQuote(store, input);
  return { ...input, attemptId: op(), policyRevision: q.policyRevision, quoteFingerprint: q.quoteFingerprint, acceptTerms: true, customer: {} };
}
const quote = (input, who) => H.request('/api/rentals/quote', { method: 'POST', body: input, token: who?.token });
const reserve = (input, who = customer) => H.request('/api/rentals/bookings', { method: 'POST', body: input, token: who.token });

test('owner sees the existing booking before quoting or reserving, even when a second piece is free; exact retries recover', async () => {
  await addPiece(); const input = await accepted(), first = await reserve(input);
  assert.equal(first.status, 200);
  const preview = await quote(plan(), customer);
  assert.equal(preview.status, 409); assert.equal(preview.data.code, 'RENTAL_ALREADY_BOOKED');
  assert.match(preview.data.message, /already booked Orange Lehenga/);
  assert.equal(preview.data.details.bookingId, first.data._id);
  const duplicate = await reserve({ ...input, attemptId: op() });
  assert.equal(duplicate.status, 409); assert.equal(duplicate.data.code, 'RENTAL_ALREADY_BOOKED');
  const retry = await reserve(input); assert.equal(retry.status, 200); assert.equal(retry.data._id, first.data._id);
  assert.equal(await M.Booking.countDocuments(), 1); assert.equal(await M.Reservation.countDocuments({ active: true }), 1);
});

test('another customer and a guest get booked-date guidance without the owner identity or booking link', async () => {
  const b = await reserve(await accepted());
  for (const who of [other, undefined]) {
    const r = await quote({ ...plan(), customerUserId: String(customer.user._id), customer: { phone: customer.user.phone } }, who);
    assert.equal(r.status, 409); assert.equal(r.data.code, 'OUT_OF_STOCK'); assert.match(r.data.message, /already booked.*dates/);
    assert.equal(r.data.details, undefined);
    for (const secret of [b.data._id, b.data.number, customer.user.phone, String(customer.user._id)]) assert(!JSON.stringify(r.data).includes(secret));
  }
  assert.equal((await quote(plan(), { token: 'invalid-token' })).status, 401);
});

test('two customers with already-reviewed quotes cannot reserve the same last piece simultaneously', async () => {
  const first = await accepted(), second = { ...first, attemptId: op() };
  const results = await Promise.all([reserve(first), reserve(second, other)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal(results.find(r => r.status === 409).data.code, 'OUT_OF_STOCK');
  assert.equal(await M.Booking.countDocuments(), 1); assert.equal(await M.Reservation.countDocuments({ active: true }), 1);
});

test('same customer racing two distinct attempts gets one booking even with two physical pieces', async () => {
  await addPiece(); const first = await accepted();
  const results = await Promise.all([reserve(first), reserve({ ...first, attemptId: op() })]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal(results.find(r => r.status === 409).data.code, 'RENTAL_ALREADY_BOOKED');
  assert.equal(await M.Booking.countDocuments(), 1); assert.equal(await M.Reservation.countDocuments({ active: true }), 1);
});

test('two real pieces admit two customers and stop the third; sale stock is unaffected', async () => {
  await addPiece(); const initialStock = (await require('../models/Product').findById(product._id)).stock;
  const input = await accepted(); const results = await Promise.all([reserve(input), reserve({ ...input, attemptId: op() }, other)]);
  assert(results.every(r => r.status === 200));
  const reservations = await M.Reservation.find({ active: true }).lean();
  assert.equal(new Set(reservations.map(r => String(r.assetId))).size, 2);
  assert.equal((await quote(plan())).data.code, 'OUT_OF_STOCK');
  assert.equal((await require('../models/Product').findById(product._id)).stock, initialStock);
});

test('overlapping custody blocks repeat orders while another use period stays bookable; cleaning buffers remain enforced', async () => {
  await reserve(await accepted());
  assert.equal((await quote(plan(8), customer)).data.code, 'RENTAL_ALREADY_BOOKED');
  const adjacent = plan(9); assert.equal((await quote(adjacent, other)).data.code, 'OUT_OF_STOCK');
  assert.equal((await quote(plan(14), customer)).status, 200);
});

test('expired unpaid holds stop being owner duplicates and stop consuming capacity', async () => {
  const input = await accepted({ ...plan(), paymentPlan: 'ADVANCE' });
  // Test fixture permits the mocked provider; no payment is sent.
  await require('./rentalPaymentFixture').configure(store);
  const b = await reserve(input); assert.equal(b.status, 200); assert.equal(b.data.status, 'HELD');
  const past = new Date(Date.now() - 1000);
  await M.Booking.updateOne({ _id: b.data._id }, { $set: { expiresAt: past } });
  await M.Reservation.updateMany({ bookingId: b.data._id }, { $set: { expiresAt: past } });
  assert.equal((await quote(plan(), customer)).status, 200);
  assert.equal((await reserve(await accepted())).status, 200);
});

test('store-approved cancellation releases capacity and permits a fresh booking', async () => {
  const b = await S.hold(store, await accepted(), customer.user);
  await S.mutateBooking(store, b._id, { action: 'CANCEL', operationId: op(), revision: b.revision, note: 'Agreed cancellation' });
  assert.equal((await quote(plan(), customer)).status, 200);
  assert.equal((await reserve(await accepted())).status, 200);
});

test('alternate offers for the same outfit cannot bypass the owner duplicate check', async () => {
  await addPiece(); const alternate = await S.saveListing(store, { ...listing, _id: undefined, title: 'Same outfit alternate offer' });
  await reserve(await accepted());
  const r = await quote(plan(7, alternate._id), customer);
  assert.equal(r.data.code, 'RENTAL_ALREADY_BOOKED'); assert.equal(await M.Booking.countDocuments(), 1);
  assert.equal((await quote(plan(7, alternate._id), other)).status, 200);
});

test('deleting a former offer does not hide the owner\'s booking of the same product', async () => {
  await addPiece(); const alternate = await S.saveListing(store, { ...listing, _id: undefined, title: 'New outfit offer' });
  const b = await reserve(await accepted()); await M.Listing.deleteOne({ _id: listing._id });
  const r = await quote(plan(7, alternate._id), customer);
  assert.equal(r.data.code, 'RENTAL_ALREADY_BOOKED'); assert.equal(r.data.details.bookingId, b.data._id);
});

test('different fitting selections can be booked independently by one customer', async () => {
  await M.Asset.updateMany({ storeId: store._id }, { $set: { size: 'M' } });
  listing = await S.saveListing(store, { ...listing, size: 'M' });
  await S.saveAsset(store, { productId: String(product._id), poolKey: 'orange', code: 'ORANGE-L', label: 'Orange L', size: 'L' });
  const large = await S.saveListing(store, { ...listing, _id: undefined, size: 'L', title: 'Orange Lehenga L' });
  await reserve(await accepted());
  assert.equal((await quote(plan(7, large._id), customer)).status, 200);
  assert.equal((await reserve(await accepted(plan(7, large._id)))).status, 200);
  assert.equal(await M.Booking.countDocuments(), 2);
});

test('duplicate detection is scoped to the boutique, even for the same signed-in customer', async () => {
  const b = await reserve(await accepted());
  const foreign = await require('../models/Store').create({ name: 'Another boutique', slug: 'another-boutique', status: 'PUBLISHED' });
  await M.Booking.updateOne({ _id: b.data._id }, { $set: { storeId: foreign._id } });
  await M.Reservation.updateMany({ bookingId: b.data._id }, { $set: { storeId: foreign._id } });
  assert.equal((await quote(plan(), customer)).status, 200);
});

test('a maintenance block has availability guidance and is never described as another customer booking', async () => {
  const asset = await M.Asset.findOne({ storeId: store._id }); const p = plan();
  await M.Reservation.create({ storeId: store._id, assetId: asset._id, kind: 'MAINTENANCE', active: true,
    blockedFrom: new Date(p.pickupAt), blockedUntil: new Date(p.returnDueAt) });
  const r = await quote(p, other); assert.equal(r.data.code, 'OUT_OF_STOCK');
  assert.match(r.data.message, /unavailable/); assert.doesNotMatch(r.data.message, /already booked/);
});
