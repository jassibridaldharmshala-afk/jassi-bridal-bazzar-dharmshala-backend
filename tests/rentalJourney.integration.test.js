require('./rentalPaymentFixture');
const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startTestEnvironment, stopTestEnvironment, resetDatabase, request } = require('./helpers');
const { createCustomer, createAdmin, createProduct, setSettings } = require('./factories');
const { ensureDefaultStore } = require('../services/storeService');
const Product = require('../models/Product');
const M = require('../models/Rental');
const S = require('../services/rentalService');
const Setup = require('../services/rentalSetupService');
const Availability = require('../services/rentalAvailabilityService');
const A = require('../services/rentalAlgorithms');
const op = () => 'journey_' + crypto.randomUUID();
let store, customer, admin, product, listing;
const dates = () => { const day = A.localKey(new Date(Date.now() + 5 * A.DAY), 'Asia/Kolkata'); const pickupAt = `${day}T10:00:00+05:30`; return { pickupAt, returnDueAt: new Date(+new Date(pickupAt) + A.DAY).toISOString() }; };
before(async () => { mock.method(require('../services/controlPlaneClient'), 'licenseStatus', async () => ({ managed: false, status: 'ACTIVE' })); await startTestEnvironment(); });
after(async () => { await stopTestEnvironment(); mock.restoreAll(); });
beforeEach(async () => {
  await resetDatabase(); store = await ensureDefaultStore(); await require('./rentalPaymentFixture').configure(store); customer = await createCustomer(); admin = await createAdmin();
  await S.saveConfiguration(store, { revision: 0, mode: 'SALE_AND_RENTAL', policy: { ...A.DEFAULT_POLICY, dateFirstEnabled: true } });
  product = await createProduct({ storeId: store._id, sku: op(), commerceMode: 'SALE_AND_RENTAL', stock: 0, sizingMode: 'free-size', sizes: [] });
  listing = await S.saveListing(store, { productId: String(product._id), title: 'Bridal look', active: false, dailyRatePaise: 150000, depositPaise: 200000, requirements: [{ poolKey: 'bridal', label: 'Outfit', quantity: 1 }] });
});
async function activate() { await Setup.registerPieces(store, String(listing._id), { operationId: op(), revision: listing.revision, componentIndex: 0, quantity: 1 }); listing = await S.saveListing(store, { ...listing, active: true }); }
async function reviewed() { const payload = { ...dates(), items: [{ listingId: String(listing._id), quantity: 1 }], attemptId: op(), acceptTerms: true, customer: {} }; const quoted = await S.publicQuote(store, payload); return { ...payload, policyRevision: quoted.policyRevision, quoteFingerprint: quoted.quoteFingerprint }; }

test('published rental design is setup-pending until actual pieces exist, without depending on sale stock', async () => {
  const pending = await S.publicListings(store, String(product._id));
  assert.equal(pending.listings.length, 0); assert(pending.readiness.reasons.some(r => r.code === 'OFFER_INACTIVE'));
  await activate();
  const live = await S.publicListings(store, String(product._id)); assert.equal(live.readiness.bookable, true); assert.equal(live.listings.length, 1); assert.deepEqual(live.listings[0].includedItems, [{ label: 'Outfit', quantity: 1 }]);
  assert.equal((await S.catalogue(store)).total, 1);
  assert.equal((await Product.findById(product._id)).stock, 0);
});
test('payment readiness and order pause reject new holds, while the original attempt can recover', async () => {
  await activate(); const input = await reviewed(); const held = await S.hold(store, input, customer.user);
  const state = await Setup.readiness(store, listing); assert.equal(state.components[0].reserved, 1); assert.equal(state.components[0].readyNow, 1);
  await setSettings({ storeId: store._id, acceptingOrders: false, orderPauseMessage: 'Closed for today', razorpayEnabled: false });
  assert.equal(String((await S.hold(store, input, customer.user))._id), String(held._id));
  await assert.rejects(() => S.hold(store, { ...input, attemptId: op() }, customer.user), /Closed for today/);
  await setSettings({ storeId: store._id, acceptingOrders: true, razorpayEnabled: false });
  await assert.rejects(() => S.hold(store, { ...input, attemptId: op() }, customer.user), /Online rental payments are unavailable/);
  assert.equal(await M.Booking.countDocuments({ storeId: store._id }), 1);
  const recovery = await request(`/api/rentals/bookings/recover/${input.attemptId}`, { token: customer.token }); assert.equal(recovery.status, 200); assert.equal(recovery.data._id, String(held._id)); assert.equal(recovery.data.allocations, undefined);
  const stranger = await createCustomer({ phone: '9000000002' }); const denied = await request(`/api/rentals/bookings/recover/${input.attemptId}`, { token: stranger.token }); assert.equal(denied.status, 404);
});
test('registering owner quantity is atomic and idempotent with stable distinct codes and unchanged sale inventory', async () => {
  const input = { operationId: op(), revision: listing.revision, componentIndex: 0, quantity: 6, location: 'Rack A', condition: 'Good' };
  const [one, two] = await Promise.all([Setup.registerPieces(store, String(listing._id), input), Setup.registerPieces(store, String(listing._id), input)]);
  assert.equal(await M.Asset.countDocuments({ storeId: store._id }), 6); assert.deepEqual(one.rows.map(r => r.code).sort(), two.rows.map(r => r.code).sort()); assert.equal(new Set(one.rows.map(r => r.code)).size, 6);
  await assert.rejects(() => Setup.registerPieces(store, String(listing._id), { ...input, quantity: 7 }), /different details/);
  assert.equal((await Product.findById(product._id)).stock, 0);
});
test('inactive variants and included components disappear from every rental collection before booking', async () => {
  await Product.updateOne({ _id: product._id }, { $set: { variants: [{ size: 'M', color: 'Red', stock: 0, isActive: true }] } });
  product = await Product.findById(product._id); const variantId = String(product.variants[0]._id);
  listing = await S.saveListing(store, { ...listing, variantId, size: 'M', colour: 'Red' }); await activate();
  await Product.updateOne({ _id: product._id, 'variants._id': variantId }, { $set: { 'variants.$.isActive': false } });
  assert.equal((await S.publicListings(store, String(product._id))).listings.length, 0); assert.equal((await S.catalogue(store)).total, 0);
  const preview = await require('../services/rentalProductPreview').enrich([product.toObject()], { store, baseUrl: '/api/products' }); assert.equal(preview[0].rentalPreview, undefined); assert.equal(preview[0].rentalStatus.live, false);
});
test('available-only ordering and pagination consider offers beyond the first thirty', async () => {
  const offers = [], assets = [];
  for (let i = 0; i < 33; i++) {
    const poolKey = `pool-${i}`;
    const asset = await S.saveAsset(store, { poolKey, productId: String(product._id), code: `PIECE-${i}`, label: `Piece ${i}` }); assets.push(asset);
    offers.push(await S.saveListing(store, { ...listing, _id: undefined, active: true, title: `Look ${String(i).padStart(2, '0')}`, requirements: [{ poolKey, label: 'Outfit', quantity: 1 }] }));
  }
  const interval = dates(); await M.Reservation.insertMany(assets.slice(0, 30).map(asset => ({ storeId: store._id, assetId: asset._id, blockedFrom: new Date(+new Date(interval.pickupAt) - A.DAY), blockedUntil: new Date(+new Date(interval.returnDueAt) + A.DAY), kind: 'MAINTENANCE' })));
  const available = await Availability.availability(store, { ...interval, availableOnly: 'true', page: '1' }); assert.equal(available.total, 3); assert.equal(available.pages, 1); assert.equal(available.rows.length, 3); assert(available.rows.every(r => r.availability === 'AVAILABLE'));
  const first = await Availability.availability(store, { ...interval, page: '1' }); assert.equal(first.total, 33); assert.equal(first.rows.length, 30); assert.equal(first.rows[0].title, 'Look 30');
});

