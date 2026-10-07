const test = require('node:test');
const assert = require('node:assert/strict');

const {
  nextPeriodEnd, planSummary, hasStoreFeature, licenseStatus,
} = require('../config/storePlans');
const { requireActiveStoreLicenseForWrites } = require('../middleware/storeMiddleware');

test('old trial stores receive an automatic 30-day expiry even when endsAt is missing', () => {
  const now = new Date('2026-09-09T12:00:00.000Z');
  const active = { plan: 'PROFESSIONAL', createdAt: new Date('2026-08-11T12:00:00.000Z'), license: { status: 'TRIAL', startsAt: new Date('2026-08-11T12:00:00.000Z') } };
  const expired = { ...active, createdAt: new Date('2026-08-09T11:59:00.000Z'), license: { status: 'TRIAL', startsAt: new Date('2026-08-09T11:59:00.000Z') } };
  assert.equal(licenseStatus(active, now), 'TRIAL');
  assert.equal(licenseStatus(expired, now), 'EXPIRED');
  assert.equal(planSummary(active, now).daysRemaining, 1);
});

test('plan summary applies feature and numeric master overrides without exposing credentials', () => {
  const store = {
    plan: 'PROFESSIONAL',
    license: {
      status: 'ACTIVE', billingCycle: 'LIFETIME',
      featureOverrides: ['shippingAutomation'], disabledFeatures: ['analytics'],
      limitOverrides: { products: 42 },
    },
  };
  const summary = planSummary(store);
  assert.equal(summary.endsAt, null);
  assert.equal(summary.limits.products, 42);
  assert.equal(summary.limits.ordersPerMonth, 2000);
  assert.equal(hasStoreFeature(store, 'shippingAutomation'), true);
  assert.equal(hasStoreFeature(store, 'analytics'), false);
  assert.doesNotMatch(JSON.stringify(summary), /RAZORPAY_KEY_SECRET|WEBHOOK_SECRET/);
});

test('billing periods handle month ends, leap years and lifetime access', () => {
  assert.equal(nextPeriodEnd('MONTHLY', new Date('2026-01-31T10:00:00Z')).toISOString(), '2026-02-28T10:00:00.000Z');
  assert.equal(nextPeriodEnd('YEARLY', new Date('2024-02-29T10:00:00Z')).toISOString(), '2025-02-28T10:00:00.000Z');
  assert.equal(nextPeriodEnd('LIFETIME'), null);
});

test('expired stores retain reads but backend blocks seller writes', () => {
  const store = { plan: 'BASIC', license: { status: 'EXPIRED', billingCycle: 'MONTHLY', endsAt: new Date('2026-01-01') } };
  let readError;
  requireActiveStoreLicenseForWrites({ method: 'GET', path: '/products', store }, {}, (error) => { readError = error; });
  assert.equal(readError, undefined);
  let writeError;
  requireActiveStoreLicenseForWrites({ method: 'POST', path: '/products', store }, {}, (error) => { writeError = error; });
  assert.equal(writeError?.errorCode, 'SUBSCRIPTION_REQUIRED');
  assert.equal(writeError?.statusCode, 402);
});

test('seller subscription endpoints are registered before the write licence gate', () => {
  const router = require('../routes/sellerRoutes');
  const paths = router.stack.map((layer) => layer.route?.path || (layer.name === 'requireActiveStoreLicenseForWrites' ? 'LICENSE_GATE' : null)).filter(Boolean);
  assert.deepEqual(paths.slice(0, 4), ['/subscription', '/subscription/checkout', '/subscription/verify', 'LICENSE_GATE']);
});
