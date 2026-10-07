const test = require('node:test');
const assert = require('node:assert/strict');
const User = require('../models/User');
const router = require('../routes/addressRoutes');
const address = { fullName: 'Test Recipient', mobile: '9876543210', pincode: '400001', state: 'Maharashtra', city: 'Mumbai', houseNo: '12A', area: 'Fort', addressType: 'Home' };
const makeUser = (addresses = []) => {
  const user = new User({ name: 'Test', phone: '9876543210', addresses });
  user.save = async () => user;
  return user;
};
async function call(method, path, user, body = {}, addressId) {
  const handler = router.stack.find((layer) => layer.route?.path === path && layer.route.methods[method]).route.stack[0].handle;
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(data) { this.body = data; return this; } };
  await handler({ user, body, params: { addressId } }, res, (error) => { res.error = error; });
  return res;
}
test('first address is default, switching default is exclusive, and deleting it promotes the remaining address', async () => {
  const user = makeUser();
  await call('post', '/', user, address);
  assert.equal(user.addresses[0].isDefault, true);
  await call('post', '/', user, { ...address, addressType: 'Work' });
  const workId = String(user.addresses[1]._id);
  await call('patch', '/:addressId/default', user, {}, workId);
  assert.deepEqual(user.addresses.map((item) => item.isDefault), [false, true]);
  await call('delete', '/:addressId', user, {}, workId);
  assert.equal(user.addresses.length, 1);
  assert.equal(user.addresses[0].isDefault, true);
});
test('editing preserves a default and keeps legacy phone and house fields in sync', async () => {
  const user = makeUser([{ ...address, isDefault: true }]);
  await call('put', '/:addressId', user, { ...address, isDefault: false, mobile: '9123456789', phone: address.mobile, houseNo: 'Suite 42', houseNumber: address.houseNo }, String(user.addresses[0]._id));
  assert.equal(user.addresses[0].isDefault, true);
  assert.equal(user.addresses[0].phone, '9123456789');
  assert.equal(user.addresses[0].houseNumber, 'Suite 42');
});
test('default selection cannot access an address belonging to someone else', async () => {
  const user = makeUser([{ ...address, isDefault: true }]);
  const res = await call('patch', '/:addressId/default', user, {}, '000000000000000000000001');
  assert.equal(res.statusCode, 404);
  assert.equal(user.addresses[0].isDefault, true);
});

test('addresses trim required fields, accept formatted Indian numbers, and reject whitespace-only details', async () => {
  const user = makeUser();
  const created = await call('post', '/', user, { ...address, fullName: ' Test Recipient ', mobile: '+91 91234 56789' });
  assert.equal(created.statusCode, 201);
  assert.equal(user.addresses[0].mobile, '9123456789');
  assert.equal(user.addresses[0].fullName, 'Test Recipient');
  const invalid = await call('post', '/', user, { ...address, area: '   ' });
  assert.equal(invalid.statusCode, 400);
  assert.equal(user.addresses.length, 1);
});

test('address validation and persistence failures return through the API error handler', async () => {
  const user = makeUser();
  const invalid = await call('post', '/', user, { ...address, addressType: 'Unsupported' });
  assert.equal(invalid.statusCode, 400);
  user.save = async () => { throw new Error('Database unavailable'); };
  const failed = await call('post', '/', user, address);
  assert.match(failed.error.message, /Database unavailable/);
});
