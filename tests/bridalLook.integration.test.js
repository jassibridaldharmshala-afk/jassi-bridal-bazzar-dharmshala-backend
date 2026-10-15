require('./rentalPaymentFixture');
const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { startTestEnvironment, stopTestEnvironment, resetDatabase, request } = require('./helpers');
const { createProduct, createAdmin } = require('./factories');
const { ensureDefaultStore } = require('../services/storeService');
const Product = require('../models/Product'), Store = require('../models/Store'), M = require('../models/Rental');
const S = require('../services/rentalService'), A = require('../services/rentalAlgorithms'), B = require('../services/bridalLookAlgorithms');
const { normalizeContext } = require('../services/productImportContext.service');
let store, source, necklace, bangle, outfitOffer, necklaceOffer, bangleOffer, outfitPiece, necklacePiece, admin;
const key = () => Math.random().toString(36).slice(2);
async function offer(product, { size = '', poolKey = String(product._id), code = key(), variantId = '' } = {}) {
  const asset = await S.saveAsset(store, { productId: String(product._id), variantId, size, poolKey, code, label: product.name });
  const listing = await S.saveListing(store, { productId: String(product._id), variantId, size, title: product.name, active: true, dailyRatePaise: 20000, depositPaise: 30000, requirements: [{ poolKey, productId: String(product._id), size, variantId, label: product.name, quantity: 1 }] }, admin.user._id);
  return { listing, asset };
}
function period() { const date = A.localKey(new Date(Date.now() + 6 * A.DAY), 'Asia/Kolkata'); return { pickupAt: `${date}T10:00:00+05:30`, returnDueAt: new Date(+new Date(`${date}T10:00:00+05:30`) + 2 * A.DAY).toISOString(), useDates: [A.localKey(new Date(+new Date(`${date}T10:00:00+05:30`) + A.DAY), 'Asia/Kolkata')] }; }
function url(context = {}, mode = 'rent', product = source) { return `/api/products/${product._id}/complete-look?${new URLSearchParams({ mode, context: JSON.stringify({ sourceListingId: mode === 'rent' ? String(outfitOffer._id) : '', ...context }) })}`; }
before(async () => { mock.method(require('../services/controlPlaneClient'), 'licenseStatus', async () => ({ managed: false, status: 'ACTIVE' })); await startTestEnvironment(); });
after(async () => { await stopTestEnvironment(); mock.restoreAll(); });
beforeEach(async () => {
  await resetDatabase(); store = await ensureDefaultStore(); admin = await createAdmin(); await require('./rentalPaymentFixture').configure(store);
  await S.saveConfiguration(store, { revision: 0, mode: 'SALE_AND_RENTAL', policy: { ...A.DEFAULT_POLICY } }, admin.user._id);
  source = await createProduct({ storeId: store._id, sku: 'BRIDAL-' + key(), name: 'Wine bridal lehenga', colors: ['Wine', 'Blue'], commerceMode: 'SALE_AND_RENTAL', bridalStyle: { mainColour: 'Wine', metallicTone: 'gold-tone', accentColours: ['Gold'], style: 'traditional', accessoryType: 'garment' } });
  necklace = await createProduct({ storeId: store._id, name: 'Antique bridal necklace', colors: ['Gold'], stock: 0, commerceMode: 'SALE_AND_RENTAL', bridalStyle: { mainColour: 'Gold', metallicTone: 'gold-tone', accessoryType: 'necklace', style: 'traditional' }, lookDetails: { unit: 'set', includedTypes: ['earrings'] } });
  bangle = await createProduct({ storeId: store._id, name: 'Maroon bangles', colors: ['Maroon'], sizes: ['2.4', '2.6'], sizingMode: 'sized', stock: 3, commerceMode: 'SALE_AND_RENTAL', bridalStyle: { mainColour: 'Maroon', metallicTone: 'gold-tone', accessoryType: 'bangles' }, lookDetails: { unit: 'pair' } });
  ({ listing: outfitOffer, asset: outfitPiece } = await offer(source));
  ({ listing: necklaceOffer, asset: necklacePiece } = await offer(necklace));
  ({ listing: bangleOffer } = await offer(bangle, { size: '2.4' }));
});
test('selected rent on mixed outfit uses real offers even with zero sale stock and dates are required', async () => {
  const result = await request(url()); assert.equal(result.status, 200, JSON.stringify(result.data));
  const row = result.data.products.find(p => p._id === String(necklace._id));
  assert.equal(result.data.mode, 'rent'); assert.equal(row.look.mode, 'rent'); assert.equal(row.look.availability, 'DATES_REQUIRED'); assert.equal(row.look.options[0].listingId, String(necklaceOffer._id));
  assert.equal(row.look.options[0].unit, 'set'); assert.equal(row.look.options[0].dailyRatePaise, 20000);
});

