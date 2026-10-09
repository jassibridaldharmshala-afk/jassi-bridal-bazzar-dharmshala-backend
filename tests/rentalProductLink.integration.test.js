require('./rentalPaymentFixture');
const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const H = require('./helpers'), F = require('./factories');
const M = require('../models/Rental'), Product = require('../models/Product'), Store = require('../models/Store');
const S = require('../services/rentalService'), A = require('../services/rentalAlgorithms');
const Link = require('../services/rentalProductLink');
let store, admin, customer, category;
const op = () => 'link_' + crypto.randomUUID();
const dates = () => {
  const day = A.localKey(new Date(Date.now() + 7 * A.DAY), 'Asia/Kolkata');
  return { pickupAt: day + 'T10:00:00+05:30', returnDueAt: new Date(+new Date(day + 'T10:00:00+05:30') + 2 * A.DAY).toISOString() };
};
before(async () => {
  mock.method(require('../services/controlPlaneClient'), 'licenseStatus', async () => ({ managed: false, status: 'ACTIVE' }));
  await H.startTestEnvironment();
});
after(async () => { await H.stopTestEnvironment(); mock.restoreAll(); });
beforeEach(async () => {
  await H.resetDatabase(); store = await require('../services/storeService').ensureDefaultStore();
  await require('./rentalPaymentFixture').configure(store);
  admin = await F.createAdmin(); customer = await F.createCustomer(); category = (await F.createProduct()).category;
  await S.saveConfiguration(store, { revision: 0, mode: 'SALE_AND_RENTAL', policy: { ...A.DEFAULT_POLICY } });
});
async function create(mode = 'SALE_AND_RENTAL', enabled) {
  const res = await H.request('/api/admin/products', { method: 'POST', token: admin.token, body: {
    name: 'Linked bridal outfit', sku: op(), category: String(category), price: 5000, originalPrice: 6000,
    stock: 0, sizes: [], sizingMode: 'free-size', commerceMode: mode,
    images: [{ url: 'https://example.test/bridal.webp', primary: true }],
    rentalPricing: { dailyRatePaise: 75000, depositPaise: 100000, advanceMode: 'STORE', ...(enabled !== undefined ? { enabled } : {}) },
  } });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return { product: res.data, listing: await M.Listing.findOne({ productId: res.data._id }).lean() };
}
async function piece(productId, pool = 'old-stock', code = 'LEHENGA-001') {
  return S.saveAsset(store, { productId: String(productId), poolKey: pool, code, label: 'Real outfit' });
}
async function hold(listing) {
  const input = { ...dates(), items: [{ listingId: String(listing._id), quantity: 1 }] };
  const q = await S.publicQuote(store, input);
  return S.hold(store, { ...input, attemptId: op(), acceptTerms: true, customer: {}, policyRevision: q.policyRevision, quoteFingerprint: q.quoteFingerprint }, customer.user);
}

test('product-created mixed offer appears across storefront APIs with existing exact product pieces in another pool', async () => {
  const { product, listing } = await create();
  assert.equal((await S.catalogue(store)).total, 0);
  assert.equal(await M.Asset.countDocuments({ productId: product._id }), 0);
  const asset = await piece(product._id);
  const catalogue = await H.request('/api/rentals/catalogue?page=1');
  assert.equal(catalogue.status, 200); assert.equal(catalogue.data.total, 1);
  assert.equal(String(catalogue.data.rows[0]._id), String(listing._id));
  const detail = await H.request('/api/rentals/products/' + product._id);
  assert.equal(detail.data.listings.length, 1); assert.equal(detail.data.listings[0].dailyRatePaise, 75000);
  const preview = await require('../services/rentalProductPreview').enrich([product], { store });
  assert.equal(preview[0].rentalStatus.live, true); assert.equal(preview[0].rentalPreview.listingId, String(listing._id));
  const filtered = await require('../services/catalogCommerceService').publicFilter({ store, query: { mode: 'rent' } });
  assert.deepEqual(filtered._id.$in.map(String), [String(product._id)]);
  const narrowed = await H.request('/api/rentals/catalogue?' + new URLSearchParams({ page: '1', search: 'Linked bridal', minRent: '700', maxRent: '800', category: String(category) }));
  assert.equal(narrowed.data.total, 1);
  const calendar = await require('../services/rentalCalendarService').calendar(store, listing._id, { month: dates().pickupAt.slice(0, 7), days: 2 });
  assert.equal(calendar.rows.find(row => row.date === dates().pickupAt.slice(0, 10)).status, 'AVAILABLE');
  const booking = await hold(listing);
  assert.equal(String(booking.allocations[0].assetId), String(asset._id));
  assert.equal(booking.quote.rentalPaise, 150000); assert.equal(booking.quote.depositPaise, 100000);
  assert.equal((await Product.findById(product._id)).stock, 0);
  await assert.rejects(() => hold(listing), /unavailable/);
});

