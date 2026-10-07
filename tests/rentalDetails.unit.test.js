const { test } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../services/rentalDetailsAlgorithms');
const address = () => ({ fullName: 'Buyer', mobile: '+91 9876543210', houseNo: '12', area: 'Main road', landmark: 'Near park', city: 'Jaipur', state: 'Rajasthan', pincode: '302001' });
const details = () => ({ deliveryAddress: address(), sameAsDelivery: true, occasion: 'Wedding' });
const fit = () => ({ kind: 'APPAREL', unit: 'in', values: { waist: 30, outfitLength: 42 }, alterationsAllowed: true, alterationLimits: { waist: { min: 28, max: 34 } } });
test('delivery addresses are normalized, independent and include the landmark', () => {
  const value = D.bookingDetails(details(), 'COURIER');
  assert.equal(value.deliveryAddress.mobile, '9876543210'); assert.equal(value.collectionAddress.pincode, '302001');
  assert.notEqual(value.deliveryAddress, value.collectionAddress); assert.match(D.addressText(value.deliveryAddress), /Near park/);
  value.collectionAddress.city = 'Delhi'; assert.equal(value.deliveryAddress.city, 'Jaipur');
});
test('different return collection addresses need their own complete contact and location', () => {
  assert.throws(() => D.bookingDetails({ ...details(), sameAsDelivery: false }, 'SELF_DELIVERY'), /valid return collection address/);
  assert.throws(() => D.bookingDetails({ ...details(), deliveryAddress: { ...address(), pincode: '000000' } }, 'COURIER'), /PIN/);
  assert.throws(() => D.bookingDetails({ ...details(), deliveryAddress: { ...address(), mobile: '1234567890' } }, 'COURIER'), /mobile/);
  const value = D.bookingDetails({ ...details(), sameAsDelivery: false, collectionAddress: { ...address(), city: 'Delhi', pincode: '110001' } }, 'COURIER');
  assert.equal(value.collectionAddress.city, 'Delhi');
});
test('store pickup discards hidden delivery addresses but preserves useful optional details', () => {
  const value = D.bookingDetails({ ...details(), fittingInstructions: 'Please check sleeve length' }, 'STORE_PICKUP');
  assert.equal(value.deliveryAddress, null); assert.equal(value.collectionAddress, null); assert.equal(value.fittingInstructions, 'Please check sleeve length');
});
test('delegates require complete details and explicit authorisation; alternate contact is not a delegate', () => {
  assert.throws(() => D.bookingDetails({ pickupContact: { name: 'Friend', phone: '9876543210' } }, 'STORE_PICKUP'), /authorise/);
  assert.throws(() => D.bookingDetails({ returnContact: { name: 'Friend', phone: 'invalid', authorised: true } }, 'STORE_PICKUP'), /mobile/);
  const value = D.bookingDetails({ alternateContact: { name: 'Friend', phone: '9876543210' } }, 'STORE_PICKUP');
  assert.equal(value.pickupContact, null); assert.equal(value.alternateContact.name, 'Friend');
});
test('unknown fields, forged authorisation metadata and unbounded notes are rejected', () => {
  assert.throws(() => D.bookingDetails({ customerId: 'other' }, 'STORE_PICKUP'), /valid/);
  assert.throws(() => D.bookingDetails({ pickupContact: { name: 'Friend', phone: '9876543210', authorised: true, authorisedAt: new Date() } }, 'STORE_PICKUP'), /valid/);
  assert.throws(() => D.bookingDetails({ fittingInstructions: 'a'.repeat(1001) }, 'STORE_PICKUP'), /too long/);
  assert.throws(() => D.bookingDetails({ sameAsDelivery: 'false' }, 'STORE_PICKUP'), /matches/);
});
test('unchanged authorisations retain original audit metadata; a changed person gets a new record', () => {
  const input = { pickupContact: { name: 'Friend', phone: '9876543210', authorised: true } };
  const now = new Date('2030-01-01T10:00:00Z'), later = new Date('2030-01-02T10:00:00Z');
  const old = D.stampAuthorisations(D.bookingDetails(input, 'STORE_PICKUP'), null, 'customer', now);
  const same = D.stampAuthorisations(D.bookingDetails(input, 'STORE_PICKUP'), old, 'staff', later);
  assert.equal(same.pickupContact.authorisedAt, now); assert.equal(same.pickupContact.authorisedBy, 'customer');
  const changed = D.stampAuthorisations(D.bookingDetails({ pickupContact: { ...input.pickupContact, name: 'Sister' } }, 'STORE_PICKUP'), old, 'staff', later);
  assert.equal(changed.pickupContact.authorisedAt, later); assert.equal(changed.pickupContact.authorisedBy, 'staff');
});
test('piece measurements and absolute alteration ranges have a validated shared unit', () => {
  assert.deepEqual(D.fitProfile(fit()).alterationLimits.waist, { min: 28, max: 34 });
  for (const values of [{ waist: -1 }, { waist: 0 }, { waist: 30.123 }, { waist: '30' }, { unknown: 30 }, {}]) assert.throws(() => D.fitProfile({ ...fit(), values }));
  assert.throws(() => D.fitProfile({ ...fit(), unit: 'mm' }), /unit|centimetres/);
  assert.throws(() => D.fitProfile({ ...fit(), alterationLimits: { waist: { min: 31, max: 34 } } }), /within/);
  assert.throws(() => D.fitProfile({ ...fit(), alterationLimits: { chest: { min: 28, max: 34 } } }), /current measurement/);
  assert.throws(() => D.fitProfile({ ...fit(), alterationsAllowed: false }), /alterable/);
  assert.equal(D.fitProfile(null), null);
});
test('jewellery and accessory measurements do not accept garment-only dimensions', () => {
  const value = D.fitProfile({ kind: 'JEWELLERY', unit: 'cm', values: { bangleInnerDiameter: 6.2, chainLength: 40 }, alterationsAllowed: false });
  assert.equal(value.values.bangleInnerDiameter, 6.2);
  assert.throws(() => D.fitProfile({ ...value, values: { waist: 30 } }), /valid/);
  assert.equal(D.fitProfile({ kind: 'OTHER', unit: 'cm', values: { length: 40 }, alterationsAllowed: false }).values.length, 40);
});
