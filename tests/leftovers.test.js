const test = require('node:test');
const assert = require('node:assert/strict');

const { request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createCustomer, createProduct, setSettings } = require('./factories');
const Cart = require('../models/Cart');
const { createProvisionedSeller } = require('./accessFixtures');

test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(async () => {
  await resetDatabase();
  await setSettings({ razorpayEnabled: false, codEnabled: true });
});

async function createPublishedStore(name = 'Riya Fashion') {
  const { user, token, store } = await createProvisionedSeller(name);
  const published = await request('/api/stores/me/current/publish', {
    method: 'POST',
    token,
    headers: { 'x-store-id': store.id },
  });
  assert.equal(published.status, 200);
  return { user, token, store: published.data.store };
}

test('health reports redis without exposing the URL', async () => {
  const health = await request('/health');
  assert.equal(health.status, 200);
  assert.ok(['skipped', 'connected', 'disconnected'].includes(health.data.redis));
  assert.equal(JSON.stringify(health.data).includes('redis://'), false);
  assert.equal(health.headers.get('x-powered-by'), null);
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(health.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.match(health.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(health.data.checks.tenantIndexes.ready, true);
});

test('readiness fails while a required tenant index migration is incomplete', async () => {
  const app = require('../app');
  app.locals.tenantIndexesReady = false;
  try {
    const health = await request('/health');
    assert.equal(health.status, 503);
    assert.equal(health.data.ready, false);
    assert.equal(health.data.checks.tenantIndexes.ready, false);
  } finally {
    app.locals.tenantIndexesReady = true;
  }
});

test('private APIs are not cached and unconfigured Render origins are not trusted', async () => {
  const privateResponse = await request('/api/auth/me');
  assert.equal(privateResponse.status, 401);
  assert.match(privateResponse.headers.get('cache-control'), /no-store/);

  const rejected = await request('/health', { headers: { Origin: 'https://untrusted-client.onrender.com' } });
  assert.equal(rejected.headers.get('access-control-allow-origin'), null);
  const allowed = await request('/health', { headers: { Origin: 'https://samira-collection.onrender.com' } });
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://samira-collection.onrender.com');
});

test('sitemap and share URLs are path-based', async () => {
  const product = await createProduct({ name: 'Red Anarkali', slug: 'red-anarkali-kurti', sku: 'RAK-1' });
  const sitemap = await request('/sitemap.xml');
  assert.equal(sitemap.status, 200);
  assert.equal(String(sitemap.data).includes('/#/'), false);
  assert.ok(String(sitemap.data).includes('/product/red-anarkali-kurti'));

  const share = await request(`/share/product/${product.slug}`);
  assert.equal(share.status, 200);
  assert.equal(String(share.data).includes('/#/'), false);
  assert.ok(String(share.data).includes('/product/red-anarkali-kurti'));
});

test('store resolve uses host and custom domain without DNS automation', async () => {
  const localhost = await request('/api/stores/resolve?host=localhost');
  assert.equal(localhost.status, 200);
  assert.equal(localhost.data.isDefault, true);

  const { token, store } = await createPublishedStore();
  const saved = await request('/api/stores/me/current', {
    method: 'PUT',
    token,
    headers: { 'x-store-id': store.id },
    body: { customDomain: 'riya.shop.test' },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.store.customDomain, 'riya.shop.test');

  const resolved = await request('/api/stores/resolve?host=riya.shop.test');
  assert.equal(resolved.status, 200);
  assert.equal(resolved.data.slug, store.slug);
  assert.equal(resolved.data.isDefault, false);

  const previous = process.env.PLATFORM_ROOT_DOMAIN;
  process.env.PLATFORM_ROOT_DOMAIN = 'example.com';
  try {
    const sub = await request(`/api/stores/resolve?host=${store.slug}.example.com`);
    assert.equal(sub.status, 200);
    assert.equal(sub.data.slug, store.slug);
    const apex = await request('/api/stores/resolve?host=www.example.com');
    assert.equal(apex.data.isDefault, true);
  } finally {
    process.env.PLATFORM_ROOT_DOMAIN = previous;
  }
});

test('guest session cart merges into the user cart on login', async () => {
  const product = await createProduct({ stock: 5, price: 800, originalPrice: 1000 });
  const sessionHeaders = { 'x-session-id': 'guest-session-abc' };

  const empty = await request('/api/cart');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.data.items, []);

  const denied = await request('/api/cart', {
    method: 'POST',
    body: { product: String(product._id), quantity: 1, size: 'M', color: 'Red' },
  });
  assert.equal(denied.status, 401);

  const added = await request('/api/cart', {
    method: 'POST',
    headers: sessionHeaders,
    body: { product: String(product._id), quantity: 1, size: 'M', color: 'Red' },
  });
  assert.equal(added.status, 201);
  assert.equal(added.data.items.length, 1);

  const { token, user } = await createCustomer();
  const merged = await request('/api/cart', {
    token,
    headers: sessionHeaders,
  });
  assert.equal(merged.status, 200);
  assert.equal(merged.data.items.length, 1);
  assert.equal(String((await Cart.findById(merged.data._id)).user), String(user._id));
  assert.equal(await Cart.countDocuments({ sessionId: 'guest-session-abc' }), 0);

  const leftover = await request('/api/cart', { headers: sessionHeaders });
  assert.equal(leftover.data.items.length, 0);
});

test('instagram connect-url stays disconnected without credentials', async () => {
  const { token } = await createPublishedStore();
  const connect = await request('/api/seller/instagram/connect-url', { token });
  assert.equal(connect.status, 200);
  if (connect.data.configured) {
    assert.ok(String(connect.data.authUrl || '').includes('facebook.com'));
  } else {
    assert.equal(connect.data.authUrl, null);
  }

  const media = await request('/api/seller/instagram/media', { token });
  assert.equal(media.status, 200);
  assert.deepEqual(media.data.items, []);
});

test('shipping provider never invents an AWB', async () => {
  const { token } = await createPublishedStore();
  const provider = await request('/api/seller/shipping/provider', { token });
  assert.equal(provider.status, 200);
  assert.equal(provider.data.liveBooking, false);
  assert.ok(['manual', 'bluedart', 'shiprocket', 'delhivery', 'xpressbees'].includes(provider.data.name));
  assert.ok(Array.isArray(provider.data.providers));
});