test('matching validates exact source readiness without scanning the whole rental catalogue', async () => {
  const catalogue = mock.method(require('../services/catalogCommerceService'), 'publicFilter', async () => { throw new Error('Unrelated whole-catalogue read'); });
  try {
    let result = await request(url()); assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.contractVersion, 'bridal-look-v1'); assert.equal(catalogue.mock.callCount(), 0);
    await M.Asset.updateOne({ _id: outfitPiece._id }, { status: 'RETIRED' });
    result = await request(url()); assert.equal(result.status, 404); assert.match(result.data.message, /not ready/);
    await Product.updateOne({ _id: source._id }, { commerceMode: 'RENTAL_ONLY' });
    result = await request(url({}, 'buy')); assert.equal(result.status, 404);
  } finally { catalogue.mock.restore(); }
});

test('new garments do not push actual accessory matches out of the bounded catalogue read', async () => {
  const later = new Date(Date.now() + 1000);
  await Product.insertMany(Array.from({ length: 245 }, (_, i) => ({ storeId: store._id, name: `Recent lehenga ${i}`, slug: `recent-lehenga-${i}`, category: source.category, commerceMode: 'SALE_ONLY', price: 1000, stock: 1, isActive: true, bridalStyle: { accessoryType: 'garment' }, updatedAt: later })));
  const result = await request(url()); assert.equal(result.status, 200, JSON.stringify(result.data)); assert.ok(result.data.products.some(p => p._id === String(necklace._id)));
});
test('held reservations and physical condition override sale stock and preserve tenant privacy', async () => {
  await M.Reservation.create({ storeId: store._id, assetId: necklacePiece._id, active: true, kind: 'MAINTENANCE', blockedFrom: new Date(), blockedUntil: new Date(Date.now() + 20 * A.DAY) });
  await Product.updateOne({ _id: necklace._id }, { stock: 999 });
  const result = await request(url(period())); assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.products.find(p => p._id === String(necklace._id)).look.availability, 'UNAVAILABLE');
  assert.ok(!JSON.stringify(result.data).includes(String(necklacePiece._id)));
});
test('colour aliases work; occasion alone and unselected colourway do not match', async () => {
  const wineOnly = await createProduct({ storeId: store._id, name: 'Wine potli', colors: ['Maroon'], occasion: 'Wedding', bridalStyle: { accessoryType: 'bag' } });
  const random = await createProduct({ storeId: store._id, name: 'Yellow necklace', colors: ['Yellow'], occasion: 'Wedding' });
  let result = await request(url({ colour: 'Wine' }, 'buy')); assert.equal(result.status, 200);
  assert.ok(result.data.products.some(p => p._id === String(wineOnly._id))); assert.ok(!result.data.products.some(p => p._id === String(random._id)));
  result = await request(url({ colour: 'Blue' }, 'buy')); assert.ok(!result.data.products.some(p => p._id === String(wineOnly._id)));
});
test('bangle codes and exact variants are retained; unknown sizes are never invented', async () => {
  const second = await offer(bangle, { size: '2.6' });
  const result = await request(url({ choices: [String(second.listing._id)] }));
  const row = result.data.products.find(p => p._id === String(bangle._id));
  assert.deepEqual(row.look.options.map(o => o.size).sort(), ['2.4', '2.6']); assert.equal(row.look.selectedOptionId, String(second.listing._id));
  assert.equal(require('../services/productSizingService').normalizeProductSizing({ name: 'Bangles', sizes: ['2.4'], sizingMode: 'free-size', sizeChart: {} }).sizes[0], '2.4');
  await M.Listing.updateMany({ productId: bangle._id }, { size: 'Free' });
  assert.ok(!(await request(url())).data.products.some(p => p._id === String(bangle._id)));
  await M.Listing.updateMany({ productId: bangle._id }, { size: '' }); await Product.updateOne({ _id: bangle._id }, { sizes: [], variants: [], sizingMode: 'free-size' });
  assert.ok(!(await request(url())).data.products.some(p => p._id === String(bangle._id)));
});
test('included earrings and already selected rental products are excluded without removing outfit', async () => {
  const earrings = await createProduct({ storeId: store._id, name: 'Gold earrings', colors: ['Gold'], commerceMode: 'SALE_AND_RENTAL', bridalStyle: { metallicTone: 'gold-tone', accessoryType: 'earrings' } }); await offer(earrings);
  let result = await request(url()); assert.ok(result.data.products.some(p => p._id === String(earrings._id)));
  result = await request(url({ items: [{ listingId: String(necklaceOffer._id), quantity: 1 }] }));
  assert.ok(!result.data.products.some(p => [String(earrings._id), String(necklace._id)].includes(p._id)));
  result = await request(url({ selectedItems: [{ listingId: String(necklaceOffer._id), quantity: 1 }] }));
  assert.ok(result.data.products.some(p => p._id === String(necklace._id))); assert.ok(!result.data.products.some(p => p._id === String(earrings._id)));
  await Product.updateOne({ _id: necklace._id }, { stock: 3 });
  result = await request(url({ selectedBuyProductIds: [String(necklace._id)] }, 'buy'));
  assert.ok(result.data.products.some(p => p._id === String(necklace._id))); assert.ok(!result.data.products.some(p => p._id === String(earrings._id)));
  result = await request(url({ buyProductIds: [String(necklace._id)] }, 'buy'));
  assert.ok(!result.data.products.some(p => [String(necklace._id), String(earrings._id)].includes(p._id)));
});
test('pinned unavailable accessories get automatic alternatives; blocked and foreign products stay out', async () => {
  const alternate = await createProduct({ storeId: store._id, name: 'Gold necklace alternative', colors: ['Gold'], commerceMode: 'SALE_AND_RENTAL', bridalStyle: { metallicTone: 'gold-tone', accessoryType: 'necklace' } }); await offer(alternate);
  const other = await Store.create({ name: 'Other', slug: 'other-look-store', status: 'PUBLISHED' });
  const foreign = await createProduct({ storeId: other._id, name: 'Gold necklace foreign', colors: ['Gold'] });
  await Product.updateOne({ _id: source._id }, { completeLookProductIds: [necklace._id, foreign._id], completeLookBlockedIds: [bangle._id] });
  await M.Reservation.create({ storeId: store._id, assetId: necklacePiece._id, kind: 'MAINTENANCE', active: true, blockedFrom: new Date(), blockedUntil: new Date(Date.now() + 20 * A.DAY) });
  const result = await request(url(period())); assert.ok(result.data.products.some(p => p._id === String(alternate._id) && p.look.availability === 'AVAILABLE'));
  assert.ok(!result.data.products.some(p => [String(foreign._id), String(bangle._id)].includes(p._id)));
  assert.equal((await request(url({ sourceListingId: String(necklaceOffer._id) }))).status, 404);
});
test('combined selections sharing one physical piece fail even if each offer alone is available', async () => {
  const alternative = await S.saveListing(store, { productId: String(bangle._id), size: '2.4', title: 'Bangle set using shared necklace component', active: true, dailyRatePaise: 10000, depositPaise: 5000, requirements: [{ productId: String(necklace._id), poolKey: String(necklace._id), label: 'Shared accessory component', quantity: 1 }, { productId: String(bangle._id), poolKey: String(bangle._id), label: 'Bangles', size: '2.4', quantity: 1 }] }, admin.user._id);
  const schedule = period();
  await S.publicQuote(store, { ...schedule, items: [{ listingId: String(alternative._id), quantity: 1 }] });
  await assert.rejects(() => S.publicQuote(store, { ...schedule, items: [{ listingId: String(necklaceOffer._id), quantity: 1 }, { listingId: String(alternative._id), quantity: 1 }] }), /unavailable/i);
  const result = await request(url({ ...schedule, choices: [String(alternative._id)], selectedItems: [{ listingId: String(necklaceOffer._id), quantity: 1 }] }));
  assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.data.products.find(p => p._id === String(bangle._id)).look.availability, 'UNAVAILABLE');
});
test('sale accessories stay in their separate workflow with actual sale options', async () => {
  await Product.updateOne({ _id: bangle._id }, { commerceMode: 'SALE_ONLY' });
  const result = await request(url()); const row = result.data.products.find(p => p._id === String(bangle._id));
  assert.equal(row.look.mode, 'buy'); assert.equal(row.discoveryPurchase, 'SALE'); assert.equal(row.look.availability, 'IN_STOCK'); assert.ok(row.look.options.every(o => !o.listingId && o.price > 0));
});
test('structured metadata wins over misleading names; normalization drops commercial and authenticity guesses', () => {
  assert.equal(B.role({ name: 'Lehenga design', categoryDefinitionKey: 'bridal-bangles' }), 'bangles');
  assert.equal(B.match({ name: 'Lehenga', occasion: 'Wedding' }, { name: 'Necklace', occasion: 'Wedding' }), null);
  const normalized = normalizeContext({ name: 'Bridal look', multipleProducts: false, priceAmbiguous: false, bridalStyle: { metallicTone: 'gold-tone', purity: '24K', mainColour: 'Maroon', stock: 100, neckline: 'V-neck' }, fieldSources: { 'bridalStyle.metallicTone': { source: 'visual', quote: 'Gold-coloured embroidery is visible' }, 'bridalStyle.mainColour': { source: 'visual', quote: 'Wine fabric appears visible' } } });
  assert.equal(normalized.bridalStyle.metallicTone, 'gold-tone'); assert.equal(normalized.bridalStyle.purity, undefined); assert.equal(normalized.bridalStyle.stock, undefined); assert.equal(normalized.bridalStyle.neckline, undefined);
});
test('reviewed metadata persists and stale catalogue batch edits are rejected', async () => {
  const snapshot = await Product.findById(source._id);
  let result = await request(`/api/admin/products/${source._id}`, { method: 'PUT', token: admin.token, body: { expectedUpdatedAt: snapshot.updatedAt.toISOString(), bridalStyle: { mainColour: 'Wine', metallicTone: 'gold-tone', stock: 200 }, lookDetails: { unit: 'set' } } });
  assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.data.bridalStyle.stock, undefined);
  const saved = await Product.findById(source._id); assert.deepEqual(saved.images.toObject(), snapshot.images.toObject()); assert.equal(saved.price, snapshot.price); assert.equal(saved.stock, snapshot.stock); assert.deepEqual(saved.sizes, snapshot.sizes);
  result = await request(`/api/admin/products/${source._id}`, { method: 'PUT', token: admin.token, body: { expectedUpdatedAt: snapshot.updatedAt.toISOString(), bridalStyle: { mainColour: 'Blue' } } });
  assert.equal(result.status, 409); assert.equal((await Product.findById(source._id)).bridalStyle.mainColour, 'Wine');
});

