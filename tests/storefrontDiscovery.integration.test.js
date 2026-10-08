const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startTestEnvironment, stopTestEnvironment, resetDatabase, request } = require('./helpers');
const { createProduct, createAdmin } = require('./factories');
const Store = require('../models/Store');
const Settings = require('../models/Settings');
const Product = require('../models/Product');
const Category = require('../models/Category');
const Rental = require('../models/Rental');
const service = require('../services/storefrontDiscoveryService');
let store, other, source, necklace, earrings;
before(startTestEnvironment); after(stopTestEnvironment);
beforeEach(async () => {
  await resetDatabase();
  store = await Store.create({ name: 'Occasion store', slug: 'occasion-store', status: 'PUBLISHED' });
  other = await Store.create({ name: 'Other store', slug: 'other-store', status: 'PUBLISHED' });
  source = await createProduct({ storeId: store._id, name: 'Bridal lehenga', sku: 'LOOK-SOURCE', sizingMode: 'free-size', sizes: [], occasion: ' Wedding, Daily  wear ', colors: ['Gold'] });
  necklace = await createProduct({ storeId: store._id, name: 'Gold necklace', occasion: 'Wedding', colors: ['Gold'] });
  earrings = await createProduct({ storeId: store._id, name: 'Pearl earrings', occasion: 'Party', colors: ['Gold'] });
});
const url = (path, query = '') => `/api${path}?store=occasion-store${query ? `&${query}` : ''}`;
const context = () => ({ store, tenantFilter: { storeId: store._id }, query: {}, params: { slug: String(source._id) } });

