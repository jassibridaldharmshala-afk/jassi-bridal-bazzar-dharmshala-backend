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
  await resetDatabase(); store = await ensureDefaultStore(); customer = await createCustomer(); admin = await createAdmin();
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
test('a new mixed product saves two prices and creates an inactive offer without fake rental pieces', async () => {
  const result = await request('/api/admin/products', { method: 'POST', token: admin.token, body: { name: 'New bridal jewellery', sku: op(), category: String(product.category), price: 5000, originalPrice: 6000, stock: 3, sizes: [], sizingMode: 'free-size', commerceMode: 'SALE_AND_RENTAL', images: [{ url: 'https://example.test/bridal.webp', primary: true }], rentalPricing: { dailyRatePaise: 75000, depositPaise: 100000, advanceMode: 'STORE' } } });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  const offer = await M.Listing.findOne({ productId: result.data._id });
  assert.equal(result.data.price, 5000); assert.equal(offer.dailyRatePaise, 75000); assert.equal(offer.active, false);
  assert.equal(await M.Asset.countDocuments({ productId: result.data._id }), 0);
});
test('draft publication retains mixed mode and its separate rental pricing', async () => {
  const draft = await request('/api/admin/product-drafts', { method: 'POST', token: admin.token, body: { name: 'Draft bridal gown', sku: op(), category: String(product.category), price: 4000, originalPrice: 5000, stock: 0, sizingMode: 'free-size', commerceMode: 'SALE_AND_RENTAL', images: [{ url: 'https://example.test/gown.webp' }], rentalPricing: { dailyRatePaise: 50000, depositPaise: 200000, advanceMode: 'PERCENT', advancePercent: 25 } } });
  assert.equal(draft.status, 201, JSON.stringify(draft.data));
  const result = await request('/api/admin/product-drafts/publish-selected', { method: 'POST', token: admin.token, body: { ids: [draft.data.data.id || draft.data.data._id] } });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const saved = result.data.data.products[0];
  assert.equal(saved.price, 4000); assert.equal(saved.commerceMode, 'SALE_AND_RENTAL');
  const offer = await M.Listing.findOne({ productId: saved._id });
  assert.equal(offer.dailyRatePaise, 50000); assert.equal(offer.advancePercent, 25); assert.equal(offer.active, false);
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
  const two = await C.calendar(store, listing._id, { month: dates().pickupAt.slice(0, 7), days: 2, quantity: 2 });
  assert.equal(two.rows.find(row => row.date === dates().pickupAt.slice(0, 10)).status, 'UNAVAILABLE');
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
