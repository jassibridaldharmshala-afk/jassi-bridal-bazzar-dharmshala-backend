const test = require('node:test');
const assert = require('node:assert/strict');

const { request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createCustomer, createProduct, setSettings, validAddress } = require('./factories');
const Product = require('../models/Product');

test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(async () => {
  await resetDatabase();
  await setSettings();
});

function variantProduct() {
  return createProduct({
    stock: 3,
    variants: [
      { size: 'M', color: 'Red', stock: 2, sku: 'SC-M-RED' },
      { size: 'L', color: 'Red', stock: 1, sku: 'SC-L-RED' },
      { size: 'M', color: 'Blue', stock: 0, sku: 'SC-M-BLUE' },
    ],
  });
}

test('a product without variants still sells against product-level stock', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ stock: 4 });

  const { status } = await request('/api/orders/cod', {
    method: 'POST',
    token,
    body: {
      orderItems: [{ product: String(product._id), quantity: 2, size: 'M', color: 'Red' }],
      shippingAddress: validAddress(),
      paymentMethod: 'COD',
    },
  });

  assert.equal(status, 201);
  assert.equal((await Product.findById(product._id)).stock, 2);
});

test('variant checkout deducts only the selected size and colour', async () => {
  const { token } = await createCustomer();
  const product = await variantProduct();

  const { status, data } = await request('/api/orders/cod', {
    method: 'POST',
    token,
    body: {
      orderItems: [{ product: String(product._id), quantity: 2, size: 'M', color: 'Red' }],
      shippingAddress: validAddress(),
      paymentMethod: 'COD',
    },
  });

  assert.equal(status, 201);
  assert.equal(data.orderItems[0].sku, 'SC-M-RED');
  assert.ok(data.invoiceNumber);

  const refreshed = await Product.findById(product._id);
  const mediumRed = refreshed.variants.find((variant) => variant.size === 'M' && variant.color === 'Red');
  const largeRed = refreshed.variants.find((variant) => variant.size === 'L' && variant.color === 'Red');
  assert.equal(mediumRed.stock, 0);
  assert.equal(largeRed.stock, 1);
  assert.equal(refreshed.stock, 1);
});

test('a zero-stock size/colour combination cannot be ordered', async () => {
  const { token } = await createCustomer();
  const product = await variantProduct();

  const { status, data } = await request('/api/orders/cod', {
    method: 'POST',
    token,
    body: {
      orderItems: [{ product: String(product._id), quantity: 1, size: 'M', color: 'Blue' }],
      shippingAddress: validAddress(),
      paymentMethod: 'COD',
    },
  });

  assert.equal(status, 409);
  assert.equal(data.code, 'OUT_OF_STOCK');
  const refreshed = await Product.findById(product._id);
  assert.equal(refreshed.variants.find((variant) => variant.color === 'Blue').stock, 0);
});

test('an unknown size and colour is refused when variants are managed', async () => {
  const { token } = await createCustomer();
  const product = await variantProduct();

  const { status, data } = await request('/api/orders/cod', {
    method: 'POST',
    token,
    body: {
      orderItems: [{ product: String(product._id), quantity: 1, size: 'XL', color: 'Gold' }],
      shippingAddress: validAddress(),
      paymentMethod: 'COD',
    },
  });

  assert.equal(status, 409);
  assert.equal(data.code, 'VARIANT_UNAVAILABLE');
});