test('discovery uses only actual public store products and preserves private recent order', async () => {
  const hidden = await createProduct({ storeId: store._id, isActive: false, occasion: 'Hidden' });
  const future = await createProduct({ storeId: store._id, publishAt: new Date(Date.now() + 86400000), occasion: 'Future' });
  const archived = await createProduct({ storeId: store._id, isArchived: true, occasion: 'Archived' });
  const foreign = await createProduct({ storeId: other._id, occasion: 'Foreign' });
  const recent = [earrings, hidden, foreign, future, source, archived].map(p => String(p._id)).join(',');
  const result = await request(url('/storefront/home/discovery', `recent=${recent}`));
  assert.equal(result.status, 200); assert.equal(result.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(result.data.recentlyViewed.map(p => p._id), [String(earrings._id), String(source._id)]);
  assert.deepEqual(result.data.occasions.map(p => p.label).sort(), ['Daily wear', 'Party', 'Wedding']);
  assert.equal(result.data.occasions.find(p => p.label === 'Wedding').count, 2);
  assert.equal(result.data.rentalEnabled, false);
  assert.equal(result.data.recentlyViewed[0].costPrice, undefined);
  assert.equal(result.data.recentlyViewed[0].completeLookProductIds, undefined);
});

test('occasion shortcuts match complete tokens, flexible whitespace and safe escaped characters', async () => {
  const tagged = await createProduct({ storeId: store._id, occasion: 'Work; Party (Evening)|Daily wear' });
  let result = await request(url('/products', 'occasion=Daily%20wear'));
  assert.equal(result.status, 200); assert.deepEqual(new Set(result.data.map(p => p._id)), new Set([String(source._id), String(tagged._id)]));
  result = await request(url('/products', 'occasion=Party%20(Evening)'));
  assert.deepEqual(result.data.map(p => p._id), [String(tagged._id)]);
  result = await request(url('/products', 'occasion=Wed'));
  assert.deepEqual(result.data, []);
});

test('per-store switches remove optional modules, not products or other store preferences', async () => {
  await Settings.create({ storeId: store._id, occasionShoppingEnabled: false, recentlyViewedEnabled: false, completeLookEnabled: false });
  const result = await request(url('/storefront/home/discovery', `recent=${source._id}`));
  assert.deepEqual(result.data.occasions, []); assert.deepEqual(result.data.recentlyViewed, []);
  const look = await request(url(`/products/${source._id}/complete-look`));
  assert.equal(look.status, 200); assert.deepEqual(look.data, { enabled: false, products: [] });
  assert.equal(await Product.countDocuments({ storeId: store._id }), 3);
  const mobile = await request(url('/storefront/home', `format=compact&recent=${source._id}`));
  assert.equal(mobile.data.settings.recentlyViewedEnabled, false); assert.deepEqual(mobile.data.collections.recentlyViewed, []);
  assert.equal(mobile.headers.get('cache-control'), 'private, no-store');
  assert.equal((await service.preferences({ store: other, tenantFilter: { storeId: other._id } })).completeLookEnabled, true);
});

test('complete look prefers owner order and hides unpublished, foreign and unavailable selections', async () => {
  const hidden = await createProduct({ storeId: store._id, isActive: false });
  const future = await createProduct({ storeId: store._id, publishAt: new Date(Date.now() + 86400000) });
  const empty = await createProduct({ storeId: store._id, stock: 0 });
  const foreign = await createProduct({ storeId: other._id });
  await Product.updateOne({ _id: source._id }, { completeLookProductIds: [earrings._id, hidden._id, empty._id, foreign._id, future._id, necklace._id] });
  const result = await request(url(`/products/${source._id}/complete-look`));
  assert.equal(result.status, 200); assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(result.data.strategy, 'OWNER_CURATED');
  assert.deepEqual(result.data.products.map(p => p._id), [String(earrings._id), String(necklace._id)]);
  assert.ok(result.data.products.every(p => p.discoveryPurchase === 'SALE' && p.costPrice === undefined));
  assert.equal((await request(url(`/products/${foreign._id}/complete-look`))).status, 404);
});

test('algorithm requires complementary type plus context and recognizes generic names through category', async () => {
  const category = await Category.create({ storeId: store._id, name: 'Bangles', slug: 'bangles' });
  const bangle = await createProduct({ storeId: store._id, category: category._id, name: 'Design 101', occasion: 'Wedding', colors: [] });
  const sameType = await createProduct({ storeId: store._id, name: 'Other lehenga', occasion: 'Wedding', colors: ['Gold'] });
  const unrelated = await createProduct({ storeId: store._id, name: 'Silver necklace', occasion: 'Office', colors: ['Silver'] });
  const result = await request(url(`/products/${source.slug}/complete-look`));
  assert.equal(result.status, 200); assert.equal(result.data.strategy, 'CONTEXT_MATCHED');
  const found = result.data.products.map(p => p._id);
  assert.equal(found[0], String(necklace._id)); assert.ok(found.includes(String(earrings._id))); assert.ok(found.includes(String(bangle._id)));
  assert.ok(!found.includes(String(sameType._id))); assert.ok(!found.includes(String(unrelated._id)));
  assert.equal(service.complementScore({ name: 'Mobile phone', occasion: 'Wedding' }, { name: 'Gold necklace', occasion: 'Wedding' }), 0);
});

test('rental-only discovery uses active listings, real rates and never sale stock for availability', async () => {
  await Rental.Configuration.create({ storeId: store._id, mode: 'RENTAL_ONLY' });
  await Store.updateOne({ _id: store._id }, { 'catalogStructure.commerce.mode': 'RENTAL_ONLY' });
  for (const product of [source, necklace]) {
    await Product.updateOne({ _id: product._id }, { commerceMode: 'RENTAL_ONLY' });
    await Rental.Listing.create({ storeId: store._id, productId: product._id, title: product.name, active: true, dailyRatePaise: 25000, depositPaise: 100000, requirements: [{ productId: product._id, poolKey: String(product._id), label: product.name, quantity: 1 }] });
    await Rental.Asset.create({ storeId: store._id, productId: product._id, code: 'DISCOVERY-' + product._id, label: product.name, poolKey: String(product._id), state: 'READY' });
  }
  await Rental.Listing.create({ storeId: store._id, productId: earrings._id, title: 'Hidden rental', active: false, dailyRatePaise: 10000 });
  await Product.updateOne({ _id: necklace._id }, { stock: 0 });
  const home = await request(url('/storefront/home/discovery', `recent=${source._id},${earrings._id}`));
  assert.equal(home.data.rentalEnabled, true); assert.deepEqual(home.data.recentlyViewed.map(p => p._id), [String(source._id)]);
  assert.ok(!home.data.occasions.some(p => p.label === 'Party'));
  const look = await request(url(`/products/${source._id}/complete-look`));
  assert.deepEqual(look.data.products.map(p => p._id), [String(necklace._id)]);
  assert.equal(look.data.products[0].discoveryPurchase, 'RENTAL');
  assert.equal(look.data.products[0].commerceMode, 'RENTAL_ONLY');
  assert.equal(look.data.products[0].rentalPreview.dailyRatePaise, 25000); assert.equal(look.data.products[0].rentalPreview.depositPaise, 100000); assert.ok(look.data.products[0].rentalPreview.listingId); assert.equal(look.data.products[0].rentalPreview.fitting, undefined);
  assert.equal(look.data.products[0].available, undefined, 'dates must be quoted before any availability promise');
  await Rental.Configuration.updateOne({ storeId: store._id }, { mode: 'SALE_ONLY' });
  assert.equal((await request(url('/storefront/home/discovery'))).data.rentalEnabled, false);
  assert.equal(await Rental.Listing.countDocuments({ storeId: store._id }), 3);
});

test('matching selection validation rejects self, duplicate, malformed, too many and cross-store links', async () => {
  const foreign = await createProduct({ storeId: other._id });
  for (const values of [[String(source._id).toUpperCase()], [String(necklace._id), String(necklace._id).toUpperCase()], [String(foreign._id)], ['bad'], 'not an array', Array(9).fill(String(necklace._id))]) {
    await assert.rejects(() => service.validateComplements(context(), { completeLookProductIds: values }, source._id), /matching products|Matching products/i);
  }
  await service.validateComplements(context(), { completeLookProductIds: [String(necklace._id)] }, source._id);
  await service.validateComplements(context(), {}, source._id);
  assert.deepEqual(service.ids([String(source._id).toUpperCase(), String(source._id), 'bad']), [String(source._id)]);
  assert.deepEqual(service.tokens('Wedding, wedding| Daily  wear;<script>;'), ['wedding', 'Daily wear']);
});

test('product HTTP mutation persists matching products and rejects self references without altering the record', async () => {
  const admin = await createAdmin();
  let result = await request(`/api/admin/products/${source._id}`, { method: 'PUT', token: admin.token, body: { completeLookProductIds: [String(necklace._id)] } });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.deepEqual(result.data.completeLookProductIds, [String(necklace._id)]);
  assert.equal((await request(url(`/products/${source._id}`))).data.completeLookProductIds, undefined, 'internal matching selections are not exposed by the public product serializer');
  result = await request(`/api/admin/products/${source._id}`, { method: 'PUT', token: admin.token, body: { completeLookProductIds: [String(source._id).toUpperCase()] } });
  assert.equal(result.status, 400); assert.deepEqual((await Product.findById(source._id)).completeLookProductIds.map(String), [String(necklace._id)]);
});

test('admin settings expose strict persisted switches and preserve unrelated settings', async () => {
  await Settings.create({ storeId: store._id, storeName: 'Occasion store', announcementText: 'Original announcement' });
  const admin = await createAdmin();
  let result = await request(url('/admin/settings'), { method: 'PUT', token: admin.token, body: { occasionShoppingEnabled: false, recentlyViewedEnabled: false, completeLookEnabled: false } });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.announcementText, 'Original announcement');
  assert.equal((await request(url('/storefront/home/discovery'))).data.occasionShoppingEnabled, false);
  result = await request(url('/admin/settings'), { method: 'PUT', token: admin.token, body: { occasionShoppingEnabled: 'false' } });
  assert.equal(result.status, 400); assert.equal((await Settings.findOne({ storeId: store._id })).occasionShoppingEnabled, false);
});

