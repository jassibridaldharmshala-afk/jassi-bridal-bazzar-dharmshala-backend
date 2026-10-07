const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeProductSizing, validateProductSizing, resolveProductSizingMode } = require('../services/productSizingService');

test('saree sizing is removed at the API boundary', () => {
  const normalized = normalizeProductSizing({
    name: 'Silk Saree',
    sizingMode: 'auto',
    sizes: ['S', 'M', 'XL'],
    variants: [{ size: 'S', color: 'Pink', stock: 2 }],
    sizeChart: { unit: 'in', rows: [{ size: 'S', bust: 36 }] },
  }, 'Sarees');

  assert.deepEqual(normalized.sizes, []);
  assert.deepEqual(normalized.variants, []);
  assert.deepEqual(normalized.sizeChart.rows, []);
  assert.equal(validateProductSizing(normalized, 'Sarees'), '');
});

test('a sized dress requires all category measurements', () => {
  const payload = {
    name: 'Pink Dress',
    sizingMode: 'sized',
    sizes: ['S'],
    sizeChart: { unit: 'in', rows: [{ size: 'S', bust: 36 }] },
  };

  assert.match(validateProductSizing(payload, 'Dresses'), /missing across shoulder/i);
});

test('complete dress measurements are normalized and accepted', () => {
  const payload = normalizeProductSizing({
    name: 'Pink Dress',
    sizingMode: 'sized',
    sizes: ['S'],
    sizeChart: {
      unit: 'in',
      rows: [{ size: 'S', acrossShoulder: 14, sleeveLength: 18, bust: 36, waist: 30, frontLength: 51, hips: 38 }],
    },
  }, 'Dresses');

  assert.equal(validateProductSizing(payload, 'Dresses'), '');
  assert.deepEqual(payload.sizeChart.columns, ['acrossShoulder', 'sleeveLength', 'bust', 'waist', 'frontLength', 'hips']);
});

test('purchase sizing matches auto category inference and respects explicit sized overrides', () => {
  for (const product of [
    { name: 'Silk Saree', sizingMode: 'auto', sizes: ['S', 'M'] },
    { name: 'Evening edit', category: { name: 'Sarees' }, sizes: ['S', 'M'] },
    { name: 'Evening edit', category: 'Sarees', sizes: ['S', 'M'] },
    { name: 'Evening edit', productType: 'Scarf', sizes: ['S', 'M'] },
    { name: 'Evening edit', sizingMode: 'free-size', sizes: ['S', 'M'] },
    { name: 'Evening edit', sizeChartProfile: 'free-size', sizes: ['S', 'M'] },
  ]) assert.equal(resolveProductSizingMode(product), 'free-size');
  assert.equal(resolveProductSizingMode({ name: 'Saree blouse', sizingMode: 'sized', sizes: ['S', 'M'] }), 'sized');
  assert.equal(resolveProductSizingMode({ name: 'Dress', sizes: ['S', 'M'] }), 'sized');
});