test('rental-only and draft-published products use the same link without a separate Studio offer', async () => {
  const { product } = await create('RENTAL_ONLY'); await piece(product._id);
  const draft = await H.request('/api/admin/product-drafts', { method: 'POST', token: admin.token, body: {
    name: 'Draft linked jewellery', category: String(category), price: 4000, originalPrice: 5000, stock: 0,
    sizingMode: 'free-size', commerceMode: 'SALE_AND_RENTAL', images: [{ url: 'https://example.test/set.webp' }],
    rentalPricing: { dailyRatePaise: 50000, depositPaise: 0, advanceMode: 'STORE' },
  } });
  assert.equal(draft.status, 201);
  const published = await H.request('/api/admin/product-drafts/publish-selected', { method: 'POST', token: admin.token,
    body: { ids: [draft.data.data.id || draft.data.data._id] } });
  assert.equal(published.status, 200, JSON.stringify(published.data));
  const second = published.data.data.products[0]; await piece(second._id, 'jewellery', 'JEWEL-001');
  assert.equal((await S.catalogue(store)).total, 2);
  assert.equal(await M.Listing.countDocuments({ productId: second._id }), 1);
});

test('legacy repair links untouched product drafts once and preserves reviewed pauses, bundles and other tenants', async () => {
  const { product, listing } = await create(); await piece(product._id);
  await M.Listing.updateOne({ _id: listing._id }, { $set: { active: false, revision: 0 }, $unset: { publicationOrigin: '' } });
  const paused = await M.Listing.create({ ...listing, _id: undefined, active: false, publicationOrigin: undefined, revision: 3 });
  const manual = await M.Listing.create({ ...listing, _id: undefined, active: false, publicationOrigin: 'STUDIO', revision: 0 });
  const custom = await M.Listing.create({ ...listing, _id: undefined, active: false, publicationOrigin: undefined,
    requirements: [{ productId: product._id, poolKey: 'custom-pool', label: 'Custom set', quantity: 1 }] });
  const result = await Link.repairLegacyProductOffers(); assert.equal(result.updated, 1);
  assert.equal((await Link.repairLegacyProductOffers()).updated, 0);
  for (const row of [paused, manual, custom]) assert.equal((await M.Listing.findById(row._id)).active, false);
  assert.equal((await S.catalogue(store)).total, 1);
  const other = await Store.create({ name: 'Other boutique', slug: op().toLowerCase() });
  assert.equal((await S.catalogue(other)).total, 0);
});

test('product visibility can be paused and resumed in the product editor without duplicate offers or price loss', async () => {
  const { product, listing } = await create(); await piece(product._id);
  const paused = await S.saveListing(store, { ...listing, active: false });
  const save = async (enabled, revision) => H.request('/api/admin/products/' + product._id, { method: 'PUT', token: admin.token,
    body: { rentalPricing: { listingId: String(listing._id), revision, dailyRatePaise: 85000, depositPaise: 100000, advanceMode: 'STORE', ...(enabled !== undefined ? { enabled } : {}) } } });
  let response = await save(undefined, paused.revision); assert.equal(response.status, 200);
  assert.equal((await S.catalogue(store)).total, 0);
  assert.equal((await Link.repairLegacyProductOffers()).updated, 0);
  response = await save(true, response.data.rentalOffers[0].revision); assert.equal(response.status, 200);
  assert.equal(response.data.rentalOffers[0].live, true); assert.equal((await S.catalogue(store)).total, 1);
  assert.equal(await M.Listing.countDocuments({ productId: product._id }), 1);
  assert.equal((await M.Listing.findById(listing._id)).dailyRatePaise, 85000);
});

test('unready linked offer can be edited in setup; wrong product, retired and sold pieces cannot make it bookable', async () => {
  const { product, listing } = await create();
  const edited = await S.saveListing(store, { ...listing, dailyRatePaise: 90000 });
  assert.equal(edited.active, true);
  const otherProduct = await F.createProduct({ storeId: store._id, commerceMode: 'SALE_AND_RENTAL' });
  await piece(otherProduct._id, 'product-' + product._id);
  assert.equal((await S.catalogue(store)).total, 0);
  const asset = await piece(product._id, 'different-rack', 'LEHENGA-002');
  await M.Asset.updateOne({ _id: asset._id }, { $set: { status: 'RETIRED' } });
  assert.equal((await S.catalogue(store)).total, 0);
  await M.Asset.updateOne({ _id: asset._id }, { $set: { status: 'READY', saleConversion: { completed: true } } });
  assert.equal((await S.catalogue(store)).total, 0);
  await M.Asset.updateOne({ _id: asset._id }, { $unset: { saleConversion: '' } });
  assert.equal((await S.catalogue(store)).total, 1);
  const config = await S.readConfiguration(store);
  await S.saveConfiguration(store, { ...config, mode: 'SALE_ONLY' });
  assert.equal((await S.catalogue(store)).total, 0);
  await assert.rejects(() => hold(edited), error => error.errorCode === 'CHECKOUT_RESTRICTED');
  await S.saveConfiguration(store, { ...(await S.readConfiguration(store)), mode: 'SALE_AND_RENTAL' });
  await Product.updateOne({ _id: product._id }, { $set: { isActive: false } });
  assert.equal((await S.catalogue(store)).total, 0);
});

