const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { TEST_DB_NAME, resetDatabase, toTestUri } = require('./helpers');

test('an explicitly supplied test connection always targets the dedicated test database', () => {
  assert.equal(toTestUri('mongodb://127.0.0.1:27017/application?replicaSet=test'), `mongodb://127.0.0.1:27017/${TEST_DB_NAME}?replicaSet=test`);
  assert.equal(toTestUri('mongodb+srv://test.invalid/?retryWrites=true'), `mongodb+srv://test.invalid/${TEST_DB_NAME}?retryWrites=true`);
});

test('destructive test cleanup refuses any other connected database before touching collections', async (t) => {
  const connection = mongoose.connection;
  const descriptors = Object.fromEntries(['readyState', 'name', 'collections'].map(key => [key, Object.getOwnPropertyDescriptor(connection, key)]));
  let deleted = false;
  Object.defineProperties(connection, {
    readyState: { configurable: true, value: 1 },
    name: { configurable: true, value: 'application' },
    collections: { configurable: true, value: { users: { deleteMany: () => { deleted = true; } } } },
  });
  t.after(() => {
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(connection, key, descriptor);
      else delete connection[key];
    }
  });
  await assert.rejects(resetDatabase(), /Refusing test cleanup/);
  assert.equal(deleted, false);
});