test('an unavailable included accessory hides the entire set, even when the main design is published', async () => {
  const accessory = await createProduct({ storeId: store._id, sku: op(), commerceMode: 'RENTAL_ONLY', stock: 0 });
  listing = await S.saveListing(store, { ...listing, requirements: [{ poolKey: 'outfit', productId: String(product._id), label: 'Outfit', quantity: 1 }, { poolKey: 'necklace', productId: String(accessory._id), label: 'Necklace', quantity: 1 }] });
  for (const componentIndex of [0, 1]) await Setup.registerPieces(store, String(listing._id), { operationId: op(), revision: listing.revision, componentIndex, quantity: 1 });
  listing = await S.saveListing(store, { ...listing, active: true });
  assert.equal((await S.catalogue(store)).total, 1);
  await Product.updateOne({ _id: accessory._id }, { $set: { isActive: false } });
  assert.equal((await S.catalogue(store)).total, 0);
  assert.equal((await S.publicListings(store, String(product._id))).listings.length, 0);
});
test('rental-only shop uses actual eligible offers across collections without relabelling legacy sale items', async () => {
  const legacy = await createProduct({ storeId: store._id, sku: op(), commerceMode: 'SALE_ONLY', stock: 5 });
  await activate(); const config = await S.readConfiguration(store);
  await S.saveConfiguration(store, { ...config, mode: 'RENTAL_ONLY' });
  const publicFilter = await require('../services/catalogCommerceService').publicFilter({ store, query: {} });
  const rows = await Product.find({ $and: [{ storeId: store._id }, publicFilter] }).lean();
  assert.deepEqual(rows.map(row => String(row._id)), [String(product._id)]);
  assert.equal((await Product.findById(legacy._id)).commerceMode, 'SALE_ONLY');
});
test('similar products stay tenant scoped and shared display images remain referenced by other records', async () => {
  const master = 'https://media.example/master.jpg', display = 'https://media.example/640.webp';
  await Product.updateOne({ _id: product._id }, { $set: { name: 'Red bridal lehenga', images: [{ url: master, variants: [{ url: display, width: 640, height: 800 }] }] } });
  const foreign = await require('../models/Store').create({ name: 'Foreign shop', slug: 'foreign-shop', owner: admin.user._id });
  await createProduct({ storeId: foreign._id, sku: op(), name: 'Red bridal lehenga' });
  const similar = await require('../services/productSimilarityService').similar(store, { name: 'Red bridal lehenga' }, {}, [master]);
  assert.deepEqual(similar.map(row => row._id), [String(product._id)]);
  assert.equal(similar[0].reason, 'Same uploaded photo');
  assert.equal(await require('../services/mediaReferenceService').referenced({ url: display }), true);
  assert.equal(await require('../services/mediaReferenceService').referenced({ url: 'https://media.example/unreferenced.webp' }), false);
});
