const { test } = require('node:test');
const assert = require('node:assert/strict');
const A = require('../services/rentalAlgorithms');
test('per-offer advance stays separate from deposit and applies shop fixed advance once to the remaining cart', () => {
  const base = { _id: 'a', productId: 'p', title: 'Item', dailyRatePaise: 10000, depositPaise: 50000, cleaningFeePaise: 0, alterationFeePaise: 0 };
  const policy = A.validatePolicy({ advanceMode: 'FIXED', advanceAmountPaise: 5000, deliveryModes: ['COURIER'], deliveryFeePaise: 1000, returnFeePaise: 1000 });
  const result = A.quote([{ listing: { ...base, advanceMode: 'FIXED', advanceAmountPaise: 3000 }, quantity: 2 }, { listing: { ...base, _id: 'b' }, quantity: 1 }, { listing: { ...base, _id: 'c' }, quantity: 1 }], { days: 2 }, policy, 'COURIER');
  assert.equal(result.rentalPaise, 82000); assert.equal(result.advanceRentPaise, 11000); assert.equal(result.depositPaise, 200000); assert.equal(result.dueNowPaise, 211000); assert.equal(result.advanceMode, 'PER_ITEM');
  const tiny = A.quote([{ listing: { ...base, dailyRatePaise: 1, advanceMode: 'PERCENT', advancePercent: 1 }, quantity: 1 }], { days: 1 }, A.validatePolicy({ depositTiming: 'PICKUP' }), 'STORE_PICKUP');
  assert.equal(tiny.advanceRentPaise, 1); assert.equal(tiny.dueNowPaise, 1);
});
test('new rental policies cannot disable booking advance, and legacy accepted policies remain readable', () => {
  for (const advancePercent of [0, -1, 101, '', '30']) assert.throws(() => A.validatePolicy({ advancePercent }));
  assert.throws(() => A.validatePolicy({ advanceMode: 'FIXED', advanceAmountPaise: 0 }));
  assert.throws(() => A.validatePolicy({ depositTiming: 'LATER' }));
  assert.throws(() => A.validatePolicy({ requireConditionPhotos: 'true' }));
  assert.equal(A.validatePolicy({ advancePercent: 0 }, { existing: true }).advancePercent, 0);
});
test('fixed advance is capped, rounded positive percentage cannot be free and deposit at pickup is separate', () => {
  const listing = { _id: 'a', productId: 'p', title: 'Piece', dailyRatePaise: 1, depositPaise: 500, cleaningFeePaise: 0, alterationFeePaise: 0 };
  let q = A.quote([{ listing, quantity: 1 }], { days: 1 }, A.validatePolicy({ advancePercent: 1, depositTiming: 'PICKUP' }), 'STORE_PICKUP');
  assert.equal(q.dueNowPaise, 1); assert.equal(q.remainingPaise, 500);
  q = A.quote([{ listing, quantity: 1 }], { days: 1 }, A.validatePolicy({ advanceMode: 'FIXED', advanceAmountPaise: 100000 }), 'STORE_PICKUP');
  assert.equal(q.advanceRentPaise, 1); assert.equal(q.dueNowPaise, 501);
});
test('deposit-at-pickup cancellation caps retention at paid rent rather than treating the advance as deposit', () => {
  const b = { status: 'CONFIRMED', quote: { rentalPaise: 200000, depositPaise: 500000, depositTiming: 'PICKUP' }, ledger: [{ kind: 'COLLECTION', amountPaise: 60000 }], assessments: [] };
  assert.equal(A.paidRent(b), 60000); assert.equal(A.finances(b).depositHeldPaise, 0);
  b.ledger[0].amountPaise = 700000; assert.equal(A.paidRent(b), 200000); assert.equal(A.finances(b).depositHeldPaise, 500000);
});
test('exact matching never allocates missing metadata to new offers, while legacy mappings are preserved', () => {
  const { matchesPiece } = require('../services/rentalInventoryRules');
  const listing = { productId: 'p', size: 'M', colour: 'Red', requirements: [{}], matchingVersion: 2 };
  assert.equal(matchesPiece({ productId: 'p', size: ' m ', colour: 'RED' }, {}, listing), true);
  assert.equal(matchesPiece({ productId: 'p', size: 'L', colour: 'Red' }, {}, listing), false);
  assert.equal(matchesPiece({}, {}, listing), false);
  assert.equal(matchesPiece({}, {}, { ...listing, matchingVersion: 1 }), true);
});
test('overlap uses half-open intervals', () => { assert.equal(A.overlaps({ blockedFrom: 0, blockedUntil: 10 }, { blockedFrom: 10, blockedUntil: 20 }), false); assert.equal(A.overlaps({ blockedFrom: 0, blockedUntil: 11 }, { blockedFrom: 10, blockedUntil: 20 }), true); });
test('timezone and strict number validation reject malformed policies', () => { assert.throws(() => A.validatePolicy({ holdMinutes: '10' })); assert.throws(() => A.validatePolicy({ maximumDays: 1, minimumDays: 2 })); assert.throws(() => A.validatePolicy({ timezone: 'Mars' })); assert.throws(() => A.validatePolicy({ cancellationRules: [{ beforeHours: 12, retainPercent: 30 }] })); });
test('explicit timezone, shop hours, closed days and event ordering are enforced', () => {
  const policy = A.validatePolicy({ minimumLeadHours: 0, preparationHours: 0 });
  const input = { pickupAt: '2030-01-10T10:00:00+05:30', returnDueAt: '2030-01-12T10:00:00+05:30' };
  assert.equal(A.schedule(input, policy, new Date('2030-01-09')).days, 2);
  assert.throws(() => A.schedule({ ...input, pickupAt: '2030-01-10T10:00:00' }, policy));
  assert.throws(() => A.schedule({ ...input, pickupAt: '2030-01-10T23:00:00+05:30' }, policy));
  assert.throws(() => A.schedule(input, { ...policy, closedDates: ['2030-01-10'] }));
  assert.throws(() => A.schedule({ ...input, eventAt: '2030-01-13T12:00:00+05:30' }, policy));
});
test('package pricing and deposit/advance use integer paise', () => {
  const listing = { _id: 'a', productId: 'p', title: 'Lehenga', dailyRatePaise: 100000, depositPaise: 500000, cleaningFeePaise: 20000, alterationFeePaise: 0, packages: [{ days: 3, pricePaise: 250000 }] };
  const q = A.quote([{ listing, quantity: 2 }], { days: 3 }, A.validatePolicy({ advancePercent: 30 }), 'STORE_PICKUP');
  assert.equal(q.rentalPaise, 540000); assert.equal(q.depositPaise, 1000000); assert.equal(q.dueNowPaise, 1162000);
});
test('damage comes from the deposit and does not charge the customer twice', () => {
  const b = { status: 'RETURNED', quote: { rentalPaise: 200000, depositPaise: 500000 }, ledger: [{ kind: 'COLLECTION', amountPaise: 700000, status: 'PROCESSED' }], assessments: [{ approved: true, amountPaise: 100000 }] };
  assert.equal(A.finances(b).balancePaise, 0); assert.equal(A.finances(b).refundablePaise, 400000);
  b.ledger.push({ kind: 'REFUND', amountPaise: 400000, status: 'REVIEW' }); assert.equal(A.finances(b).refundablePaise, 0);
});
test('verified staff can quote immediate counter pickup without opening a public lead-time bypass', () => {
  const policy = A.validatePolicy();
  const input = { pickupAt: '2030-01-10T10:00:00+05:30', returnDueAt: '2030-01-12T10:00:00+05:30' };
  const now = new Date('2030-01-10T09:55:00+05:30');
  assert.throws(() => A.schedule(input, policy, now));
  assert.equal(A.schedule(input, policy, now, { allowImmediate: true }).days, 2);
  assert.throws(() => A.schedule(input, policy, new Date('2030-01-11T09:00:00+05:30'), { allowImmediate: true }));
});
test('advance paid does not turn refundable deposit liability into earned rent', () => {
  const b = { status: 'CONFIRMED', quote: { rentalPaise: 200000, depositPaise: 500000 }, ledger: [{ kind: 'COLLECTION', status: 'PROCESSED', amountPaise: 560000 }] };
  assert.equal(A.finances(b).depositHeldPaise, 500000); assert.equal(A.finances(b).balancePaise, 140000); assert.equal(A.finances(b).refundablePaise, 0);
});
test('the payment adapter distinguishes explicit rejection from unknown outcomes without changing legacy errors', async t => {
  const saved = Object.fromEntries(['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_MOCK'].map(key => [key, process.env[key]]));
  Object.assign(process.env, { RAZORPAY_KEY_ID: 'rzp_test_adapter', RAZORPAY_KEY_SECRET: 'test_adapter_secret', RAZORPAY_MOCK: '0' });
  const sdkPath = require.resolve('razorpay'); require(sdkPath);
  let providerError;
  t.mock.method(require.cache[sdkPath], 'exports', function FakeRazorpay() { this.orders = { create: async () => { throw providerError; } }; });
  const servicePath = require.resolve('../services/razorpayService'), original = require.cache[servicePath]; delete require.cache[servicePath];
  t.after(() => { if (original) require.cache[servicePath] = original; else delete require.cache[servicePath]; for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const gateway = require(servicePath);
  for (const status of [400, 401, 403, 422, 429, 500, 502]) {
    providerError = { statusCode: status, error: { description: 'Provider rejected request' } };
    await assert.rejects(() => gateway.createRazorpayOrder({ amountInPaise: 1000, receipt: 'adapter-test' }), e => e.razorpayDefinitiveRejection === [400, 401, 403, 422].includes(status) && e.statusCode === (status === 401 ? 401 : 500));
  }
  providerError = new Error('Response lost');
  await assert.rejects(() => gateway.createRazorpayOrder({ amountInPaise: 1000, receipt: 'adapter-test' }), e => e.razorpayDefinitiveRejection === false);
});
