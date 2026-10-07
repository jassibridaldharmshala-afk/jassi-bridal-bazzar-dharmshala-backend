const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

// Never load application credentials or fall back to an application database.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'isolated-audit-integration-test-secret';
process.env.MONGOMS_RUNTIME_DOWNLOAD = 'false';

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const express = require('express');
const User = require('../models/User');
const Product = require('../models/Product');
const AuditLog = require('../models/AuditLog');
const { generateToken } = require('../utils/generateToken');
const { protect } = require('../middleware/authMiddleware');
const { adminOnly } = require('../middleware/adminMiddleware');
const { notFound, errorHandler } = require('../middleware/errorMiddleware');
const { logAudit } = require('../services/auditService');

test('audit popup API flow persists changes through real auth, routes and MongoDB', { timeout: 60000 }, async (t) => {
  let mongo; let server; let baseUrl;
  const cache = path.resolve(__dirname, '../node_modules/.cache/mongodb-binaries');
  const cachedBinary = path.join(cache, 'mongod-x64-win32-7.0.14.exe');
  const temporaryRoot = path.resolve(__dirname, '../../.tmp');
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const databasePath = fs.mkdtempSync(path.join(temporaryRoot, 'audit-integration-'));
  const request = async (suffix, { token, method = 'GET' } = {}) => {
    const response = await fetch(baseUrl + suffix, {
      method, headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(10000),
    });
    return { status: response.status, data: await response.json() };
  };
  try {
    mongo = await MongoMemoryServer.create({
      instance: { dbPath: databasePath, dbName: 'isolated_audit_test', ip: '127.0.0.1' },
      binary: { version: '7.0.14', downloadDir: cache,
        ...(process.platform === 'win32' && fs.existsSync(cachedBinary) ? { systemBinary: cachedBinary } : {}) },
    });
    await mongoose.connect(mongo.getUri(), { dbName: 'isolated_audit_test', serverSelectionTimeoutMS: 10000 });
    assert.equal(mongoose.connection.name, 'isolated_audit_test');
    await Promise.all([User.init(), Product.init(), AuditLog.init()]);

    const app = express();
    app.use('/api/admin/audit-logs', protect, adminOnly, require('../routes/auditAdminRoutes'));
    app.use(notFound); app.use(errorHandler);
    server = await new Promise((resolve, reject) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
      listener.once('error', reject);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}/api/admin/audit-logs`;
    const manager = await User.create({ name: 'Audit test admin', phone: '9500000091', role: 'admin', activeMode: 'admin', isPhoneVerified: true });
    const customer = await User.create({ name: 'Audit test customer', phone: '9000000091', role: 'customer', activeMode: 'customer' });
    const token = generateToken(manager);
    const product = await Product.create({ name: 'Audit test product', slug: 'audit-test-product', price: 500, stock: 0 });
    const savedProduct = await Product.findById(product._id).lean();
    const event = await logAudit({ req: { user: manager }, action: 'STOCK_UPDATE', entityType: 'Product', entityId: product._id, before: { stock: 5 }, after: { stock: 0 } });
    const id = String(event._id);

    await t.test('list, filters and popup details read the persisted event', async () => {
      const list = await request('?q=' + product._id + '&action=STOCK_UPDATE&limit=25&page=1', { token });
      assert.equal(list.status, 200); assert.equal(list.data.total, 1);
      assert.equal(list.data.items[0]._id, id);
      assert.equal(list.data.items[0].before, undefined);
      const details = await request('/' + id, { token });
      assert.equal(details.status, 200); assert.equal(details.data.canDelete, true);
      assert.equal(details.data.actor.name, manager.name);
      assert.equal(details.data.before.stock, 5); assert.equal(details.data.after.stock, 0);
      assert.deepEqual(details.data.changedFields, ['stock']);
    });

    await t.test('anonymous and customer requests cannot delete persisted records', async () => {
      assert.equal((await request('/' + id, { method: 'DELETE' })).status, 401);
      assert.equal((await request('/' + id, { method: 'DELETE', token: generateToken(customer) })).status, 403);
      assert.ok(await AuditLog.exists({ _id: id }));
    });

    await t.test('confirmed deletion persists, refresh removes the event and the product is unaffected', async () => {
      const deletion = await request('/' + id, { method: 'DELETE', token });
      assert.equal(deletion.status, 200); assert.deepEqual(deletion.data, { success: true, id });
      assert.equal(await AuditLog.findById(id), null);
      const refresh = await request('?action=STOCK_UPDATE&q=' + product._id, { token });
      assert.equal(refresh.data.total, 0); assert.deepEqual(refresh.data.items, []);
      assert.deepEqual(await Product.findById(product._id).lean(), savedProduct);
      const removal = await AuditLog.findOne({ action: 'AUDIT_LOG_DELETE', entityId: id }).lean();
      assert.equal(String(removal.actor), String(manager._id));
      assert.equal(removal.before, undefined); assert.equal(removal.after, undefined);
    });

    await t.test('missing events and missing endpoints have distinct error codes', async () => {
      const repeated = await request('/' + id, { method: 'DELETE', token });
      assert.equal(repeated.status, 404); assert.equal(repeated.data.code, 'AUDIT_EVENT_NOT_FOUND');
      const absentRoute = await request('/missing/route', { method: 'DELETE', token });
      assert.equal(absentRoute.status, 404); assert.equal(absentRoute.data.code, 'NOT_FOUND');
    });

    await t.test('competing delete requests remove one event and record one removal', async () => {
      const concurrent = await AuditLog.create({ action: 'PRODUCT_UPDATE', entityType: 'Product' });
      const responses = await Promise.all([1, 2].map(() => request('/' + concurrent._id, { method: 'DELETE', token })));
      assert.deepEqual(responses.map((value) => value.status).sort(), [200, 404]);
      assert.equal(await AuditLog.countDocuments({ action: 'AUDIT_LOG_DELETE', entityId: String(concurrent._id) }), 1);
      assert.equal(await AuditLog.findById(concurrent._id), null);
    });

    await t.test('ordinary admins cannot remove owner-only records or legacy private events', async () => {
      for (const fields of [{ action: 'CONFIG_UPDATE', visibility: 'OWNER' }, { action: 'MASTER_CONFIG_UPDATE' }]) {
        const privateEvent = await AuditLog.create({ entityType: 'Configuration', ...fields });
        const deletion = await request('/' + privateEvent._id, { method: 'DELETE', token });
        assert.equal(deletion.status, 404); assert.equal(deletion.data.code, 'AUDIT_EVENT_NOT_FOUND');
        assert.ok(await AuditLog.exists({ _id: privateEvent._id }));
      }
    });
  } finally {
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
    // Remove only the unique test directory verified to be under this workspace.
    const resolved = path.resolve(databasePath);
    if (path.dirname(resolved) === temporaryRoot && path.basename(resolved).startsWith('audit-integration-')) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
});
