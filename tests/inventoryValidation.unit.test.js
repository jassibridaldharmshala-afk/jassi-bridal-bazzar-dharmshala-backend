const test = require('node:test');
const assert = require('node:assert/strict');
const Product = require('../models/Product');
const InventoryTransaction = require('../models/InventoryTransaction');
require('../services/auditService').logAudit = () => {};
const controller = require('../controllers/productController');
const productId = '0123456789abcdef01234567';
const storeId = '0123456789abcdef11111111';
async function invoke(handler, body, extra = {}) {
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  let error;
  await handler({ params: { id: productId }, body, ...extra }, res, (value) => { error = value; });
  return { res, error };
}

test('stock updates reject blank, fractional and non-finite values before querying products', async (t) => {
  const lookup = t.mock.method(Product, 'findOne', async () => { throw new Error('Must not query'); });
  for (const stock of [undefined, null, '', ' ', true, false, [], {}, -1, 1.2, 'NaN', Infinity]) {
    const { res, error } = await invoke(controller.updateStock, { stock });
    assert.equal(error, undefined);
    assert.equal(res.statusCode, 400, String(stock));
  }
  assert.equal(lookup.mock.callCount(), 0);
});

test('valid zero and whole-number stock edits use a guarded ledger-backed update', async (t) => {
  let current = 4;
  const query = (value) => ({ select() { return this; }, async session() { return value; } });
  t.mock.method(Product, 'findOne', () => query({ _id: productId, stock: current, variants: [], inventoryRevision: 0 }));
  t.mock.method(Product, 'findOneAndUpdate', (_filter, update) => {
    current = update.$set.stock;
    return { select: async () => ({ _id: productId, stock: current, variants: [], inventoryRevision: 1 }) };
  });
  t.mock.method(InventoryTransaction, 'create', async (docs) => [{ _id: 'movement-1', ...docs[0] }]);
  for (const stock of [0, '7']) {
    const { res, error } = await invoke(controller.updateStock, { stock, expectedStock: current });
    assert.equal(error, undefined); assert.equal(res.statusCode, 200);
    assert.equal(res.body.stock, Number(stock));
  }
});

test('marking out of stock requires confirmation and scopes the product lookup', async (t) => {
  assert.equal((await invoke(controller.markOutOfStock, {})).res.statusCode, 400);
  t.mock.method(Product, 'findOne', (filter) => {
    assert.deepEqual(filter, { $and: [{ _id: productId }, { storeId }] });
    return { select() { return this; }, async session() { return null; } };
  });
  const req = { tenantFilter: { storeId }, store: { _id: storeId } };
  assert.equal((await invoke(controller.markOutOfStock, { confirm: true }, req)).error.statusCode, 404);
});
