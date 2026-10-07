const test = require('node:test');
const assert = require('node:assert/strict');
const controlPlane = require('../services/controlPlaneClient');

test('public browsing does not wait for licence validation, but commerce and premium features still do', async t => {
  const status = { managed: true, status: 'SUSPENDED', features: [], limits: {} };
  const lookup = t.mock.method(controlPlane, 'licenseStatus', async () => status);
  const modulePath = require.resolve('../middleware/externalLicenseMiddleware');
  const original = require.cache[modulePath];
  delete require.cache[modulePath];
  const middleware = require(modulePath);
  t.after(() => {
    if (original) require.cache[modulePath] = original;
    else delete require.cache[modulePath];
  });
  async function check(path, method = 'GET', user = { _id: 'customer' }) {
    let called = false, error;
    await middleware({ originalUrl: `/api${path}`, method, user }, {}, value => { called = true; error = value; });
    assert.equal(called, true);
    return error;
  }
  for (const path of ['/storefront/home?format=compact', '/storefront/home/discovery', '/products', '/products/item', '/products/item/complete-look', '/categories', '/banners', '/settings', '/website-config', '/stores/resolve']) {
    assert.equal(await check(path), undefined);
    assert.equal(await check(path, 'GET', null), undefined);
  }
  assert.equal(lookup.mock.callCount(), 0, 'no remote validation or telemetry on public catalog reads');
  for (const path of ['/orders', '/payments/create-order', '/cart', '/admin/products']) {
    assert.equal((await check(path, 'POST')).errorCode, 'SUBSCRIPTION_REQUIRED');
  }
  status.status = 'ACTIVE';
  assert.equal((await check('/admin/reports')).errorCode, 'PLAN_FEATURE_REQUIRED');
  assert.equal((await check('/orders/one/delivery/label')).errorCode, 'PLAN_FEATURE_REQUIRED');
});

test('home launches independent reads before the theme completes and degrades one failed section locally', async t => {
  const Product = require('../models/Product');
  const Category = require('../models/Category');
  const Banner = require('../models/Banner');
  const Settings = require('../models/Settings');
  const WebsiteTheme = require('../models/WebsiteTheme');
  const { getMobileHome } = require('../controllers/storefrontHomeController');
  const started = [];
  const deadlines = [];
  let finishTheme;
  const theme = new Promise(resolve => { finishTheme = resolve; });
  function query(label, result, fail = false) {
    const builder = {
      select: () => builder, sort: () => builder, limit: () => builder,
      maxTimeMS: value => { deadlines.push(value); return builder; },
      lean: () => { started.push(label); return fail ? Promise.reject(new Error('temporary section outage')) : Promise.resolve(result); },
    };
    return builder;
  }
  t.mock.method(WebsiteTheme, 'findOne', () => query('theme', theme));
  t.mock.method(Settings, 'findOne', () => query('settings', { acceptingOrders: false }));
  t.mock.method(Product, 'find', () => query('products', []));
  const populate = t.mock.method(Product, 'populate', async rows => rows);
  t.mock.method(Category, 'find', () => query('categories', []));
  t.mock.method(Banner, 'find', () => query('banners', null, true));
  let body;
  const headers = {};
  const pending = getMobileHome({ query: { format: 'compact' }, tenantFilter: {} }, {
    setHeader(key, value) { headers[key] = value; }, vary() {}, json(data) { body = data; },
  }, error => { throw error; });
  assert.equal(body, undefined, 'theme is still pending');
  assert.equal(started.filter(label => label === 'products').length, 9);
  assert.ok(started.includes('categories'));
  assert.ok(started.includes('banners'));
  assert.ok(started.includes('settings'));
  finishTheme(null);
  await pending;
  assert.equal(populate.mock.callCount(), 1);
  assert.ok(deadlines.every(value => value === 4000));
  assert.deepEqual(body.warnings, ['banners']);
  assert.deepEqual(body.banners, []);
  assert.equal(body.settings.acceptingOrders, false);
  assert.equal(body.format, 'compact-v1');
  assert.equal(headers['Cache-Control'], 'no-store');
});
