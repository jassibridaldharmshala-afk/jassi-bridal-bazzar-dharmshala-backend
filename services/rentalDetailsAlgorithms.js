const A = require('./rentalAlgorithms');
const { ApiError } = require('../utils/apiError');
const fail = message => { throw new ApiError('VALIDATION_ERROR', message); };
const APPAREL = ['bust', 'chest', 'waist', 'hips', 'shoulder', 'sleeve', 'armhole', 'blouseLength', 'outfitLength', 'bottomLength', 'inseam', 'outseam'];
const JEWELLERY = ['bangleInnerDiameter', 'ringInnerDiameter', 'chainLength', 'circumference'];
function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail(`Use valid ${label} fields.`);
  return value;
}
function phone(value, label) {
  const result = A.text(value || '', 25).replace(/[\s()-]/g, '').replace(/^\+?91(?=\d{10}$)/, '');
  if (!/^[6-9]\d{9}$/.test(result)) fail(`Enter a valid 10-digit Indian mobile for ${label}.`);
  return result;
}
function address(input, label) {
  object(input, ['fullName', 'mobile', 'houseNo', 'area', 'landmark', 'city', 'state', 'pincode'], label);
  const result = Object.fromEntries(['fullName', 'houseNo', 'area', 'city', 'state'].map(key => [key, A.text(input[key] || '', key === 'fullName' ? 100 : 120)]));
  if (Object.values(result).some(value => !value)) fail(`Complete the contact, street, city and state for ${label}.`);
  result.mobile = phone(input.mobile, label);
  result.landmark = A.text(input.landmark || '', 120);
  result.pincode = A.text(input.pincode || '', 6);
  if (!/^[1-9]\d{5}$/.test(result.pincode)) fail(`Enter a valid six-digit PIN code for ${label}.`);
  return result;
}
function contact(input, label, delegate = false) {
  if (input === undefined || input === null) return null;
  object(input, delegate ? ['name', 'phone', 'relationship', 'authorised'] : ['name', 'phone'], label);
  const name = A.text(input.name || '', 100), relationship = delegate ? A.text(input.relationship || '', 100) : '';
  if (!name) fail(`Enter the name for ${label}.`);
  if (delegate && input.authorised !== true) fail(`Explicitly authorise the ${label} before saving.`);
  return { name, phone: phone(input.phone, label), ...(delegate ? { relationship, authorised: true } : {}) };
}
function bookingDetails(input, deliveryMode, { preserveLegacyDelivery = false } = {}) {
  object(input, ['version', 'deliveryAddress', 'collectionAddress', 'sameAsDelivery', 'alternateContact', 'pickupContact', 'returnContact', 'occasion', 'fittingInstructions', 'deliveryInstructions'], 'rental booking details');
  if (input.version !== undefined && input.version !== 1) fail('Unsupported rental booking details version.');
  if (input.sameAsDelivery !== undefined && typeof input.sameAsDelivery !== 'boolean') fail('Choose whether the return address matches delivery.');
  const sameAsDelivery = input.sameAsDelivery !== false;
  const legacyDelivery = preserveLegacyDelivery && input.deliveryAddress === null;
  const deliveryAddress = deliveryMode === 'STORE_PICKUP' || legacyDelivery ? null : address(input.deliveryAddress, 'delivery address');
  const collectionAddress = deliveryMode === 'STORE_PICKUP' ? null : sameAsDelivery ? (deliveryAddress ? { ...deliveryAddress } : null) : address(input.collectionAddress, 'return collection address');
  return { version: 1, deliveryAddress, collectionAddress, sameAsDelivery,
    alternateContact: contact(input.alternateContact, 'alternate contact'), pickupContact: contact(input.pickupContact, 'pickup / delivery contact', true), returnContact: contact(input.returnContact, 'return contact', true),
    occasion: A.text(input.occasion || '', 100), fittingInstructions: A.text(input.fittingInstructions || '', 1000), deliveryInstructions: A.text(input.deliveryInstructions || '', 1000) };
}
function addressText(value) { return value ? [value.fullName, value.mobile, value.houseNo, value.area, value.landmark, value.city, value.state, value.pincode].filter(Boolean).join(', ') : ''; }
function stampAuthorisations(details, previous, actorId, now = new Date()) {
  for (const key of ['pickupContact', 'returnContact']) {
    const current = details[key], old = previous?.[key];
    if (current) Object.assign(current, old?.authorisedAt && ['name', 'phone', 'relationship', 'authorised'].every(field => old[field] === current[field])
      ? { authorisedAt: old.authorisedAt, authorisedBy: old.authorisedBy } : { authorisedAt: now, authorisedBy: actorId });
  }
  return details;
}
function fitProfile(input) {
  if (input === null) return null;
  object(input, ['kind', 'unit', 'values', 'alterationsAllowed', 'alterationLimits', 'notes'], 'physical-piece measurements');
  if (!['APPAREL', 'JEWELLERY', 'OTHER'].includes(input.kind) || !['in', 'cm'].includes(input.unit)) fail('Choose a measurement type and inches or centimetres.');
  const keys = input.kind === 'APPAREL' ? APPAREL : input.kind === 'JEWELLERY' ? JEWELLERY : ['length', 'width', 'circumference'];
  object(input.values, keys, 'piece measurements');
  const max = input.unit === 'in' ? 150 : 380;
  const number = value => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > max || Math.abs(value * 100 - Math.round(value * 100)) > 0.000001) fail('Piece measurements must be positive numbers with up to two decimal places.');
    return value;
  };
  const values = Object.fromEntries(Object.entries(input.values).map(([key, value]) => [key, number(value)]));
  if (!Object.keys(values).length) fail('Enter at least one physical-piece measurement, or switch structured measurements off.');
  if (typeof input.alterationsAllowed !== 'boolean') fail('Choose whether this piece may be altered.');
  object(input.alterationLimits || {}, keys, 'alteration limits');
  const alterationLimits = {};
  for (const [key, limit] of Object.entries(input.alterationLimits || {})) {
    object(limit, ['min', 'max'], 'alteration range');
    if (!input.alterationsAllowed || values[key] === undefined) fail('Alteration ranges need an alterable piece and its current measurement.');
    const min = number(limit.min), upper = number(limit.max);
    if (min > upper || values[key] < min || values[key] > upper) fail('The current measurement must be within its minimum/maximum alteration range.');
    alterationLimits[key] = { min, max: upper };
  }
  return { kind: input.kind, unit: input.unit, values, alterationsAllowed: input.alterationsAllowed, alterationLimits, notes: A.text(input.notes || '', 1000) };
}
module.exports = { bookingDetails, address, addressText, stampAuthorisations, fitProfile };
