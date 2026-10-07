const test = require('node:test');
const assert = require('node:assert/strict');
const controlPlane = require('../services/controlPlaneClient');

test('a basic managed licence includes customer tracking and manual fulfilment, not carrier automation', async t => {
  const status = { managed: true, status: 'ACTIVE', features: [], limits: {} };
  t.mock.method(controlPlane, 'licenseStatus', async () => status);
  // The middleware captures licenseStatus when imported. Reload only this
  // module so the test exercises its actual route matching with a safe stub.
  const modulePath = require.resolve('../middleware/externalLicenseMiddleware');
  const originalModule = require.cache[modulePath];
  delete require.cache[modulePath];
  const middleware = require(modulePath);
  t.after(() => {
    if (originalModule) require.cache[modulePath] = originalModule;
    else delete require.cache[modulePath];
  });
  async function check(method, path) {
    let error;
    let called = false;
    const req = { method, originalUrl: `/api${path}`, user: { _id: 'customer' } };
    await middleware(req, {}, value => { called = true; error = value; });
    assert.equal(called, true);
    assert.equal(req.platformLicense, status);
    return error;
  }
  for (const path of ['/orders/order-id/delivery?refresh=1', '/returns/return-id/delivery', '/returns/return-id/replacement-delivery']) {
    assert.equal(await check('GET', path), undefined, `${path} must remain available without shippingAutomation`);
  }
  assert.equal(await check('PUT', '/admin/orders/order-id/shipment'), undefined);
  for (const [method, path] of [
    ['POST', '/orders/order-id/delivery/book'], ['POST', '/orders/order-id/delivery/pickup'],
    ['POST', '/orders/order-id/delivery/reconcile'], ['GET', '/orders/order-id/delivery/label'],
    ['POST', '/returns/return-id/replacement-delivery/book'],
    ['POST', '/admin/rentals/bookings/booking-id/courier/outbound/book'],
    ['POST', '/seller/rentals/bookings/booking-id/courier/inbound/pickup'],
    ['GET', '/admin/rentals/bookings/booking-id/courier/outbound/label'],
  ]) {
    assert.equal((await check(method, path))?.errorCode, 'PLAN_FEATURE_REQUIRED', path);
  }
  status.status = 'SUSPENDED';
  assert.equal(await check('GET', '/orders/order-id/delivery?refresh=1'), undefined, 'existing delivery history remains readable');
  assert.equal((await check('PUT', '/admin/orders/order-id/shipment'))?.errorCode, 'SUBSCRIPTION_REQUIRED', 'the manual delivery route does not bypass licence write restrictions');
});