test('Studio custom pools stay separate; shared product inventory cannot be double allocated across offers', async () => {
  const { product, listing } = await create(); const asset = await piece(product._id, 'custom-stock');
  const manual = await S.saveListing(store, { productId: product._id, active: true, dailyRatePaise: 50000, depositPaise: 0,
    requirements: [{ poolKey: 'custom-stock', label: 'Custom outfit', quantity: 1 }] });
  const input = { ...dates(), items: [{ listingId: listing._id, quantity: 1 }, { listingId: manual._id, quantity: 1 }] };
  await assert.rejects(() => S.publicQuote(store, input), /unavailable/);
  const results = await Promise.allSettled([hold(listing), hold(manual)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(await M.Reservation.countDocuments({ assetId: asset._id, active: true }), 1);
  const wrongPool = await S.saveListing(store, { productId: product._id, active: false, dailyRatePaise: 10000, depositPaise: 0,
    requirements: [{ poolKey: 'separate-pool', label: 'Separate outfit', quantity: 1 }] });
  assert.equal((await require('../services/rentalSetupService').readiness(store, wrongPool)).ready, false);
});

test('disabling product rental visibility at creation is explicit and invalid values are rejected', async () => {
  const { product, listing } = await create('SALE_AND_RENTAL', false); await piece(product._id);
  assert.equal((await S.catalogue(store)).total, 0); assert.equal((await Link.repairLegacyProductOffers()).updated, 0);
  const result = await H.request('/api/admin/products/' + product._id, { method: 'PUT', token: admin.token, body: {
    rentalPricing: { listingId: String(listing._id), revision: 0, dailyRatePaise: 75000, depositPaise: 0, enabled: 'true' },
  } });
  assert.equal(result.status, 400);
});

test('linked product inventory keeps tenant and variant boundaries even when pool names overlap', async () => {
  const { product, listing } = await create();
  const foreign = await Store.create({ name: 'Other boutique', slug: op().toLowerCase() });
  await M.Asset.create({ storeId: foreign._id, productId: product._id, poolKey: 'old-stock', code: 'FOREIGN-01', label: 'Foreign piece' });
  assert.equal((await S.catalogue(store)).total, 0);
  await Product.updateOne({ _id: product._id }, { $set: { variants: [{ size: 'M', color: 'Red', stock: 0, isActive: true }] } });
  const saved = await Product.findById(product._id), variantId = String(saved.variants[0]._id);
  await M.Listing.updateOne({ _id: listing._id }, { $set: { variantId, size: 'M', colour: 'Red' } });
  await piece(product._id); // Unspecified fitting cannot satisfy the exact M/Red offer.
  assert.equal((await S.catalogue(store)).total, 0);
  await S.saveAsset(store, { productId: product._id, variantId, poolKey: 'another-pool', code: 'MATCH-01', label: 'Exact fitting' });
  assert.equal((await S.catalogue(store)).total, 1);
  await Product.updateOne({ _id: product._id, 'variants._id': variantId }, { $set: { 'variants.$.isActive': false } });
  assert.equal((await S.catalogue(store)).total, 0);
});

test('piece replacement follows the accepted product inventory across pools and releases only its old reservation', async () => {
  const { product, listing } = await create();
  const first = await piece(product._id, 'rack-one', 'LEHENGA-001');
  const second = await piece(product._id, 'rack-two', 'LEHENGA-002');
  const booking = await hold(listing);
  assert.equal(booking.allocations[0].binding.inventoryScope, 'PRODUCT');
  const updated = await S.replacePiece(store, booking._id, { operationId: op(), revision: booking.revision,
    assetId: String(first._id), replacementId: String(second._id), customerAcknowledged: true, note: 'Customer approved the matching physical item.' }, admin.user._id);
  assert.equal(String(updated.allocations[0].assetId), String(second._id));
  assert.equal(await M.Reservation.countDocuments({ assetId: first._id, active: true }), 0);
  assert.equal(await M.Reservation.countDocuments({ assetId: second._id, active: true }), 1);
});
