const test = require('node:test');
const assert = require('node:assert/strict');
const { request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createAdmin } = require('./factories');
const Category = require('../models/Category');
const Product = require('../models/Product');

test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(resetDatabase);

test('product API removes legacy size choices from sarees', async () => {
  const { token } = await createAdmin();
  const category = await Category.create({ name: 'Sarees', slug: 'sarees' });
  const response = await request('/api/admin/products', {
    method: 'POST',
    token,
    body: {
      name: 'Royal Silk Saree',
      sku: 'SAREE-SIZE-1',
      category: category._id,
      price: 1299,
      originalPrice: 2499,
      stock: 4,
      images: [{ url: '/uploads/test.jpg', primary: true }],
      sizingMode: 'auto',
      sizeChartProfile: 'auto',
      sizes: ['S', 'M', 'XL'],
      variants: [{ size: 'S', color: 'Pink', stock: 4 }],
      sizeChart: { unit: 'in', rows: [{ size: 'S', bust: 36 }] },
    },
  });

  assert.equal(response.status, 201);
  assert.deepEqual(response.data.sizes, []);
  assert.deepEqual(response.data.variants, []);
  assert.deepEqual(response.data.sizeChart.rows, []);
});

test('product API rejects incomplete dress measurements and accepts a complete chart', async () => {
  const { token } = await createAdmin();
  const category = await Category.create({ name: 'Dresses', slug: 'dresses' });
  const base = {
    name: 'Rose Maxi Dress',
    sku: 'DRESS-SIZE-1',
    category: category._id,
    price: 1499,
    originalPrice: 2499,
    stock: 4,
    images: [{ url: '/uploads/test.jpg', primary: true }],
    sizingMode: 'sized',
    sizeChartProfile: 'auto',
    sizes: ['S'],
  };
  const incomplete = await request('/api/admin/products', {
    method: 'POST',
    token,
    body: { ...base, sizeChart: { unit: 'in', rows: [{ size: 'S', bust: 36 }] } },
  });
  assert.equal(incomplete.status, 400);
  assert.match(incomplete.data.message, /complete the size chart/i);

  const complete = await request('/api/admin/products', {
    method: 'POST',
    token,
    body: {
      ...base,
      sizeChart: {
        unit: 'in',
        rows: [{ size: 'S', acrossShoulder: 14, sleeveLength: 18, bust: 36, waist: 30, frontLength: 51, hips: 38 }],
      },
    },
  });
  assert.equal(complete.status, 201);
  assert.equal(complete.data.sizeChart.rows[0].frontLength, 51);
});

test('product API rejects invalid variant inventory before it can be silently normalized', async () => {
  const { token } = await createAdmin();
  const category = await Category.create({ name: 'Dresses', slug: 'variant-dresses' });
  const response = await request('/api/admin/products', {
    method: 'POST',
    token,
    body: {
      name: 'Wine Occasion Dress',
      sku: 'DRESS-VARIANT-1',
      category: category._id,
      price: 1499,
      originalPrice: 2499,
      stock: 0,
      images: [{ url: '/uploads/test.jpg', primary: true }],
      sizingMode: 'sized',
      sizeChartProfile: 'dress',
      sizes: ['S'],
      variants: [{ size: 'S', color: 'Wine', stock: -2 }],
      sizeChart: { unit: 'in', rows: [{ size: 'S', acrossShoulder: 14, sleeveLength: 18, bust: 36, waist: 30, frontLength: 51, hips: 38 }] },
    },
  });

  assert.equal(response.status, 400);
  assert.match(response.data.message, /variant stock.*whole number/i);
});

test('product duplicate review finds matching identity and create returns a useful conflict', async () => {
  const { token } = await createAdmin();
  const category = await Category.create({ name: 'Jewellery', slug: 'duplicate-jewellery' });
  await Product.create({ name: 'Pearl Drop Earrings', slug: 'pearl-drop-earrings', sku: 'PEARL-1', barcode: '8901234567890', category: category._id, price: 799, originalPrice: 999, stock: 3, images: [{ url: '/uploads/pearl.jpg', primary: true }] });

  const review = await request('/api/admin/products/duplicate-check?name=Pearl%20Drop%20Earrings&sku=pearl-1', { token });
  assert.equal(review.status, 200);
  assert.equal(review.data.hasConflict, true);
  assert.deepEqual(review.data.conflicts[0].reasons.sort(), ['Name', 'SKU']);

  const duplicate = await request('/api/admin/products', { method: 'POST', token, body: { name: 'Another pearl pair', slug: 'another-pearl-pair', sku: 'pearl-1', category: category._id, price: 699, originalPrice: 899, stock: 2, images: [{ url: '/uploads/new.jpg', primary: true }], sizingMode: 'free-size' } });
  assert.equal(duplicate.status, 409);
  assert.match(duplicate.data.message, /SKU is already used/i);
});
