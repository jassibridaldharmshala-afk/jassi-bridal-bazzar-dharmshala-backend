require('./rentalPaymentFixture');
const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const H = require('./helpers'), F = require('./factories');
const M = require('../models/Rental'), Product = require('../models/Product');
const S = require('../services/rentalService'), A = require('../services/rentalAlgorithms');
let store, admin, category;
const op = () => 'setup_' + crypto.randomUUID();
const inventory = (quantity, extra = {}) => [{ componentIndex: 0, quantity, location: 'A-01', status: 'READY', ...extra }];
const pricing = (quantity = 2, extra = {}) => ({ dailyRatePaise: 75000, depositPaise: 50000, advanceMode: 'STORE', inventory: inventory(quantity), ...extra });
const body = (extra = {}) => ({ name: 'Complete rental outfit', sku: op(), category: String(category), price: 5000, originalPrice: 6000, stock: 7, sizingMode: 'free-size', sizes: [], commerceMode: 'SALE_AND_RENTAL', images: [{ url: 'https://example.test/outfit.webp', primary: true }], rentalPricing: pricing(), ...extra });
const create = input => H.request('/api/admin/products', { method: 'POST', token: admin.token, body: input || body() });
const update = (product, offer, changes = {}) => H.request('/api/admin/products/' + product._id, { method: 'PUT', token: admin.token, body: { price: 5500, rentalPricing: { ...pricing(), listingId: String(offer._id), revision: offer.revision, ...changes } } });
before(async () => { await H.startTestEnvironment(); });
after(async () => { await H.stopTestEnvironment(); mock.restoreAll(); });
beforeEach(async () => {
  await H.resetDatabase();
  store = await require('../services/storeService').ensureDefaultStore();
  await require('./rentalPaymentFixture').configure(store);
  admin = await F.createAdmin(); category = (await F.createProduct()).category;
  await S.saveConfiguration(store, { revision: 0, mode: 'SALE_AND_RENTAL', policy: { ...A.DEFAULT_POLICY } });
});

test('adding a rental or mixed product saves charges and declared pieces ready for bookings in one request', async () => {
  for (const commerceMode of ['RENTAL_ONLY', 'SALE_AND_RENTAL']) {
    const response = await create(body({ name: `Complete ${commerceMode} outfit`, commerceMode, stock: commerceMode === 'RENTAL_ONLY' ? 0 : 7, rentalPricing: pricing(3) }));
    assert.equal(response.status, 201, JSON.stringify(response.data));
    const product = response.data, offer = product.rentalOffers[0];
    assert.equal(product.price, 5000); assert.equal(offer.dailyRatePaise, 75000);
    assert.equal(offer.ready, true); assert.equal(offer.live, true);
    assert.equal(offer.pieces[0].configured, 3); assert.equal(offer.reasons.length, 0);
    const pieces = await M.Asset.find({ productId: product._id }).lean();
    assert.equal(pieces.length, 3); assert.equal(new Set(pieces.map(piece => piece.code)).size, 3);
    assert(pieces.every(piece => piece.location === 'A-01' && piece.status === 'READY' && String(piece.storeId) === String(store._id)));
    assert.equal((await Product.findById(product._id)).stock, commerceMode === 'RENTAL_ONLY' ? 0 : 7);
  }
});

test('partial rental drafts stay editable, but publishing requires pieces and retries create them once', async () => {
  const partial = body({ stock: 0 }); delete partial.rentalPricing.inventory;
  const draft = await H.request('/api/admin/product-drafts', { method: 'POST', token: admin.token, body: partial });
  assert.equal(draft.status, 201, JSON.stringify(draft.data));
  assert(draft.data.data.readiness.issues.some(issue => /physical rental pieces/.test(issue)));
  const id = draft.data.data.id || draft.data.data._id;
  const publish = () => H.request('/api/admin/product-drafts/publish-selected', { method: 'POST', token: admin.token, body: { ids: [id] } });
  assert.equal((await publish()).status, 400);
  assert.equal(await Product.countDocuments({ sourceDraftId: id }), 0);
  const saved = await H.request('/api/admin/product-drafts/' + id, { method: 'PUT', token: admin.token, body: { rentalPricing: pricing(2) } });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const responses = await Promise.all([publish(), publish()]);
  for (const response of responses) assert.equal(response.status, 200, JSON.stringify(response.data));
  const retry = await publish(); assert.equal(retry.status, 200);
  const product = retry.data.data.products[0];
  assert.equal(product.rentalOffers[0].ready, true);
  assert.equal(await M.Listing.countDocuments({ productId: product._id }), 1);
  assert.equal(await M.Asset.countDocuments({ productId: product._id }), 2);
});

