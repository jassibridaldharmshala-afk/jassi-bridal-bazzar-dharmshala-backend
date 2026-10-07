const { ApiError } = require('../utils/apiError');

const DEFAULTS = {
  shippingProvider: 'manual', manualDeliveryMode: 'COURIER', shippingPricingMode: 'fixed', shippingFreeAboveEnabled: true,
  shippingDefaultWeightKg: 0.5, shippingLengthCm: 30, shippingWidthCm: 25, shippingHeightCm: 5,
  shippingVolumetricDivisor: 5000, shippingWeightStepKg: 0.5, shippingAdditionalStepCharge: 0,
  shippingRateZones: [], shippingPickup: {},
};
const error = message => new ApiError('SHIPPING_VALIDATION', message);
function positive(value, label, max = 100000) {
  if (!['string', 'number'].includes(typeof value) || String(value).trim() === '' || !Number.isFinite(Number(value)) || Number(value) <= 0 || Number(value) > max) throw error(`${label} must be greater than zero and no more than ${max}.`);
  return Number(value);
}
function pincode(value) {
  const pin = String(value || '').trim();
  if (!/^[1-9]\d{5}$/.test(pin)) throw error('Enter a valid six-digit delivery PIN code.');
  return pin;
}
function packageForItems(items, settings = {}, override) {
  const s = { ...DEFAULTS, ...settings };
  const count = items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  const weight = items.reduce((sum, item) => sum + Number(item.shippingWeightKg || s.shippingDefaultWeightKg) * Number(item.quantity || 0), 0);
  const parcel = override || { weightKg: weight, lengthCm: s.shippingLengthCm, widthCm: s.shippingWidthCm, heightCm: Number(s.shippingHeightCm) * Math.max(1, count) };
  const result = Object.fromEntries(['weightKg', 'lengthCm', 'widthCm', 'heightCm'].map(key => [key, positive(parcel[key], key, key === 'weightKg' ? 1000 : 300)]));
  const volumetricWeightKg = result.lengthCm * result.widthCm * result.heightCm / positive(s.shippingVolumetricDivisor, 'Volumetric divisor');
  return { ...result, pieces: 1, volumetricWeightKg: Math.round(volumetricWeightKg * 1000) / 1000, chargeableWeightKg: Math.ceil(Math.max(result.weightKg, volumetricWeightKg) * 1000) / 1000 };
}
function deliveryPrice(amount, destination, parcel, settings = {}, providerRate) {
  const s = { ...DEFAULTS, ...settings };
  if (s.shippingFreeAboveEnabled && amount >= Number(s.freeShippingMinAmount ?? 999)) return { charge: 0, pricingSource: 'free-threshold' };
  let charge = Number(s.deliveryCharge ?? 99);
  let pricingSource = 'fixed';
  if (s.shippingPricingMode === 'carrier') {
    const quoted = Number(providerRate);
    if (!Number.isFinite(quoted) || quoted < 0) throw error('The selected courier did not return a usable delivery rate. Choose fixed pricing or try again.');
    charge = quoted;
    pricingSource = `carrier:${s.shippingProvider}`;
  } else if (s.shippingPricingMode === 'weight') {
    const pin = pincode(destination?.pincode);
    // Longest matching prefix wins, independent of the order of rows in Settings.
    const zone = [...(s.shippingRateZones || [])].filter(row => pin.startsWith(row.prefix)).sort((a, b) => b.prefix.length - a.prefix.length)[0];
    const step = positive(s.shippingWeightStepKg, 'Weight step');
    charge = Number(zone?.baseCharge ?? charge) + Math.max(0, Math.ceil((parcel.chargeableWeightKg - 0.000001) / step) - 1) * Number(zone?.additionalStepCharge ?? s.shippingAdditionalStepCharge);
    pricingSource = zone ? `rate-card:${zone.prefix}` : 'rate-card:default';
  }
  if (!Number.isFinite(charge) || charge < 0) throw error('Delivery pricing is not configured correctly. Please contact the store.');
  return { charge: Math.round(charge * 100) / 100, pricingSource };
}
function pickupAddress(source = {}) {
  const fields = ['fullName', 'mobile', 'houseNo', 'area', 'city', 'state', 'pincode'];
  const result = Object.fromEntries(fields.map(key => [key, String(source[key] || '').trim()]));
  if (fields.some(key => !result[key])) throw error('Complete the pickup contact, address, city, state and PIN code in delivery settings.');
  result.pincode = pincode(result.pincode);
  if (!/^[6-9]\d{9}$/.test(result.mobile)) throw error('Pickup mobile must be a valid Indian mobile number.');
  if (result.fullName.length > 100) throw error('Pickup contact name must be 100 characters or fewer.');
  return result;
}
function pickupSlot(date, time, closeTime, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time || '') || !/^([01]\d|2[0-3]):[0-5]\d$/.test(closeTime || '')) throw error('Choose a pickup date, time and closing time (India time).');
  const at = new Date(`${date}T${time}:00+05:30`);
  if (!Number.isFinite(at.getTime()) || at <= now || at - now > 14 * 86400000 || closeTime <= time) throw error('Pickup must be in the next 14 days, before the closing time.');
  if (new Date(at.getTime() + 19800000).toISOString().slice(0, 10) !== date) throw error('Choose a valid pickup date.');
  return { date, time, closeTime, at };
}
function normalizeShippingSettings(updates, current) {
  const next = { ...DEFAULTS, ...current, ...updates };
  if (!['manual', 'bluedart', 'shiprocket', 'delhivery', 'xpressbees'].includes(next.shippingProvider)) throw error('Choose a supported delivery provider.');
  // Older stores had only manual courier. An omitted/empty preference keeps that
  // behaviour; changing store defaults never rewrites an existing shipment.
  const manualMode = next.manualDeliveryMode ?? 'COURIER';
  if (!['COURIER', 'SELF', ''].includes(manualMode)) throw error('Choose manual courier or self delivery.');
  if (updates.manualDeliveryMode !== undefined) updates.manualDeliveryMode = manualMode || 'COURIER';
  if (!['fixed', 'weight', 'carrier'].includes(next.shippingPricingMode)) throw error('Choose fixed, weight-based or live carrier delivery pricing.');
  if (next.shippingPricingMode === 'carrier' && !['shiprocket', 'delhivery', 'xpressbees'].includes(next.shippingProvider)) throw error('Live carrier pricing is available with Shiprocket, Delhivery or Xpressbees.');
  if (typeof next.shippingFreeAboveEnabled !== 'boolean') throw error('Free delivery must be enabled or disabled.');
  for (const key of ['shippingDefaultWeightKg', 'shippingLengthCm', 'shippingWidthCm', 'shippingHeightCm', 'shippingVolumetricDivisor', 'shippingWeightStepKg']) {
    if (updates[key] !== undefined) updates[key] = positive(updates[key], key);
  }
  if (updates.shippingAdditionalStepCharge !== undefined) {
    const n = Number(updates.shippingAdditionalStepCharge);
    if (String(updates.shippingAdditionalStepCharge).trim() === '' || !Number.isFinite(n) || n < 0 || n > 100000) throw error('Extra weight charge must be a non-negative amount.');
    updates.shippingAdditionalStepCharge = n;
  }
  if (updates.shippingPickup !== undefined) {
    if (!updates.shippingPickup || typeof updates.shippingPickup !== 'object' || Array.isArray(updates.shippingPickup)) throw error('Invalid pickup address.');
    updates.shippingPickup = Object.fromEntries(['fullName', 'mobile', 'houseNo', 'area', 'city', 'state', 'pincode'].map(key => {
      const v = updates.shippingPickup[key] ?? '';
      if (typeof v !== 'string' || v.length > 120) throw error('Pickup address fields must be text, up to 120 characters.');
      return [key, v.trim()];
    }));
  }
  if (updates.shippingRateZones !== undefined) {
    if (!Array.isArray(updates.shippingRateZones) || updates.shippingRateZones.length > 200) throw error('Use no more than 200 delivery rate zones.');
    const seen = new Set();
    updates.shippingRateZones = updates.shippingRateZones.map(row => {
      const prefix = String(row?.prefix || '').trim();
      if (!/^[1-9]\d{0,5}$/.test(prefix) || seen.has(prefix)) throw error('Each rate zone needs a different PIN prefix (1 to 6 digits).');
      seen.add(prefix);
      const result = { prefix };
      for (const key of ['baseCharge', 'additionalStepCharge']) {
        if (!['string', 'number'].includes(typeof row[key]) || String(row[key]).trim() === '' || !Number.isFinite(Number(row[key])) || Number(row[key]) < 0 || Number(row[key]) > 100000) throw error('Rate card charges must be non-negative amounts.');
        result[key] = Number(row[key]);
      }
      return result;
    });
  }
  if (next.shippingProvider !== 'manual') pickupAddress(updates.shippingPickup || next.shippingPickup);
  return updates;
}
function assertQuotedTotal(draft, expectedTotal) {
  if (draft.shippingQuote?.provider === 'manual' && expectedTotal === undefined) return;
  if (typeof expectedTotal !== 'number' || !Number.isFinite(expectedTotal) || Math.round(expectedTotal * 100) !== Math.round(draft.totals.finalAmount * 100)) throw new ApiError('SHIPPING_QUOTE_CHANGED', 'Your order total has changed. Review the updated delivery charge and total before placing the order.', { statusCode: 409 });
}
module.exports = { DEFAULTS, pincode, positive, packageForItems, deliveryPrice, pickupAddress, pickupSlot, normalizeShippingSettings, assertQuotedTotal };
