const test = require('node:test');
const assert = require('node:assert/strict');

const shippingProvider = require('../services/shippingProvider');
const { normalizeShippingSettings, deliveryPrice } = require('../services/shippingRules');
const shiprocket = require('../services/shiprocketProvider');
const delhivery = require('../services/delhiveryProvider');
const xpressbees = require('../services/xpressbeesProvider');
const { checkoutShipping } = require('../services/deliveryService');

const PREFIXES = ['BLUEDART_', 'SHIPROCKET_', 'DELHIVERY_', 'XPRESSBEES_'];
const original = new Map();
const originalFetch = global.fetch;

test.before(() => {
  for (const key of Object.keys(process.env).filter(name => PREFIXES.some(prefix => name.startsWith(prefix)))) {
    original.set(key, process.env[key]);
    delete process.env[key];
  }
});

test.after(() => {
  for (const key of Object.keys(process.env).filter(name => PREFIXES.some(prefix => name.startsWith(prefix)))) delete process.env[key];
  for (const [key, value] of original) process.env[key] = value;
  global.fetch = originalFetch;
});

function address(fullName, pincode) {
  return { fullName, mobile: '9816978086', houseNo: '12', area: 'Market Road', city: 'Kangra', state: 'Himachal Pradesh', pincode };
}

function booking() {
  return {
    providerRef: 'S1234567890',
    pickupAddress: address('Store owner', '176001'),
    destination: address('Customer name', '110001'),
    parcel: { weightKg: 0.75, chargeableWeightKg: 0.9, lengthCm: 30, widthCm: 25, heightCm: 6 },
    service: { courierId: '42', mode: 'Surface' },
  };
}

function order() {
  return {
    finalAmount: 1299, deliveryCharge: 99, codCharge: 0, discount: 0,
    paymentMethod: 'COD', paymentStatus: 'Pending', invoiceNumber: 'SC-1001',
    orderItems: [{ name: 'Printed saree', sku: 'SAR-1', quantity: 1, price: 1200 }],
  };
}

test('provider registry exposes every choice without returning credential values', () => {
  process.env.DELHIVERY_TOKEN = 'never-expose-delhivery-token';
  process.env.DELHIVERY_CLIENT_NAME = 'test-client';
  process.env.DELHIVERY_WAREHOUSE_NAME = 'test-warehouse';
  process.env.SHIPROCKET_EMAIL = 'api@example.com';
  process.env.SHIPROCKET_PASSWORD = 'never-expose-shiprocket-password';
  process.env.SHIPROCKET_PICKUP_LOCATION = 'test-pickup';
  process.env.SHIPROCKET_FALLBACK_EMAIL = 'fallback@example.com';
  const providers = shippingProvider.getShippingProviders('delhivery');
  assert.deepEqual(providers.map(item => item.name), ['manual', 'bluedart', 'shiprocket', 'delhivery', 'xpressbees']);
  assert.equal(providers.find(item => item.name === 'delhivery').selected, true);
  const serialized = JSON.stringify(providers);
  assert.doesNotMatch(serialized, /never-expose-(delhivery-token|shiprocket-password)/);
  for (const provider of providers) {
    assert.equal(typeof provider.label, 'string');
    assert.equal(typeof provider.configured, 'boolean');
    assert.ok(Array.isArray(provider.missing));
  }
  for (const key of ['DELHIVERY_TOKEN', 'DELHIVERY_CLIENT_NAME', 'DELHIVERY_WAREHOUSE_NAME', 'SHIPROCKET_EMAIL', 'SHIPROCKET_PASSWORD', 'SHIPROCKET_PICKUP_LOCATION', 'SHIPROCKET_FALLBACK_EMAIL']) delete process.env[key];
});

test('shipping settings accept all providers and restrict live-rate pricing', () => {
  const pickup = address('Store owner', '176001');
  for (const provider of ['manual', 'bluedart', 'shiprocket', 'delhivery', 'xpressbees']) {
    const updates = { shippingProvider: provider, shippingPricingMode: 'fixed', shippingFreeAboveEnabled: true, shippingPickup: pickup };
    assert.equal(normalizeShippingSettings(updates, {}).shippingProvider, provider);
  }
  assert.throws(() => normalizeShippingSettings({ shippingProvider: 'bluedart', shippingPricingMode: 'carrier', shippingFreeAboveEnabled: true, shippingPickup: pickup }, {}), /Live carrier pricing/);
  assert.equal(normalizeShippingSettings({ shippingProvider: 'shiprocket', shippingPricingMode: 'carrier', shippingFreeAboveEnabled: false, shippingPickup: pickup }, {}).shippingPricingMode, 'carrier');
  assert.deepEqual(deliveryPrice(500, { pincode: '110001' }, {}, { shippingProvider: 'shiprocket', shippingPricingMode: 'carrier', shippingFreeAboveEnabled: false }, 87.456), { charge: 87.46, pricingSource: 'carrier:shiprocket' });
});

