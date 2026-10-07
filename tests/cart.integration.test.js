const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
process.env.NODE_ENV = 'test'; process.env.JWT_SECRET = 'isolated-bag-test-key'; process.env.MONGOMS_RUNTIME_DOWNLOAD = 'false';
// Only a temporary database is used. Never read .env or connect to Atlas.
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose'); const express = require('express');
const User = require('../models/User'), Product = require('../models/Product'), Cart = require('../models/Cart');
const { generateToken } = require('../utils/generateToken');
const { errorHandler } = require('../middleware/errorMiddleware');
test('shopping bag persistence, selections and stock checks', { timeout: 30000 }, async t => {
  let mongo, server;
  try {
    mongo = await MongoMemoryServer.create({ binary: { version: '7.0.14', systemBinary: process.platform === 'win32' ? path.resolve(__dirname, '../node_modules/.cache/mongodb-binaries/mongod-x64-win32-7.0.14.exe') : undefined } });
    await mongoose.connect(mongo.getUri(), { dbName: 'isolated_bag_test' });
    const [owner, other] = await User.create([{ phone: '9000000051' }, { phone: '9000000052' }]);
    const product = await Product.create({ name: 'Rose kurti', slug: 'bag-rose', price: 899, originalPrice: 1599, stock: 12, sizingMode: 'sized', sizes: ['S', 'M', 'L'], colors: ['Rose'], variants: [{ size: 'S', color: 'Rose', stock: 5, price: 999 }, { size: 'M', color: 'Rose', stock: 7, price: 1199 }, { size: 'L', color: 'Rose', stock: 0 }] });
    const app = express(); app.use(express.json()); app.use('/cart', require('../routes/cartRoutes')); app.use(errorHandler);
    server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const token = generateToken(owner), otherToken = generateToken(other);
    const request = async (route = '/cart', { method = 'GET', body, auth = token, session = '' } = {}) => {
      const response = await fetch('http://127.0.0.1:' + server.address().port + route, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer ' + auth } : {}), ...(session ? { 'x-session-id': session } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: response.status, data: await response.json() };
    };
    const payload = (size = 'S', quantity = 1) => ({ product: String(product._id), size, color: 'Rose', quantity, price: 1 });
    await t.test('expired credentials must not read or write a guest bag while the customer is signed in', async () => {
      const expired = require('jsonwebtoken').sign({ id: String(owner._id), tokenType: 'access' }, process.env.JWT_SECRET, { expiresIn: -1 });
      const session = 'expired-login-bag-session';
      for (const auth of [expired, 'invalid-access-token']) {
        assert.equal((await request('/cart', { auth, session })).status, 401);
        assert.equal((await request('/cart', { method: 'POST', auth, session, body: payload() })).status, 401);
      }
      assert.equal(await Cart.countDocuments({ sessionId: session }), 0);
      assert.equal((await request('/cart', { auth: '', session })).status, 200);
    });
    await t.test('quantities must be whole, bounded and within stock; client prices are ignored', async () => {
      for (const quantity of [0, -1, 1.5, 21, 'NaN']) assert.equal((await request('/cart', { method: 'POST', body: payload('S', quantity) })).status, 400);
      assert.equal((await request('/cart', { method: 'POST', body: payload('S', 6) })).status, 409);
      const added = await request('/cart', { method: 'POST', body: payload() });
      assert.equal(added.status, 201); assert.equal(added.data.items[0].price, 999);
    });
    await t.test('failed size replacement preserves the original; successful replacement merges exactly once', async () => {
      const original = (await request()).data.items[0];
      const rejected = await request('/cart/' + original._id, { method: 'PUT', body: { size: 'L', color: 'Rose', quantity: 1 } });
      assert.equal(rejected.status, 409); assert.equal((await request()).data.items[0].size, 'S');
      await request('/cart', { method: 'POST', body: payload('M', 2) });
      const merged = await request('/cart/' + original._id, { method: 'PUT', body: { size: 'M', color: 'Rose', quantity: 1 } });
      assert.equal(merged.status, 200); assert.equal(merged.data.items.length, 1);
      assert.equal(merged.data.items[0].quantity, 3); assert.equal(merged.data.items[0].price, 1199);
      assert.equal(merged.data.items[0]._id, original._id);
    });
    await t.test('selection survives reload and purchased-only removal keeps unselected lines', async () => {
      await request('/cart', { method: 'POST', body: payload('S') });
      const items = (await request()).data.items, later = items.find(item => item.size === 'M'), purchased = items.find(item => item.size === 'S');
      const response = await request('/cart/selection', { method: 'POST', body: { itemIds: [later._id], selected: false } });
      assert.equal(response.status, 200); assert.equal((await request()).data.items.find(item => item._id === later._id).selected, false);
      await request('/cart/remove-items', { method: 'POST', body: { itemIds: [purchased._id] } });
      const remaining = (await request()).data.items;
      assert.equal(remaining.length, 1); assert.equal(remaining[0]._id, later._id);
      await request('/cart/remove-items', { method: 'POST', auth: otherToken, body: { itemIds: [later._id] } });
      assert.equal((await request()).data.items.length, 1);
    });
    await t.test('catalogue changes refresh prices, flag stock problems and retain deleted products for removal', async () => {
      await Product.updateOne({ _id: product._id }, { $set: { 'variants.1.price': 1299, 'variants.1.stock': 1 } });
      const item = (await request()).data.items[0];
      assert.equal(item.price, 1299); assert.equal(item.previousPrice, 1199); assert.match(item.issue, /Only 1 left/);
      await Product.updateOne({ _id: product._id }, { $set: { isArchived: true } });
      const hidden = (await request()).data.items[0]; assert.equal(hidden.unavailable, true); assert.ok(!JSON.stringify(hidden.product).includes('Rose kurti'));
      assert.equal((await request('/cart/' + hidden._id, { method: 'DELETE' })).status, 200);
      await Product.updateOne({ _id: product._id }, { $set: { isArchived: false, 'variants.1.stock': 7 } });
    });
    await t.test('concurrent guest adds and sign-in transfers preserve quantities without duplicate merges', async () => {
      const session = 'isolated-bag-guest-session';
      const results = await Promise.all([1, 1, 1].map(quantity => request('/cart', { method: 'POST', auth: '', session, body: payload('S', quantity) })));
      assert.ok(results.every(result => result.status === 201));
      assert.equal((await request('/cart', { auth: '', session })).data.items[0].quantity, 3);
      await request('/cart', { method: 'POST', body: payload('M', 1) });
      const reads = await Promise.all([1, 2, 3].map(() => request('/cart', { session })));
      assert.ok(reads.every(result => result.status === 200));
      const merged = (await request('/cart', { session })).data.items;
      assert.equal(merged.find(item => item.size === 'S').quantity, 3);
      assert.equal(merged.find(item => item.size === 'M').quantity, 1);
      assert.equal(await Cart.countDocuments({ sessionId: session }), 0);
    });
  } finally { if (server) await new Promise(resolve => server.close(resolve)); await mongoose.disconnect(); if (mongo) await mongo.stop(); }
});