test('the exact active source variant controls matching and deactivated variants cannot be used', async () => {
  const mongoose = require('mongoose'), wine = new mongoose.Types.ObjectId(), blue = new mongoose.Types.ObjectId();
  await Product.updateOne({ _id: source._id }, { variants: [{ _id: wine, color: 'Wine', stock: 2, bridalStyle: { mainColour: 'Wine', metallicTone: 'gold-tone' } }, { _id: blue, color: 'Blue', stock: 2, bridalStyle: { mainColour: 'Blue', metallicTone: 'silver-tone' } }] });
  const silver = await createProduct({ storeId: store._id, name: 'Silver-tone necklace', bridalStyle: { metallicTone: 'silver-tone', accessoryType: 'necklace' }, colors: ['Silver'] });
  let result = await request(url({ variantId: String(blue), colour: 'Wine' }, 'buy'));
  assert.equal(result.status, 200); assert.ok(result.data.products.some(p => p._id === String(silver._id))); assert.ok(!result.data.products.some(p => p._id === String(bangle._id)));
  const payload = require('../services/variantService').normalizeVariantsPayload([{ _id: blue, color: 'Blue', stock: 2, bridalStyle: { metallicTone: 'silver-tone', purity: '24K' } }]);
  assert.equal(payload[0].bridalStyle.metallicTone, 'silver-tone'); assert.equal(payload[0].bridalStyle.purity, undefined);
  await Product.updateOne({ _id: source._id, 'variants._id': blue }, { $set: { 'variants.$.isActive': false } });
  result = await request(url({ variantId: String(blue) }, 'buy')); assert.equal(result.status, 400);
  assert.equal((await request(url({ quantity: 1.5 }))).status, 400);
});

