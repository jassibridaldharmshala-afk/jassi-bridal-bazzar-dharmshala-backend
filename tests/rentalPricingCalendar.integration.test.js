require('./rentalPaymentFixture');
const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startTestEnvironment, stopTestEnvironment, resetDatabase, request } = require('./helpers');
const { createCustomer, createAdmin, createProduct } = require('./factories');
const { ensureDefaultStore } = require('../services/storeService');
const M = require('../models/Rental');
const Product = require('../models/Product');
const Store = require('../models/Store');
const S = require('../services/rentalService');
const A = require('../services/rentalAlgorithms');
const C = require('../services/rentalCalendarService');
let store, product, listing, customer, admin;
const op = () => `test_${crypto.randomUUID()}`;
const dates = () => {
  const day = A.localKey(new Date(Date.now() + 4 * A.DAY), 'Asia/Kolkata');
  const pickupAt = `${day}T10:00:00+05:30`;
  return { pickupAt, returnDueAt: new Date(+new Date(pickupAt) + 2 * A.DAY).toISOString() };
};
before(async () => {
  mock.method(require('../services/controlPlaneClient'), 'licenseStatus', async () => ({ managed: false, status: 'ACTIVE' }));
  await startTestEnvironment();
});
after(async () => { await stopTestEnvironment(); mock.restoreAll(); });
beforeEach(async () => {
  await resetDatabase(); store = await ensureDefaultStore(); await require('./rentalPaymentFixture').configure(store); customer = await createCustomer(); admin = await createAdmin();
  product = await createProduct({ storeId: store._id, sku: op(), commerceMode: 'SALE_AND_RENTAL', sizingMode: 'free-size', sizes: [] });
  await S.saveConfiguration(store, { revision: 0, mode: 'SALE_AND_RENTAL', policy: { ...A.DEFAULT_POLICY } }, admin.user._id);
  await S.saveAsset(store, { productId: String(product._id), poolKey: 'bridal-piece', code: 'BRIDAL-01', label: 'Physical outfit' });
  listing = await S.saveListing(store, { productId: String(product._id), title: 'Bridal look', active: true, dailyRatePaise: 100000, depositPaise: 300000, advanceMode: 'PERCENT', advancePercent: 50, cleaningFeePaise: 10000, packages: [{ days: 2, pricePaise: 150000 }], requirements: [{ poolKey: 'bridal-piece', label: 'Bridal outfit', quantity: 1 }] }, admin.user._id);
});
async function hold() {
  const payload = { ...dates(), items: [{ listingId: String(listing._id), quantity: 1 }], attemptId: op(), acceptTerms: true, policyRevision: 1, customer: {} };
  const quote = await S.publicQuote(store, payload);
  return S.hold(store, { ...payload, quoteFingerprint: quote.quoteFingerprint }, customer.user);
}
const pricing = () => ({ listingId: String(listing._id), revision: listing.revision, dailyRatePaise: 125000, depositPaise: 400000, advanceMode: 'FIXED', advanceAmountPaise: 20000 });
const calendar = () => C.calendar(store, String(listing._id), { month: dates().pickupAt.slice(0, 7), days: '2' });

