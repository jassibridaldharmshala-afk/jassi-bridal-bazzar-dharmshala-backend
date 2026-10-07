const test = require('node:test');
const assert = require('node:assert/strict');
const Settings = require('../models/Settings');
const { DEFAULTS, normalizeShippingSettings, deliveryPrice, packageForItems } = require('../services/shippingRules');
const { normalizeSettingsUpdates } = require('../services/storeSettingsValidation');
const { getShippingProvider, getShippingProviders, providerLabel } = require('../services/shippingProvider');
const { buildPaymentOptions } = require('../services/paymentSettingsService');

test('new settings and legacy normalization retain manual courier as the default', () => {
  assert.equal(new Settings().shippingProvider, 'manual');
  assert.equal(new Settings().manualDeliveryMode, 'COURIER');
  assert.equal(DEFAULTS.manualDeliveryMode, 'COURIER');
  assert.deepEqual(normalizeShippingSettings({}, {}), {});
  assert.equal(normalizeShippingSettings({ manualDeliveryMode: '' }, {}).manualDeliveryMode, 'COURIER');
  assert.deepEqual(normalizeShippingSettings({}, { manualDeliveryMode: '' }), {});
});

test('both manual methods save without courier credentials or a pickup address', async () => {
  for (const manualDeliveryMode of ['COURIER', 'SELF']) {
    const input = { shippingProvider: 'manual', manualDeliveryMode };
    const normalized = normalizeSettingsUpdates(input, { storeName: 'Client store' });
    assert.deepEqual(normalized, input);
    assert.deepEqual(input, { shippingProvider: 'manual', manualDeliveryMode });
    await new Settings(normalized).validate();
  }
});

test('manual method validates allowed enum and cannot enable carrier live pricing', async () => {
  for (const manualDeliveryMode of ['self', 'delivery', 'SELF ', 1, true, {}, []]) {
    assert.throws(() => normalizeShippingSettings({ manualDeliveryMode }, {}), /Choose manual courier or self delivery/);
  }
  await assert.rejects(new Settings({ manualDeliveryMode: 'RANDOM' }).validate(), /manualDeliveryMode/);
  assert.throws(() => normalizeShippingSettings({ shippingProvider: 'manual', manualDeliveryMode: 'SELF', shippingPricingMode: 'carrier' }, {}), /Live carrier pricing/);
});

test('switching manual defaults only changes supplied settings, keeping legacy documents untouched', () => {
  const current = { shippingProvider: 'manual', manualDeliveryMode: 'COURIER', storeName: 'Client store', shippingPickup: { city: 'Delhi' }, codEnabled: true };
  const before = structuredClone(current);
  assert.deepEqual(normalizeSettingsUpdates({ manualDeliveryMode: 'SELF' }, current), { manualDeliveryMode: 'SELF' });
  assert.deepEqual(current, before);
  assert.deepEqual(normalizeSettingsUpdates({ storeName: 'New name' }, before), { storeName: 'New name' });
});

test('manual modes retain fixed charges, free shipping and destination weight pricing', () => {
  for (const manualDeliveryMode of ['COURIER', 'SELF']) {
    const settings = { shippingProvider: 'manual', manualDeliveryMode, deliveryCharge: 75, freeShippingMinAmount: 1000 };
    assert.deepEqual(deliveryPrice(500, { pincode: '110001' }, {}, settings), { charge: 75, pricingSource: 'fixed' });
    assert.deepEqual(deliveryPrice(1000, { pincode: '110001' }, {}, settings), { charge: 0, pricingSource: 'free-threshold' });
    const weighted = { ...settings, shippingFreeAboveEnabled: false, shippingPricingMode: 'weight', shippingRateZones: [{ prefix: '110', baseCharge: 40, additionalStepCharge: 20 }] };
    const parcel = packageForItems([{ shippingWeightKg: 1, quantity: 1 }], weighted);
    assert.deepEqual(deliveryPrice(1200, { pincode: '110001' }, parcel, weighted), { charge: 60, pricingSource: 'rate-card:110' });
  }
});

test('manual delivery does not bypass existing COD rules', () => {
  for (const manualDeliveryMode of ['COURIER', 'SELF']) {
    const settings = { shippingProvider: 'manual', manualDeliveryMode, codEnabled: true, codMaxAmount: 500, codPincodes: ['110001'] };
    const unavailable = buildPaymentOptions(settings, { orderAmount: 600, pincode: '110001' }).find(option => option.key === 'COD');
    assert.equal(unavailable.enabled, false);
    const pinUnavailable = buildPaymentOptions(settings, { orderAmount: 300, pincode: '400001' }).find(option => option.key === 'COD');
    assert.equal(pinUnavailable.enabled, false);
    const available = buildPaymentOptions(settings, { orderAmount: 300, pincode: '110001' }).find(option => option.key === 'COD');
    assert.equal(available.enabled, true);
  }
});

test('manual readiness explains staff updates without claiming live tracking or credentials', () => {
  const ready = getShippingProvider('manual');
  assert.equal(ready.configured, true);
  assert.deepEqual(ready.missing, []);
  assert.equal(ready.liveBooking, false);
  assert.equal(ready.trackingLookup, false);
  assert.equal(ready.rateQuotes, false);
  assert.match(ready.note, /No courier API credentials/);
  assert.match(ready.note, /Staff must update/);
  assert.equal(providerLabel('manual'), 'Manual / self delivery');
  assert.equal(getShippingProviders('manual').filter(provider => provider.selected).length, 1);
});

test('integrated pickup requirements remain enforced despite a saved self-delivery preference', () => {
  assert.throws(() => normalizeShippingSettings({ shippingProvider: 'shiprocket', manualDeliveryMode: 'SELF' }, {}), /Complete the pickup contact/);
});

test('production delivery writes fail closed without transaction support; local mode retains its fallback', async () => {
  // This unit suite never opens a database connection. supportsTransactions()
  // returns false immediately while disconnected, without contacting MongoDB.
  const mongoose = require('mongoose');
  assert.equal(mongoose.connection.readyState, 0);
  const { requireReliableDeliveryWrites } = require('../services/shippingService');
  const originalMode = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    await assert.rejects(requireReliableDeliveryWrites(), error => {
      assert.equal(error.errorCode, 'SERVICE_UNAVAILABLE');
      assert.equal(error.statusCode, 503);
      assert.match(error.message, /transaction-capable MongoDB replica set/);
      return true;
    });
    process.env.NODE_ENV = 'development';
    await assert.doesNotReject(requireReliableDeliveryWrites());
    process.env.NODE_ENV = 'test';
    await assert.doesNotReject(requireReliableDeliveryWrites());
  } finally {
    if (originalMode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalMode;
  }
});