test('saving a price or increasing pieces preserves existing conditions, locations and reservations', async () => {
  const created = await create(); assert.equal(created.status, 201);
  const product = created.data, offer = product.rentalOffers[0];
  const pieces = await M.Asset.find({ productId: product._id }).sort({ code: 1 }).lean();
  const bookingId = new mongoose.Types.ObjectId();
  await M.Asset.updateOne({ _id: pieces[0]._id }, { $set: { status: 'OUT', currentBookingId: bookingId } });
  await M.Asset.updateOne({ _id: pieces[1]._id }, { $set: { status: 'CLEANING', condition: 'Cleaning after return' } });
  await M.Reservation.create({ storeId: store._id, assetId: pieces[0]._id, bookingId, blockedFrom: new Date(), blockedUntil: new Date(Date.now() + 10 * A.DAY) });
  let response = await update(product, offer, { dailyRatePaise: 90000, inventory: inventory(2, { location: 'B-02', status: 'READY' }) });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(await M.Asset.countDocuments({ productId: product._id }), 2);
  response = await update(product, response.data.rentalOffers[0], { inventory: inventory(3, { location: 'B-02', status: 'REPAIR' }) });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  const unchanged = await M.Asset.findById(pieces[0]._id).lean();
  assert.equal(unchanged.status, 'OUT'); assert.equal(unchanged.location, 'A-01'); assert.equal(String(unchanged.currentBookingId), String(bookingId));
  assert.equal((await M.Asset.findById(pieces[1]._id)).status, 'CLEANING');
  const added = await M.Asset.findOne({ productId: product._id, location: 'B-02' });
  assert.equal(added.status, 'REPAIR'); assert.equal(added.condition, 'Needs repair');
  assert.equal(await M.Reservation.countDocuments({ bookingId, active: true }), 1);
  const repeated = await update(product, response.data.rentalOffers[0], { inventory: inventory(3) });
  assert.equal(repeated.status, 200); assert.equal(await M.Asset.countDocuments({ productId: product._id }), 3);
});

test('invalid, excessive, reduced or stale piece counts cannot partly change product or prices', async () => {
  for (const value of [undefined, [], inventory(0), inventory(1.5), inventory(101), [inventory(1)[0], inventory(1)[0]]]) {
    const input = body(); input.rentalPricing.inventory = value;
    const response = await create(input);
    assert.equal(response.status, 400, JSON.stringify(response.data));
    assert.equal(await Product.countDocuments({ sku: input.sku }), 0);
  }
  const created = await create(), product = created.data, offer = product.rentalOffers[0];
  for (const changes of [{ inventory: inventory(1) }, { inventory: inventory(103) }, { inventory: [{ componentIndex: 1, quantity: 2 }] }, { inventory: inventory(3), revision: 999 }]) {
    const response = await update(product, offer, changes);
    assert([400, 409].includes(response.status), JSON.stringify(response.data));
    assert.equal((await Product.findById(product._id)).price, 5000);
    assert.equal((await M.Listing.findById(offer._id)).revision, offer.revision);
    assert.equal(await M.Asset.countDocuments({ productId: product._id }), 2);
  }
});

test('new cleaning or repair pieces are registered without advertising date availability', async () => {
  for (const status of ['CLEANING', 'REPAIR']) {
    const response = await create(body({ name: `${status} rental outfit`, rentalPricing: pricing(1, { inventory: inventory(1, { status }) }) }));
    assert.equal(response.status, 201, JSON.stringify(response.data));
    const offer = response.data.rentalOffers[0]; assert.equal(offer.ready, true);
    const day = A.localKey(new Date(Date.now() + 7 * A.DAY), 'Asia/Kolkata');
    const calendar = await require('../services/rentalCalendarService').calendar(store, offer._id, { month: day.slice(0, 7), days: 1 });
    assert.equal(calendar.rows.find(row => row.date === day).status, 'UNAVAILABLE');
  }
});