test('sale price and selected rental offer save together without replacing packages or stock', async () => {
  const result = await request(`/api/admin/products/${product._id}`, { method: 'PUT', token: admin.token, body: { price: 2200, originalPrice: 2500, commerceMode: 'SALE_AND_RENTAL', rentalPricing: pricing() } });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.price, 2200);
  const saved = await M.Listing.findById(listing._id);
  assert.equal(saved.dailyRatePaise, 125000); assert.equal(saved.depositPaise, 400000); assert.equal(saved.advanceAmountPaise, 20000);
  assert.equal(saved.active, true); assert.equal(saved.packages[0].pricePaise, 150000); assert.equal(saved.cleaningFeePaise, 10000);
  assert.equal((await Product.findById(product._id)).stock, 10);
  const detail = await request(`/api/admin/products/${product._id}`, { token: admin.token });
  assert.equal(detail.data.rentalOffers[0].dailyRatePaise, 125000);
  const quote = await S.publicQuote(store, { ...dates(), items: [{ listingId: String(listing._id), quantity: 1 }] });
  assert.equal(quote.quote.rentalPaise, 160000); assert.equal(quote.quote.advanceRentPaise, 20000); assert.equal(quote.quote.depositPaise, 400000);
});
test('stale or foreign rental pricing rolls back the product update', async () => {
  const result = await request(`/api/admin/products/${product._id}`, { method: 'PUT', token: admin.token, body: { price: 1200, rentalPricing: { ...pricing(), revision: 88 } } });
  assert.equal(result.status, 409, JSON.stringify(result.data));
  assert.equal((await Product.findById(product._id)).price, 1000);
  assert.equal((await M.Listing.findById(listing._id)).dailyRatePaise, 100000);
});
test('a new mixed product saves its declared rental pieces separately from sale stock', async () => {
  const result = await request('/api/admin/products', { method: 'POST', token: admin.token, body: { name: 'New bridal jewellery', sku: op(), category: String(product.category), price: 5000, originalPrice: 6000, stock: 3, sizes: [], sizingMode: 'free-size', commerceMode: 'SALE_AND_RENTAL', images: [{ url: 'https://example.test/bridal.webp', primary: true }], rentalPricing: { dailyRatePaise: 75000, depositPaise: 100000, advanceMode: 'STORE', inventory: [{ componentIndex: 0, quantity: 2 }] } } });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  const offer = await M.Listing.findOne({ productId: result.data._id });
  assert.equal(result.data.price, 5000); assert.equal(offer.dailyRatePaise, 75000); assert.equal(offer.active, true); assert.equal(offer.publicationOrigin, 'PRODUCT');
  assert.equal(await M.Asset.countDocuments({ productId: result.data._id }), 2);
  assert.equal(result.data.rentalOffers[0].ready, true);
});
test('draft publication retains mixed mode and its separate rental pricing', async () => {
  const draft = await request('/api/admin/product-drafts', { method: 'POST', token: admin.token, body: { name: 'Draft bridal gown', sku: op(), category: String(product.category), price: 4000, originalPrice: 5000, stock: 0, sizingMode: 'free-size', commerceMode: 'SALE_AND_RENTAL', images: [{ url: 'https://example.test/gown.webp' }], rentalPricing: { dailyRatePaise: 50000, depositPaise: 200000, advanceMode: 'PERCENT', advancePercent: 25, inventory: [{ componentIndex: 0, quantity: 1 }] } } });
  assert.equal(draft.status, 201, JSON.stringify(draft.data));
  const result = await request('/api/admin/product-drafts/publish-selected', { method: 'POST', token: admin.token, body: { ids: [draft.data.data.id || draft.data.data._id] } });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const saved = result.data.data.products[0];
  assert.equal(saved.price, 4000); assert.equal(saved.commerceMode, 'SALE_AND_RENTAL');
  const offer = await M.Listing.findOne({ productId: saved._id });
  assert.equal(offer.dailyRatePaise, 50000); assert.equal(offer.advancePercent, 25); assert.equal(offer.active, true); assert.equal(offer.publicationOrigin, 'PRODUCT');
});
test('incomplete rental prices can be drafted but cannot be published', async () => {
  const draft = await request('/api/admin/product-drafts', { method: 'POST', token: admin.token, body: { name: 'Incomplete rental look', category: String(product.category), price: 4000, originalPrice: 5000, stock: 0, commerceMode: 'RENTAL_ONLY', images: [{ url: 'https://example.test/look.webp' }] } });
  assert.equal(draft.status, 201, JSON.stringify(draft.data));
  assert.ok(draft.data.data.readiness.issues.includes('Enter rental pricing.'));
  const result = await request('/api/admin/product-drafts/publish-selected', { method: 'POST', token: admin.token, body: { ids: [draft.data.data.id || draft.data.data._id] } });
  assert.equal(result.status, 400); assert.match(result.data.message, /rental pricing/);
  assert.equal(await Product.countDocuments({ name: 'Incomplete rental look' }), 0);
});
test('calendar accounts for held pieces and preparation/cleaning buffers without exposing customers', async () => {
  const booking = await hold();
  const result = await request(`/api/rentals/calendar/${listing._id}?month=${dates().pickupAt.slice(0, 7)}&days=2`);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const day = dates().pickupAt.slice(0, 10);
  assert.equal(result.data.rows.find(row => row.date === day).status, 'UNAVAILABLE');
  assert.deepEqual(result.data.rows.find(row => row.date === day).availability, [{ listingId: String(listing._id), title: listing.title, requestedQuantity: 1, totalQuantity: 1, availableQuantity: 0, bookedQuantity: 1, blockedQuantity: 0 }]);
  const afterReturn = A.localKey(new Date(+booking.schedule.returnDueAt + A.DAY), booking.policy.timezone);
  if (afterReturn.startsWith(result.data.month)) assert.equal(result.data.rows.find(row => row.date === afterReturn).status, 'UNAVAILABLE');
  const safe = JSON.stringify(result.data);
  for (const secret of [String(booking._id), booking.number, customer.user.phone, customer.user.name, 'assetId', 'allocations']) assert.equal(safe.includes(secret), false);
  assert.equal(result.data.availabilityIsAdvisory, true);
});
test('another matching piece remains available, but requesting two sets conflicts', async () => {
  await hold();
  await S.saveAsset(store, { productId: String(product._id), poolKey: 'bridal-piece', code: 'BRIDAL-02', label: 'Second outfit' });
  const one = await calendar();
  assert.equal(one.rows.find(row => row.date === dates().pickupAt.slice(0, 10)).status, 'AVAILABLE');
  assert.equal(one.rows.find(row => row.date === dates().pickupAt.slice(0, 10)).availability[0].bookedQuantity, 1);
  assert.equal(one.rows.find(row => row.date === dates().pickupAt.slice(0, 10)).availability[0].availableQuantity, 1);
  const two = await C.calendar(store, listing._id, { month: dates().pickupAt.slice(0, 7), days: 2, quantity: 2 });
  assert.equal(two.rows.find(row => row.date === dates().pickupAt.slice(0, 10)).status, 'UNAVAILABLE');
});