test('draft recovery and publication preserve optional matching products', async () => {
  const Draft = require('../models/ProductDraft');
  const { prepareImportedDraft, publishPreparedDraft } = require('../controllers/productDraftController');
  const draft = await Draft.create({ storeId: store._id, name: 'Draft bridal lehenga', sku: 'LOOK-DRAFT', category: source.category, price: 1000, sellingPrice: 1000, originalPrice: 1500, stock: 1, images: [{ url: '/uploads/look.jpg', primary: true }], sizingMode: 'free-size', sizes: [], completeLookProductIds: [necklace._id], occasion: 'Wedding' });
  const recovered = await Draft.findById(draft._id);
  assert.deepEqual(recovered.completeLookProductIds.map(String), [String(necklace._id)]);
  const prepared = await prepareImportedDraft(recovered);
  assert.deepEqual(prepared.completeLookProductIds.map(String), [String(necklace._id)]);
  const published = await publishPreparedDraft(recovered, prepared);
  assert.deepEqual(published.completeLookProductIds.map(String), [String(necklace._id)]);
});

test('default-store matching keeps legacy products without opening access to another tenant', async () => {
  const { ensureDefaultStore } = require('../services/storeService');
  const defaultStore = await ensureDefaultStore();
  const legacy = await createProduct({ name: 'Legacy matching necklace' });
  await service.validateComplements({}, { completeLookProductIds: [String(legacy._id)] }, null, defaultStore._id);
  await assert.rejects(() => service.validateComplements({}, { completeLookProductIds: [String(necklace._id)] }, null, defaultStore._id), /must belong to this store/);
});