test('enabling rental reuses this store\'s matching physical pieces and only adds the shortfall', async () => {
  const product = await F.createProduct({ storeId: store._id, sku: op(), commerceMode: 'SALE_ONLY', sizingMode: 'free-size', sizes: [] });
  const existing = await S.saveAsset(store, { productId: product._id, poolKey: 'legacy-pieces', code: 'EXISTING-01', label: 'Existing outfit', location: 'Old rack' });
  await M.Asset.updateOne({ _id: existing._id }, { $set: { status: 'OUT' } });
  const foreignStore = await require('../models/Store').create({ name: 'Other boutique', slug: op().toLowerCase() });
  await M.Asset.create({ storeId: foreignStore._id, productId: product._id, poolKey: 'legacy-pieces', code: 'FOREIGN-01', label: 'Foreign piece' });
  const response = await H.request('/api/admin/products/' + product._id, { method: 'PUT', token: admin.token, body: { commerceMode: 'SALE_AND_RENTAL', rentalPricing: pricing(2) } });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.data.rentalOffers[0].pieces[0].configured, 2);
  assert.equal(await M.Asset.countDocuments({ storeId: store._id, productId: product._id }), 2);
  const preserved = await M.Asset.findById(existing._id);
  assert.equal(preserved.status, 'OUT'); assert.equal(preserved.location, 'Old rack');
  assert.equal(await M.Asset.countDocuments({ storeId: foreignStore._id }), 1);
});

test('editing a component offer registers each product and variant in its own inventory pool', async () => {
  const product = await F.createProduct({ storeId: store._id, sku: op(), commerceMode: 'RENTAL_ONLY', sizingMode: 'free-size', sizes: [], variants: [{ size: 'M', color: 'Red', stock: 0, isActive: true }] });
  const accessory = await F.createProduct({ storeId: store._id, commerceMode: 'RENTAL_ONLY' });
  const variantId = String(product.variants[0]._id);
  const listing = await S.saveListing(store, { productId: product._id, title: 'Complete set', active: false, dailyRatePaise: 75000, depositPaise: 0, requirements: [
    { poolKey: 'outfit-component', productId: product._id, variantId, size: 'M', colour: 'Red', label: 'Outfit', quantity: 1 },
    { poolKey: 'jewellery-component', productId: accessory._id, label: 'Jewellery', quantity: 1 },
  ] });
  const response = await update(product, listing, { inventory: [{ componentIndex: 0, quantity: 2 }, { componentIndex: 1, quantity: 1 }] });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  const outfits = await M.Asset.find({ poolKey: 'outfit-component' }).lean();
  assert.equal(outfits.length, 2); assert(outfits.every(piece => String(piece.productId) === String(product._id) && piece.variantId === variantId && piece.size === 'M' && piece.colour === 'Red'));
  const jewellery = await M.Asset.findOne({ poolKey: 'jewellery-component' });
  assert.equal(String(jewellery.productId), String(accessory._id));
  assert.equal(response.data.rentalOffers[0].active, false);
});

test('a piece write failure rolls back the product, offer and sale opening inventory; retry succeeds', async () => {
  const input = body();
  const interrupted = mock.method(M.Asset, 'insertMany', async () => { throw new Error('Synthetic piece registration interruption'); });
  try { assert.equal((await create(input)).status, 500); } finally { interrupted.mock.restore(); }
  assert.equal(await Product.countDocuments({ sku: input.sku }), 0);
  assert.equal(await M.Listing.countDocuments({ title: input.name }), 0);
  assert.equal(await require('../models/InventoryTransaction').countDocuments(), 0);
  const response = await create(input); assert.equal(response.status, 201, JSON.stringify(response.data));
  assert.equal(await M.Asset.countDocuments({ productId: response.data._id }), 2);
});
