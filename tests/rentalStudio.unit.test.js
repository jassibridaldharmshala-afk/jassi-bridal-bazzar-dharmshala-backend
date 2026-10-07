const { test } = require('node:test');
const assert = require('node:assert/strict');
const A = require('../services/rentalAlgorithms');
const X = require('../services/rentalStudioAlgorithms');
test('studio features are opt-in while trial safety settings always have bounded defaults', () => {
  const policy = A.validatePolicy();
  for (const key of ['measurementProfilesEnabled', 'tailoringEnabled', 'maintenanceTasksEnabled', 'dateFirstEnabled', 'refundDashboardEnabled', 'piecePerformanceEnabled', 'waitlistEnabled']) assert.equal(policy[key], false);
  assert.throws(() => A.validatePolicy({ trialMinutes: 0 }));
  assert.throws(() => A.validatePolicy({ refundSlaHours: '72' }));
  assert.throws(() => A.validatePolicy({ waitlistEnabled: 'true' }));
});
test('body measurements validate decimal precision, units and allow only whitelisted fields', () => {
  assert.deepEqual(X.measurementValues({ unit: 'in', values: { waist: 32.34 } }), { waist: 32.34 });
  for (const input of [{ unit: 'inch', values: { waist: 32 } }, { unit: 'in', values: {} }, { unit: 'in', values: { waist: -1 } }, { unit: 'cm', values: { waist: '80' } }, { unit: 'cm', values: { secret: 80 } }, { unit: 'in', values: { waist: 32.345 } }]) assert.throws(() => X.measurementValues(input));
});
test('trial windows respect local closing times and store timezone', () => {
  assert.equal(X.trialWindow({ at: '2030-01-10T17:00:00+05:30', minutes: 60 }, A.DEFAULT_POLICY).until.toISOString(), '2030-01-10T12:30:00.000Z');
  assert.throws(() => X.trialWindow({ at: '2030-01-10T17:00:00+05:30', minutes: 120 }, A.DEFAULT_POLICY));
  assert.equal(X.localInstant('2030-01-10T10:00', 'Asia/Kolkata').toISOString(), '2030-01-10T04:30:00.000Z');
  assert.throws(() => X.localInstant('2030-03-10T02:30', 'America/New_York'));
});
test('fingerprints ignore optimistic revisions but detect changed details regardless of field order', () => {
  assert.equal(X.fingerprint({ revision: 1, values: { waist: 32, bust: 36 } }), X.fingerprint({ values: { bust: 36, waist: 32 }, revision: 2 }));
  assert.notEqual(X.fingerprint({ values: { waist: 32 } }), X.fingerprint({ values: { waist: 34 } }));
});
test('interval union prevents double-counted rented days and paise allocations retain exact totals', () => {
  assert.equal(X.intervalHours([[0, 7200000], [3600000, 10800000]], new Date(0), new Date(10800000)), 3);
  assert.deepEqual(X.distribute(101, [1, 1, 1]), [34, 34, 33]);
  assert.equal(X.distribute(301, [10, 25, 75]).reduce((n, v) => n + v), 301);
});
