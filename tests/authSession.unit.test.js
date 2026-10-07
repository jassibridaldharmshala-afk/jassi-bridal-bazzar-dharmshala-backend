const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { generateToken, generateRefreshToken } = require('../utils/generateToken');
const { getJwtSecret, getJwtRefreshSecret } = require('../config/env');
const { cookieOptions } = require('../utils/authCookies');

const hour = 60 * 60;
const account = (extra = {}) => ({
  _id: '0123456789abcdef01234567', role: 'admin', activeMode: 'admin',
  authSessionVersion: 3, ...extra,
});
const lifetime = (token) => { const claims = jwt.decode(token); return claims.exp - claims.iat; };

test.beforeEach((t) => {
  const keys = ['NODE_ENV', 'JWT_SECRET', 'JWT_REFRESH_SECRET', 'JWT_EXPIRES_IN', 'JWT_ADMIN_EXPIRES_IN', 'JWT_REFRESH_EXPIRES_IN'];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'unit-access-secret', JWT_REFRESH_SECRET: 'unit-refresh-secret' });
  for (const key of ['JWT_EXPIRES_IN', 'JWT_ADMIN_EXPIRES_IN', 'JWT_REFRESH_EXPIRES_IN']) delete process.env[key];
  t.after(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
});

test('admin access lasts 24 hours and expires at the boundary', () => {
  const token = generateToken(account());
  const claims = jwt.verify(token, getJwtSecret());
  assert.equal(claims.exp - claims.iat, 24 * hour);
  for (const age of [16 * 60, hour, 23 * hour, 24 * hour - 1]) {
    assert.doesNotThrow(() => jwt.verify(token, getJwtSecret(), { clockTimestamp: claims.iat + age }));
  }
  assert.throws(() => jwt.verify(token, getJwtSecret(), { clockTimestamp: claims.exp }), { name: 'TokenExpiredError' });
  assert.equal(claims.authSessionVersion, 3);
});

test('the generic 15-minute lifetime does not shorten admin access in either mode', () => {
  process.env.JWT_EXPIRES_IN = '15m';
  for (const activeMode of ['admin', 'customer']) {
    assert.equal(lifetime(generateToken(account({ activeMode }))), 24 * hour);
  }
});

test('customer and seller accounts retain the original 15-minute access lifetime', () => {
  for (const user of [account({ role: 'customer', activeMode: 'customer' }), account({ role: 'customer', activeMode: 'seller', availableModes: ['customer', 'seller'] }), '0123456789abcdef01234567']) {
    assert.equal(lifetime(generateToken(user)), 15 * 60);
  }
});

test('customer UI mode or master metadata alone cannot select the admin lifetime', () => {
  const user = account({ role: 'customer', activeMode: 'admin', availableModes: ['admin'], systemRole: 'MASTER_OWNER' });
  assert.equal(lifetime(generateToken(user)), 15 * 60);
});

test('admin and customer lifetimes can be configured independently', () => {
  process.env.JWT_EXPIRES_IN = '30m';
  process.env.JWT_ADMIN_EXPIRES_IN = '48h';
  assert.equal(lifetime(generateToken(account())), 48 * hour);
  assert.equal(lifetime(generateToken(account({ role: 'customer' }))), 30 * 60);
});

test('blank admin configuration retains the 24-hour default', () => {
  process.env.JWT_ADMIN_EXPIRES_IN = '   ';
  assert.equal(lifetime(generateToken(account())), 24 * hour);
});

test('master and demo session claims are preserved without granting new master rights', () => {
  const user = account({ masterSessionVersion: 'owner-session', $locals: { masterAuthenticated: true, hostedOwnerDemo: true } });
  const claims = jwt.verify(generateToken(user), getJwtSecret());
  assert.equal(claims.exp - claims.iat, 24 * hour);
  assert.equal(claims.masterSessionVersion, 'owner-session');
  assert.equal(claims.hostedOwnerDemo, true);
  assert.equal(jwt.decode(generateToken(account({ masterSessionVersion: 'not-authenticated' }))).masterSessionVersion, undefined);
});

test('refresh-token lifetime and HttpOnly cookie policy stay independent of access tokens', () => {
  process.env.JWT_ADMIN_EXPIRES_IN = '48h';
  for (const role of ['admin', 'customer']) {
    const token = generateRefreshToken(account({ role }));
    assert.equal(lifetime(token), 30 * 24 * hour);
    assert.equal(jwt.verify(token, getJwtRefreshSecret()).tokenType, 'refresh');
  }
  process.env.JWT_REFRESH_EXPIRES_IN = '7d';
  assert.equal(lifetime(generateRefreshToken(account())), 7 * 24 * hour);
  const cookie = cookieOptions({ headers: { host: 'localhost' } });
  assert.equal(cookie.maxAge, 7 * 24 * hour * 1000);
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.path, '/api/auth');
});