test('authenticated calendar identifies only the viewer own booking even with spare capacity, and ignores forged customer IDs', async () => {
  const booking = await hold();
  await S.saveAsset(store, { productId: String(product._id), poolKey: 'bridal-piece', code: 'BRIDAL-02', label: 'Second outfit' });
  const path = `/api/rentals/calendar/${listing._id}?month=${dates().pickupAt.slice(0, 7)}&days=2`;
  const own = await request(path, { token: customer.token });
  assert.equal(own.status, 200, JSON.stringify(own.data));
  const row = own.data.rows.find(row => row.date === dates().pickupAt.slice(0, 10));
  assert.equal(row.status, 'ALREADY_BOOKED'); assert.equal(row.ownBooking.id, String(booking._id));
  assert.equal(row.ownBooking.status, 'HELD'); assert.equal(row.availability[0].availableQuantity, 1);
  const stranger = await createCustomer();
  for (const token of [undefined, stranger.token]) {
    const response = await request(path + '&customerUserId=' + customer.user._id, { token });
    assert.equal(response.status, 200);
    assert.equal(response.data.rows.find(row => row.date === dates().pickupAt.slice(0, 10)).status, 'AVAILABLE');
    for (const secret of [String(booking._id), booking.number, customer.user.phone, 'ownBooking']) assert.equal(JSON.stringify(response.data).includes(secret), false);
  }
  assert.equal((await request(path, { token: 'invalid-token' })).status, 401);
});