test('Shiprocket selects the configured strategy and builds a COD order', () => {
  process.env.SHIPROCKET_PICKUP_LOCATION = 'Main Warehouse';
  process.env.SHIPROCKET_FALLBACK_EMAIL = 'orders@example.com';
  process.env.SHIPROCKET_SELECTION_STRATEGY = 'cheapest';
  const selected = shiprocket.chooseCourier([
    { courier_company_id: 1, courier_name: 'Fast', rate: 120, rating: 5 },
    { courier_company_id: 2, courier_name: 'Value', rate: 80, rating: 3 },
  ]);
  assert.equal(selected.courier_company_id, 2);
  const payload = shiprocket.orderPayload(booking(), order(), false);
  assert.equal(payload.pickup_location, 'Main Warehouse');
  assert.equal(payload.payment_method, 'COD');
  assert.equal(payload.billing_pincode, '110001');
  assert.equal(payload.order_items[0].sku, 'SAR-1');
});

test('Delhivery reads serviceability and normalizes tracking scans', () => {
  const row = delhivery.postalCode({ delivery_codes: [{ postal_code: { pin: 110001, pre_paid: 'Y', cash: 'Y' } }] }, '110001');
  assert.equal(row.cash, 'Y');
  const tracked = delhivery.tracking({
    ShipmentData: [{ Shipment: {
      AWB: '123456789012', Status: { Status: 'Out for Delivery', StatusDateTime: '2026-09-09T10:00:00Z' },
      Scans: [{ ScanDetail: { Scan: 'In Transit', ScannedLocation: 'Delhi', ScanDateTime: '2026-09-08T10:00:00Z' } }],
    } }],
  }, '123456789012');
  assert.equal(tracked.status, 'OUT_FOR_DELIVERY');
  assert.equal(tracked.events[0].status, 'IN_TRANSIT');
});

test('Xpressbees payload requests pickup and tracking keeps the carrier AWB', () => {
  process.env.XPRESSBEES_WAREHOUSE_NAME = 'Main Warehouse';
  const payload = xpressbees.shipmentPayload(booking(), order(), false);
  assert.equal(payload.request_auto_pickup, 'yes');
  assert.equal(payload.payment_type, 'cod');
  assert.equal(payload.collectable_amount, 1299);
  assert.equal(payload.pickup.warehouse_name, 'Main Warehouse');
  const tracked = xpressbees.tracking({ data: [{ awb_number: 'XB12345678', ship_status: 'Delivered', message: 'Delivered', event_time: '1788937200' }] }, 'XB12345678');
  assert.equal(tracked.awb, 'XB12345678');
  assert.equal(tracked.status, 'DELIVERED');
});

test('checkout uses the provider selected in settings and hides the contracted rate', async () => {
  process.env.XPRESSBEES_EMAIL = 'api@example.com';
  process.env.XPRESSBEES_PASSWORD = 'private-password';
  process.env.XPRESSBEES_WAREHOUSE_NAME = 'Main Warehouse';
  process.env.XPRESSBEES_LIVE_BOOKING_ENABLED = 'true';
  global.fetch = async (url) => {
    if (String(url).endsWith('/users/login')) return new Response(JSON.stringify({ data: { token: 'test-access-token' } }), { status: 200 });
    if (String(url).endsWith('/courier/serviceability')) return new Response(JSON.stringify({ status: true, data: [{ id: 7, name: 'Xpressbees Surface', total_price: 85 }] }), { status: 200 });
    throw new Error(`Unexpected test URL: ${url}`);
  };
  const result = await checkoutShipping({
    items: [{ quantity: 1, shippingWeightKg: 0.5 }],
    settings: {
      shippingProvider: 'xpressbees', shippingPricingMode: 'carrier', shippingFreeAboveEnabled: false,
      shippingPickup: address('Store owner', '176001'), shippingDefaultWeightKg: 0.5,
      shippingLengthCm: 30, shippingWidthCm: 25, shippingHeightCm: 5, shippingVolumetricDivisor: 5000,
    },
    address: address('Customer name', '110001'), paymentMethod: 'CARD', amount: 1200,
  });
  assert.equal(result.provider, 'xpressbees');
  assert.equal(result.deliveryCharge, 85);
  assert.equal(result.serviceName, 'Xpressbees Surface');
  assert.equal(Object.hasOwn(result, 'providerRate'), false);
  global.fetch = originalFetch;
  for (const key of ['XPRESSBEES_EMAIL', 'XPRESSBEES_PASSWORD', 'XPRESSBEES_WAREHOUSE_NAME', 'XPRESSBEES_LIVE_BOOKING_ENABLED']) delete process.env[key];
});
