// Pure controller tests: no listener, database connection or real requests.
const test = require('node:test');
const assert = require('node:assert/strict');

test('designer catalog options project only labels and IDs while keeping tenant scope', async (t) => {
  const Product = require('../models/Product');
  const controller = require('../controllers/productController');
  const items = [{ _id: 'product-1', name: 'Kurta', slug: 'kurta' }];
  let projection;
  let filter;
  const query = {
    select(fields) { projection = fields; return this; },
    sort() { return this; },
    limit(value) { assert.equal(value, 250); return this; },
    lean: async () => items,
  };
  t.mock.method(Product, 'find', (input) => { filter = input; return query; });
  let response;
  await controller.getProducts({ baseUrl: '/api/admin/products', query: { customizationOptions: 'true' }, tenantFilter: { storeId: 'store-1' } }, { json: (value) => { response = value; } });
  assert.equal(projection, '_id name slug');
  assert.ok(JSON.stringify(filter).includes('store-1'));
  assert.deepEqual(response, items);
});

test('public catalog requests cannot opt into the admin lightweight response', async (t) => {
  const Product = require('../models/Product');
  const controller = require('../controllers/productController');
  let filter;
  let populated = false;
  t.mock.method(Product, 'find', (input) => {
    filter = input;
    return { populate() { populated = true; return this; }, sort: async () => [] };
  });
  await controller.getProducts({ baseUrl: '/api/products', query: { customizationOptions: 'true' } }, { json: () => {} });
  assert.equal(populated, true);
  assert.ok(JSON.stringify(filter).includes('isActive'));
});

test('history summaries omit snapshots without changing the default history contract', async (t) => {
  const Theme = require('../models/WebsiteTheme');
  const Version = require('../models/WebsiteThemeVersion');
  const controller = require('../controllers/websiteCustomizationController');
  t.mock.method(Theme, 'exists', async () => true);
  for (const summary of [true, false]) {
    let projection;
    const query = {
      populate() { return this; }, sort() { return this; }, limit(value) { assert.equal(value, 100); return this; },
      select(value) { projection = value; return this; }, lean: async () => [],
    };
    t.mock.method(Version, 'find', () => query);
    let error;
    await controller.getHistory({ params: { id: '0123456789abcdef01234567' }, query: summary ? { summary: 'true' } : {} }, { json: () => {} }, (value) => { error = value; });
    assert.equal(error, undefined);
    assert.equal(projection, summary ? '-config' : undefined);
  }
});
