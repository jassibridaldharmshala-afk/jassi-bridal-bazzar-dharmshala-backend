const test = require('node:test');
const assert = require('node:assert/strict');
const { request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createAdmin, createProduct } = require('./factories');
const Category = require('../models/Category');

test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(resetDatabase);

test('public product lookup tolerates whitespace and case in a legacy slug', async () => {
  const product = await createProduct({ slug: 'Royal-Silk-Saree ' });

  const byId = await request(`/api/products/${product._id}`);
  const byCleanSlug = await request('/api/products/Royal-Silk-Saree');
  const byDifferentCase = await request('/api/products/royal-silk-saree');

  assert.equal(byId.status, 200);
  assert.equal(byCleanSlug.status, 200);
  assert.equal(byDifferentCase.status, 200);
  assert.equal(byCleanSlug.data._id, String(product._id));
});

test('admin product creation stores a canonical slug', async () => {
  const { token } = await createAdmin();
  const category = await Category.create({ name: 'Dresses', slug: 'dresses' });
  const created = await request('/api/admin/products', {
    method: 'POST',
    token,
    body: {
      name: 'Royal Silk Dress',
      slug: ' Royal Silk Dress ',
      sku: 'ROYAL-DRESS-1',
      category: category._id,
      price: 1499,
      originalPrice: 2499,
      stock: 3,
      images: [{ url: '/uploads/test.jpg', primary: true }],
    },
  });

  assert.equal(created.status, 201);
  assert.equal(created.data.slug, 'royal-silk-dress');
  const detail = await request('/api/products/royal-silk-dress');
  assert.equal(detail.status, 200);
  assert.equal(detail.data._id, created.data._id);
});
