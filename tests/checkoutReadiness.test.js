const test = require('node:test');
const assert = require('node:assert/strict');
const Order = require('../models/Order');
const CheckoutAttempt = require('../models/CheckoutAttempt');
const { findCheckoutReplay, beginPaymentAttempt } = require('../services/checkoutSafetyService');

test('checkout waits for order deduplication indexes before looking for a replay', async t => {
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  t.mock.method(Order, 'init', () => ready);
  const lookup = t.mock.method(Order, 'findOne', () => ({ select: async () => null }));
  const pending = findCheckoutReplay({ userId: 'customer', attemptId: 'attempt', fingerprint: 'bag' });
  await Promise.resolve();
  assert.equal(lookup.mock.callCount(), 0);
  release();
  assert.equal(await pending, null);
  assert.equal(lookup.mock.callCount(), 1);
});

test('payment setup waits for its unique attempt index before claiming the attempt', async t => {
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  t.mock.method(CheckoutAttempt, 'init', () => ready);
  const create = t.mock.method(CheckoutAttempt, 'create', async () => ({ _id: 'claim' }));
  const pending = beginPaymentAttempt({ userId: 'customer', attemptId: 'attempt', fingerprint: 'bag' });
  await Promise.resolve();
  assert.equal(create.mock.callCount(), 0);
  release();
  assert.equal((await pending).owned, true);
  assert.equal(create.mock.callCount(), 1);
});

test('checkout fails closed when its unique index could not be created', async t => {
  t.mock.method(Order, 'init', async () => { throw new Error('unique index unavailable'); });
  const lookup = t.mock.method(Order, 'findOne', () => { throw new Error('unexpected lookup'); });
  await assert.rejects(findCheckoutReplay({ userId: 'customer', attemptId: 'attempt', fingerprint: 'bag' }), /unique index unavailable/);
  assert.equal(lookup.mock.callCount(), 0);
});