test('calendar counts cleaning and maintenance separately and returns released inventory after cancellation', async () => {
  const booking = await hold();
  const spare = await S.saveAsset(store, { productId: String(product._id), poolKey: 'bridal-piece', code: 'BRIDAL-02', label: 'Second outfit' });
  await S.changeAsset(store, spare._id, { operationId: op(), revision: spare.revision, status: 'CLEANING' });
  const before = await calendar(), day = dates().pickupAt.slice(0, 10);
  assert.deepEqual(before.rows.find(row => row.date === day).availability[0], { listingId: String(listing._id), title: listing.title, requestedQuantity: 1, totalQuantity: 2, availableQuantity: 0, bookedQuantity: 1, blockedQuantity: 1 });
  await S.mutateBooking(store, booking._id, { action: 'CANCEL', operationId: op(), revision: booking.revision, note: 'Cancelled by agreement' });
  const after = await request(`/api/rentals/calendar/${listing._id}?month=${dates().pickupAt.slice(0, 7)}&days=2`, { token: customer.token });
  const released = after.data.rows.find(row => row.date === day);
  assert.equal(released.status, 'AVAILABLE'); assert.equal(released.ownBooking, undefined);
  assert.equal(released.availability[0].availableQuantity, 1); assert.equal(released.availability[0].bookedQuantity, 0);
});
test('expired holds release calendar availability; calendar remains scoped to its store', async () => {
  const booking = await hold();
  await M.Reservation.updateMany({ bookingId: booking._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  const value = await calendar();
  assert.equal(value.rows.find(row => row.date === dates().pickupAt.slice(0, 10)).status, 'AVAILABLE');
  const other = await Store.create({ name: 'Other shop', slug: op().toLowerCase() });
  await assert.rejects(() => C.calendar(other, listing._id, {}), /unavailable/);
  await assert.rejects(() => C.calendar(store, listing._id, { month: '2026-99' }), /valid calendar month/);
  const stranger = await createCustomer();
  const denied = await request(`/api/rentals/bookings/${booking._id}`, { token: stranger.token });
  assert.equal(denied.status, 404);
});

test('a whole month has a fixed database read budget, including a customer with an existing booking', async () => {
  await hold();
  const mongoose = require('mongoose'), original = mongoose.Query.prototype.exec;
  let reads = [];
  const spy = mock.method(mongoose.Query.prototype, 'exec', function (...args) {
    reads.push(`${this.model.modelName}.${this.op}`);
    return original.apply(this, args);
  });
  try {
    const guest = await calendar();
    assert.ok(guest.rows.length >= 28);
    assert.equal(reads.length, 8, JSON.stringify(reads));
    for (const name of ['RentalAsset.find', 'RentalReservation.find', 'RentalTask.find', 'RentalBooking.find', 'Product.find']) assert.equal(reads.filter(r => r === name).length, 1);
    reads = [];
    const own = await C.calendar(store, listing._id, { month: dates().pickupAt.slice(0, 7), days: 2 }, { customerUserId: customer.user._id });
    assert.equal(reads.length, 10, JSON.stringify(reads));
    assert.equal(own.rows.find(r => r.date === dates().pickupAt.slice(0, 10)).status, 'ALREADY_BOOKED');
  } finally { spy.mock.restore(); }
});

test('batched calendar matches fresh quotes for every date with maintenance, overdue work, expired reservations and occupied slots', async () => {
  await S.saveConfiguration(store, { revision: 1, mode: 'SALE_AND_RENTAL', policy: { ...A.DEFAULT_POLICY, slotCapacity: 1 } });
  const extra = [];
  for (let i = 2; i <= 4; i += 1) extra.push(await S.saveAsset(store, { productId: String(product._id), poolKey: 'bridal-piece', code: `BRIDAL-0${i}`, label: `Outfit ${i}` }));
  const plan = dates(), start = new Date(plan.pickupAt), end = new Date(plan.returnDueAt);
  await M.Reservation.create([
    { storeId: store._id, assetId: extra[0]._id, blockedFrom: start, blockedUntil: end, kind: 'MAINTENANCE' },
    { storeId: store._id, assetId: extra[1]._id, blockedFrom: start, blockedUntil: end, kind: 'BOOKING', expiresAt: new Date(Date.now() - 1000) },
  ]);
  await M.Task.create({ storeId: store._id, assetId: extra[2]._id, operationId: op(), type: 'REPAIR', dueAt: new Date(Date.now() - 1000) });
  await M.Booking.create([
    { storeId: store._id, number: op(), attemptId: op(), fingerprint: op(), status: 'CONFIRMED', schedule: { pickupAt: start, returnDueAt: end } },
    { storeId: store._id, number: op(), attemptId: op(), fingerprint: op(), status: 'CONFIRMED', trial: { at: new Date(+end + A.DAY - A.HOUR), until: new Date(+end + A.DAY + A.HOUR), status: 'ATTENDED' } },
    { storeId: store._id, number: op(), attemptId: op(), fingerprint: op(), status: 'HELD', expiresAt: new Date(Date.now() - 1000), schedule: { pickupAt: new Date(+end + 2 * A.DAY) } },
    { storeId: store._id, number: op(), attemptId: op(), fingerprint: op(), status: 'CONFIRMED', trial: { at: new Date(+end + 3 * A.DAY) } },
  ]);
  const result = await calendar();
  const X = require('../services/rentalStudioAlgorithms');
  for (const row of result.rows) {
    const returnDate = new Date(Date.parse(`${row.date}T12:00Z`) + 2 * A.DAY).toISOString().slice(0, 10);
    const input = { pickupAt: X.localInstant(`${row.date}T10:00`, result.timezone).toISOString(), returnDueAt: X.localInstant(`${returnDate}T10:00`, result.timezone).toISOString(), items: result.items };
    let fresh;
    try { fresh = await S.publicQuote(store, input, { includeAvailability: true }); }
    catch (error) {
      assert.equal(row.status, error.errorCode === 'OUT_OF_STOCK' ? 'UNAVAILABLE' : 'UNBOOKABLE', row.date);
      assert.equal(row.reason, error.message, row.date);
      assert.deepEqual(row.availability, error.details?.availability, row.date);
      continue;
    }
    assert.equal(row.status, 'AVAILABLE', row.date);
    assert.deepEqual(row.availability, fresh.availability, row.date);
    assert.equal(row.rentalPaise, fresh.quote.rentalPaise, row.date);
    assert.equal(row.depositPaise, fresh.quote.depositPaise, row.date);
    assert.equal(row.dueNowPaise, fresh.quote.dueNowPaise, row.date);
  }
  assert.equal(result.rows.find(r => r.date === plan.pickupAt.slice(0, 10)).status, 'UNAVAILABLE');
  assert.ok(result.rows.some(r => r.status === 'AVAILABLE'));
});

test('full-set calendar cannot allocate one shared physical piece to two offers', async () => {
  const second = await S.saveListing(store, { ...listing, _id: undefined, title: 'Another offer for the same outfit' });
  const query = { month: dates().pickupAt.slice(0, 7), days: 2, items: [listing, second].map(l => ({ listingId: String(l._id), quantity: 1 })) };
  const before = await C.calendarSet(store, query), day = dates().pickupAt.slice(0, 10);
  const blocked = before.rows.find(r => r.date === day);
  assert.equal(blocked.status, 'UNAVAILABLE');
  const input = { ...dates(), items: query.items };
  await assert.rejects(() => S.publicQuote(store, input, { includeAvailability: true }), error => {
    assert.deepEqual(blocked.availability, error.details.availability); return error.errorCode === 'OUT_OF_STOCK';
  });
  await S.saveAsset(store, { productId: String(product._id), poolKey: 'bridal-piece', code: 'BRIDAL-02', label: 'Second outfit' });
  const after = await C.calendarSet(store, query);
  assert.equal(after.rows.find(r => r.date === day).status, 'AVAILABLE');
});

test('month boundaries include prior bookings and preparation/cleaning beyond the month', async () => {
  const now = new Date(), first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const month = first.toISOString().slice(0, 7), pickup = new Date(+first - A.DAY).toISOString().slice(0, 10);
  const input = { pickupAt: `${pickup}T10:00:00+05:30`, returnDueAt: `${month}-02T10:00:00+05:30`, items: [{ listingId: String(listing._id), quantity: 1 }] };
  const q = await S.publicQuote(store, input);
  const booking = await S.hold(store, { ...input, attemptId: op(), acceptTerms: true, policyRevision: q.policyRevision, quoteFingerprint: q.quoteFingerprint, customer: {} }, customer.user);
  const result = await C.calendar(store, listing._id, { month, days: 1 }, { customerUserId: customer.user._id });
  assert.equal(result.rows[0].status, 'ALREADY_BOOKED');
  assert.equal(result.rows[0].ownBooking.id, String(booking._id));
  assert.equal(result.rows[1].status, 'UNAVAILABLE');
  assert.equal(result.rows[2].status, 'UNAVAILABLE');
  assert.equal(result.rows[3].status, 'AVAILABLE');
});