// Cart and checkout regressions use only in-memory documents and mocked model
// lookups. No listener, database writes or external payment calls are made.
async function cartHarness(t, overrides = {}) {
  const Product = require('../models/Product');
  const Cart = require('../models/Cart');
  const product = { _id: '0123456789abcdef01234567', name: 'Lavender Saree', category: { _id: '0123456789abcdef11111111', name: 'Sarees' },
    sizingMode: 'auto', sizes: ['S', 'M'], colors: ['Lavender'], stock: 7, price: 2899, originalPrice: 5999, variants: [], images: [], ...overrides };
  const cart = new Cart({ user: '0123456789abcdef22222222', items: [] });
  const saved = t.mock.method(cart, 'save', async () => { await cart.validate(); return cart; });
  t.mock.method(Cart, 'findOne', async () => cart);
  t.mock.method(Product, 'findOne', () => {
    const query = Promise.resolve(product);
    query.populate = (path, fields) => { assert.equal(path, 'category'); assert.equal(fields, 'name'); return query; };
    return query;
  });
  t.mock.method(Product, 'find', () => ({ populate: async () => [product] }));
  const controller = require('../controllers/cartController');
  async function invoke(action, body, params = {}) {
    const res = { status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    let error;
    await controller[action]({ user: { _id: cart.user }, headers: {}, protocol: 'http', get: () => 'localhost:5000', body, params }, res, (value) => { error = value; });
    return { res, error };
  }
  return { product, cart, saved, invoke };
}

test('legacy auto-size saree adds without a size, updates quantity and reaches checkout pricing', async (t) => {
  const { product, cart, invoke } = await cartHarness(t);
  const added = await invoke('addToCart', { product: product._id, color: 'Lavender', quantity: 1 });
  assert.equal(added.error, undefined);
  assert.equal(added.res.statusCode, 201);
  assert.equal(added.res.body.items[0].size, '');
  assert.equal(added.res.body.items[0].availableStock, 7);
  assert.equal(added.res.body.items[0].product.category.name, 'Sarees');
  const updated = await invoke('updateCartItem', { quantity: 2 }, { itemId: String(cart.items[0]._id) });
  assert.equal(updated.error, undefined);
  assert.equal(updated.res.body.items[0].quantity, 2);
  const { loadOrderItems } = require('../services/orderPricingService');
  const checkout = await loadOrderItems(cart.items.map((item) => ({ product: String(item.product), size: item.size, color: item.color, quantity: item.quantity })));
  assert.equal(checkout.items[0].size, '');
  assert.equal(checkout.sellingTotal, 5798);
  assert.deepEqual(product.sizes, ['S', 'M']); // The stored catalog is not rewritten.
});

test('category-only free-size items and wishlist Free Size selections are accepted', async (t) => {
  const { product, invoke } = await cartHarness(t, { name: 'Moonlight edit' });
  const { res, error } = await invoke('addToCart', { product: product._id, size: 'Free Size', color: 'Lavender', quantity: 1 });
  assert.equal(error, undefined);
  assert.equal(res.body.items[0].quantity, 1);
});

test('legacy Free Size labels do not require a choice that the storefront hides', async (t) => {
  const { product, invoke } = await cartHarness(t, { name: 'Evening edit', category: { name: 'Collection' }, sizes: [' Free Size '] });
  const { error, res } = await invoke('addToCart', { product: product._id, color: 'Lavender', quantity: 1 });
  assert.equal(error, undefined);
  assert.equal(res.body.items[0].size, '');
});

test('free-size selection still rejects unavailable colours and quantities without saving', async (t) => {
  const { product, saved, invoke } = await cartHarness(t);
  assert.equal((await invoke('addToCart', { product: product._id, color: 'Blue', quantity: 1 })).error.errorCode, 'VARIANT_UNAVAILABLE');
  assert.equal((await invoke('addToCart', { product: product._id, color: 'Lavender', quantity: 8 })).error.errorCode, 'OUT_OF_STOCK');
  assert.equal(saved.mock.callCount(), 0);
});

test('explicitly sized products still require a valid size in cart', async (t) => {
  const { product, saved, invoke } = await cartHarness(t, { sizingMode: 'sized' });
  for (const size of ['', 'XL', 'Free Size']) {
    const { error } = await invoke('addToCart', { product: product._id, size, color: 'Lavender', quantity: 1 });
    assert.equal(error.errorCode, 'VARIANT_UNAVAILABLE');
  }
  assert.equal(saved.mock.callCount(), 0);
  assert.equal((await invoke('addToCart', { product: product._id, size: 'M', color: 'Lavender', quantity: 1 })).error, undefined);
});

test('managed free-size colour variants still use their own selection, price and stock', async (t) => {
  const id = '0123456789abcdef33333333';
  const { product, invoke } = await cartHarness(t, { sizingMode: 'free-size', variants: [{ _id: id, size: '', color: 'Lavender', stock: 2, price: 3100 }] });
  const { res, error } = await invoke('addToCart', { product: product._id, variantId: id, color: 'Lavender', quantity: 1 });
  assert.equal(error, undefined);
  assert.equal(res.body.items[0].variantId, id);
  assert.equal(res.body.items[0].price, 3100);
  assert.equal(res.body.items[0].availableStock, 2);
  assert.equal((await invoke('addToCart', { product: product._id, color: 'Blue', quantity: 1 })).error.errorCode, 'VARIANT_UNAVAILABLE');
  assert.equal((await invoke('addToCart', { product: product._id, variantId: id, color: 'Lavender', quantity: 2 })).error.errorCode, 'OUT_OF_STOCK');
});