test('final reservation rechecks the entire look atomically after a quote and creates no partial booking on conflict', async () => {
  const customer = await require('./factories').createCustomer();
  const input = { ...period(), items: [outfitOffer, necklaceOffer, bangleOffer].map(row => ({ listingId: String(row._id), quantity: 1 })), paymentPlan: 'PICKUP' };
  const configuration = await S.readConfiguration(store); await S.saveConfiguration(store, { ...configuration, policy: { ...configuration.policy, paymentPlans: ['PICKUP'] } });
  const quote = await S.publicQuote(store, input);
  const blocker = await M.Reservation.create({ storeId: store._id, assetId: necklacePiece._id, kind: 'MAINTENANCE', active: true, blockedFrom: new Date(), blockedUntil: new Date(Date.now() + 20 * A.DAY) });
  const accepted = { ...input, quoteFingerprint: quote.quoteFingerprint, policyRevision: quote.policyRevision, attemptId: 'look-' + key(), acceptTerms: true, customer: { name: 'Bridal customer', phone: customer.user.phone, email: '' } };
  await assert.rejects(() => S.hold(store, accepted, customer.user), /unavailable/i); assert.equal(await M.Booking.countDocuments(), 0);
  assert.equal(await M.Reservation.countDocuments({ kind: { $ne: 'MAINTENANCE' }, active: true }), 0);
  await M.Reservation.deleteOne({ _id: blocker._id });
  const fresh = await S.publicQuote(store, input); const booking = await S.hold(store, { ...accepted, attemptId: 'look-' + key(), quoteFingerprint: fresh.quoteFingerprint }, customer.user);
  const stored = await M.Booking.findById(booking._id).lean(); assert.equal(stored.quote.items.length, 3); assert.equal(await M.Reservation.countDocuments({ bookingId: booking._id, active: true }), 3);
});
