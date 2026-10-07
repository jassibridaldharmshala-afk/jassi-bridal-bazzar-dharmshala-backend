const test = require('node:test');
const assert = require('node:assert/strict');
const dns = require('node:dns');
const { usePublicDnsForAtlasSrv } = require('../config/db');

function environment(t, value) {
  const previous = process.env.MONGO_DNS_SERVERS;
  if (value === undefined) delete process.env.MONGO_DNS_SERVERS;
  else process.env.MONGO_DNS_SERVERS = value;
  t.after(() => {
    if (previous === undefined) delete process.env.MONGO_DNS_SERVERS;
    else process.env.MONGO_DNS_SERVERS = previous;
  });
  return {
    callback: t.mock.method(dns, 'setServers', () => {}),
    promise: t.mock.method(dns.promises, 'setServers', () => {}),
  };
}

test('Atlas configures both DNS APIs even when the promise API was already imported', (t) => {
  const spies = environment(t);
  usePublicDnsForAtlasSrv('mongodb+srv://cluster.example.test/database');
  assert.deepEqual(spies.callback.mock.calls[0].arguments, [['8.8.8.8', '1.1.1.1']]);
  assert.deepEqual(spies.promise.mock.calls[0].arguments, [['8.8.8.8', '1.1.1.1']]);
});

test('a configured DNS list is applied to both APIs', (t) => {
  const spies = environment(t, '1.1.1.1, 8.8.4.4');
  usePublicDnsForAtlasSrv('mongodb+srv://cluster.example.test/database');
  assert.deepEqual(spies.callback.mock.calls[0].arguments, [['1.1.1.1', '8.8.4.4']]);
  assert.deepEqual(spies.promise.mock.calls[0].arguments, [['1.1.1.1', '8.8.4.4']]);
});

test('direct MongoDB connections leave DNS configuration untouched', (t) => {
  const spies = environment(t);
  usePublicDnsForAtlasSrv('mongodb://127.0.0.1:27017/test');
  assert.equal(spies.callback.mock.callCount(), 0);
  assert.equal(spies.promise.mock.callCount(), 0);
});

test('system mode explicitly keeps existing DNS resolvers', (t) => {
  const spies = environment(t, 'system');
  usePublicDnsForAtlasSrv('mongodb+srv://cluster.example.test/database');
  assert.equal(spies.callback.mock.callCount(), 0);
  assert.equal(spies.promise.mock.callCount(), 0);
});

test('invalid DNS configuration leaves both resolvers unchanged and reports configuration failure', (t) => {
  const spies = environment(t, 'not-an-ip');
  const warning = t.mock.method(console, 'warn', () => {});
  usePublicDnsForAtlasSrv('mongodb+srv://cluster.example.test/database');
  assert.equal(spies.callback.mock.callCount(), 0);
  assert.equal(spies.promise.mock.callCount(), 0);
  assert.match(warning.mock.calls[0].arguments[0], /MONGO_DNS_SERVERS/);
});
