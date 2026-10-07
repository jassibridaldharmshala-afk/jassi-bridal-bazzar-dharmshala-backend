const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
process.env.NODE_ENV = 'test'; process.env.JWT_SECRET = 'wishlist-isolated-test-key'; process.env.MONGOMS_RUNTIME_DOWNLOAD = 'false';
// This suite never loads .env or falls back to the application database.
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const express = require('express');
const User = require('../models/User'); const Product = require('../models/Product'); require('../models/Category');
const { generateToken } = require('../utils/generateToken');
const { errorHandler } = require('../middleware/errorMiddleware');

test('wishlist persistence and bag operations use real isolated database records', { timeout: 30000 }, async t => {
  let mongo; let server;
  try {
    mongo = await MongoMemoryServer.create({ binary: { version: '7.0.14', systemBinary: process.platform === 'win32' ? path.resolve(__dirname, '../node_modules/.cache/mongodb-binaries/mongod-x64-win32-7.0.14.exe') : undefined } });
    await mongoose.connect(mongo.getUri(), { dbName: 'isolated_wishlist_test' });
    assert.equal(mongoose.connection.name, 'isolated_wishlist_test');
    const [owner, other] = await User.create([{ phone: '9000000041' }, { phone: '9000000042' }]);
    const [a, b, hidden] = await Product.create([
      { name: 'Rose kurti', slug: 'wish-rose', price: 899, originalPrice: 1499, stock: 3, sizingMode: 'sized', sizes: ['S', 'M'], colors: ['Rose'], variants: [{ size: 'S', color: 'Rose', stock: 2, price: 1099 }, { size: 'M', color: 'Rose', stock: 0 }] },
      { name: 'Ivory saree', slug: 'wish-ivory', price: 799, stock: 0, sizingMode: 'free-size' },
      { name: 'Private draft product', slug: 'wish-hidden', price: 899, stock: 3, isActive: false },
    ]);
    const app = express(); app.use(express.json()); app.use('/wishlist', require('../routes/wishlistRoutes')); app.use('/cart', require('../routes/cartRoutes')); app.use(errorHandler);
    server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const token = generateToken(owner); const otherToken = generateToken(other);
    const request = async (route, { method = 'GET', body, auth = token, session } = {}) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer ' + auth } : {}), ...(session ? { 'x-session-id': session } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: response.status, data: await response.json() };
    };
    await t.test('guest lookup refreshes catalogue facts and hides private products', async () => {
      const response = await request('/wishlist/resolve', { method: 'POST', auth: '', body: { ids: [String(a._id), String(hidden._id), String(b._id)] } });
      assert.equal(response.status, 200); assert.equal(response.data[0].variants[0].price, 1099);
      assert.equal(response.data[1].unavailable, true); assert.ok(!JSON.stringify(response.data[1]).includes('Private'));
      assert.equal(response.data[2].stock, 0); assert.equal((await request('/wishlist', { auth: '' })).status, 401);
      assert.equal((await request('/wishlist/resolve', { method: 'POST', body: { ids: [{ $ne: null }] } })).status, 400);
      assert.equal((await request('/wishlist/' + hidden._id, { method: 'POST' })).status, 404);
    });
    await t.test('simultaneous saves are atomic, duplicate saves are idempotent and accounts are isolated', async () => {
      const results = await Promise.all([a, b, a].map(product => request('/wishlist/' + product._id, { method: 'POST' })));
      assert.ok(results.every(result => result.status === 200));
      assert.equal((await User.findById(owner._id)).wishlist.length, 2);
      assert.equal((await request('/wishlist')).data.length, 2);
      assert.equal((await request('/wishlist', { auth: otherToken })).data.length, 0);
      await request('/wishlist/' + a._id, { method: 'DELETE', auth: otherToken });
      assert.equal((await User.findById(owner._id)).wishlist.length, 2);
    });
    await t.test('bag requests enforce SKU price and stock before the saved item can be removed', async () => {
      const response = await request('/cart', { method: 'POST', body: { product: String(a._id), size: 'S', color: 'Rose', variantId: String(a.variants[0]._id), quantity: 1 } });
      assert.equal(response.status, 201); assert.equal(response.data.items[0].price, 1099);
      const rejected = await request('/cart', { method: 'POST', body: { product: String(a._id), size: 'M', color: 'Rose', variantId: String(a.variants[1]._id), quantity: 1 } });
      assert.equal(rejected.status, 409); assert.equal((await request('/wishlist')).data.length, 2);
      assert.equal((await request('/wishlist/' + a._id, { method: 'DELETE' })).status, 200);
      assert.equal((await request('/wishlist')).data.length, 1);
    });
    await t.test('deleted and archived saves remain visible as removable placeholders', async () => {
      await Product.deleteOne({ _id: b._id });
      const before = (await User.findById(owner._id)).updatedAt;
      const response = await request('/wishlist');
      assert.equal(response.data[0].unavailable, true);
      assert.equal(String((await User.findById(owner._id)).updatedAt), String(before), 'Reading the wishlist never rewrites it');
      assert.equal((await request('/wishlist/' + b._id, { method: 'DELETE' })).status, 200);
      assert.equal((await request('/wishlist')).data.length, 0);
      await request('/wishlist/' + a._id, { method: 'POST' });
      await Product.updateOne({ _id: a._id }, { isArchived: true });
      assert.equal((await request('/wishlist')).data[0].unavailable, true);
      await request('/wishlist/' + a._id, { method: 'DELETE' });
      assert.equal((await request('/wishlist')).data.length, 0);
    });
  } finally { if (server) await new Promise(resolve => server.close(resolve)); await mongoose.disconnect(); if (mongo) await mongo.stop(); }
});
