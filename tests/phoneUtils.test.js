const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePhone } = require('../utils/phoneUtils');
const { requireIndianMobile } = require('../utils/validators');
const { snapshotAddress } = require('../services/orderSnapshotService');
const { assertShippingAddress } = require('../controllers/orderController');

test('local Indian numbers beginning with 91 retain all ten digits for login and checkout', () => {
  for (const value of ['9123456789', '+91 91234 56789', '919123456789']) {
    assert.equal(normalizePhone(value), '9123456789');
    assert.equal(requireIndianMobile(value), '9123456789');
    const address = { fullName: 'Customer', mobile: value, pincode: '302001', houseNo: '12', area: 'Market Road', city: 'Jaipur', state: 'Rajasthan' };
    assert.doesNotThrow(() => assertShippingAddress(address));
    assert.equal(snapshotAddress(address).mobile, '9123456789');
  }
});

test('normalization keeps international login support and rejects incomplete Indian checkout numbers', () => {
  assert.equal(normalizePhone('+14155552671'), '+14155552671');
  assert.equal(normalizePhone('91234567'), '');
  assert.throws(() => requireIndianMobile('91234567'));
  assert.throws(() => requireIndianMobile('91912345678'));
});
