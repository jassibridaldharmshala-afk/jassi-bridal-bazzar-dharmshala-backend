const test = require('node:test');
const assert = require('node:assert/strict');

const { request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createAdmin, createCustomer } = require('./factories');
const User = require('../models/User');
const jwt = require('jsonwebtoken');
const { generateToken, generateRefreshToken } = require('../utils/generateToken');
const { COOKIE_NAME } = require('../utils/authCookies');

test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(resetDatabase);

test('password-based customer registration is disabled because signup is OTP-only', async () => {
  const { status } = await request('/api/auth/register', {
    method: 'POST',
    body: {
      name: 'Legacy customer',
      phone: '9812345670',
      email: 'legacy@test.local',
      password: 'password123',
    },
  });

  assert.equal(status, 404);
  const stored = await User.findOne({ phone: '9812345670' });
  assert.equal(stored, null);
});

test('a customer cannot promote themselves to admin', async () => {
  const { user, token } = await createCustomer();

  const { status } = await request(`/api/admin/customers/${user._id}/promote-admin`, {
    method: 'PATCH',
    token,
    body: {},
  });

  assert.equal(status, 403);
  const stored = await User.findById(user._id);
  assert.equal(stored.role, 'customer');
});

test('an unauthenticated caller cannot promote a user', async () => {
  const { user } = await createCustomer();
  const { status } = await request(`/api/admin/customers/${user._id}/promote-admin`, { method: 'PATCH', body: {} });
  assert.equal(status, 401);
});

test('an ordinary admin cannot grant or remove admin access reserved for the master owner', async () => {
  const { token } = await createAdmin();
  await createAdmin(); // keeps a second admin so demotion is permitted
  const { user: customer } = await createCustomer();

  const promoted = await request(`/api/admin/customers/${customer._id}/promote-admin`, { method: 'PATCH', token, body: {} });
  assert.equal(promoted.status, 403);
  assert.equal((await User.findById(customer._id)).role, 'customer');

  const demoted = await request(`/api/admin/customers/${customer._id}/demote-admin`, { method: 'PATCH', token, body: {} });
  assert.equal(demoted.status, 403);
  assert.equal((await User.findById(customer._id)).role, 'customer');
});

test('an admin cannot demote themselves', async () => {
  const { user, token } = await createAdmin();
  const { status } = await request(`/api/admin/customers/${user._id}/demote-admin`, { method: 'PATCH', token, body: {} });
  assert.equal(status, 403);
});

test('the last remaining admin cannot be demoted', async () => {
  const { token } = await createAdmin();
  const { user: other } = await createAdmin();

  // Demote the second admin, leaving only the caller.
  await request(`/api/admin/customers/${other._id}/demote-admin`, { method: 'PATCH', token, body: {} });

  const { user: third } = await createAdmin();
  const onlyAdminToken = (await createAdmin()).token;
  await request(`/api/admin/customers/${third._id}/demote-admin`, { method: 'PATCH', token: onlyAdminToken, body: {} });

  const remaining = await User.countDocuments({ role: 'admin' });
  assert.ok(remaining >= 1, 'at least one admin must always remain');
});

test('an admin cannot block their own account', async () => {
  const { user, token } = await createAdmin();
  const { status } = await request(`/api/admin/customers/${user._id}/block`, { method: 'PATCH', token, body: { isBlocked: true } });
  assert.equal(status, 403);
});

test('block requires a boolean flag', async () => {
  const { token } = await createAdmin();
  const { user } = await createCustomer();
  const { status, data } = await request(`/api/admin/customers/${user._id}/block`, { method: 'PATCH', token, body: { isBlocked: 'yes-please' } });
  assert.equal(status, 400);
  assert.equal(data.code, 'VALIDATION_ERROR');
});

test('a malformed user id is rejected before reaching the database', async () => {
  const { token } = await createAdmin();
  const { status, data } = await request('/api/admin/customers/not-an-id/block', { method: 'PATCH', token, body: { isBlocked: true } });
  assert.equal(status, 400);
  assert.equal(data.code, 'VALIDATION_ERROR');
});

test('a blocked user is denied access', async () => {
  const { token } = await createCustomer({ isBlocked: true });
  const { status } = await request('/api/auth/me', { token });
  assert.equal(status, 401);
});

test('demo OTP mode issues and reveals the fixed code, and it verifies', async () => {
  const sent = await request('/api/auth/send-otp', { method: 'POST', body: { phone: '9812345672' } });
  assert.equal(sent.status, 200);
  assert.equal(sent.data.otpMode, 'demo');
  assert.equal(sent.data.demoOtp, '123456');

  const verified = await request('/api/auth/verify-otp', { method: 'POST', body: { phone: '9812345672', otp: '123456' } });
  assert.equal(verified.status, 200);
  assert.ok(verified.data.token);
  assert.equal(verified.data.user.role, 'customer');
  assert.equal(verified.data.user.isPhoneVerified, true);
});

test('OTP login promotes only numbers listed in ADMIN_PHONE_NUMBERS', async () => {
  const previous = process.env.ADMIN_PHONE_NUMBERS;
  process.env.ADMIN_PHONE_NUMBERS = '9812345673';
  try {
    await request('/api/auth/send-otp', { method: 'POST', body: { phone: '9812345674' } });
    const nonAdmin = await request('/api/auth/verify-otp', { method: 'POST', body: { phone: '9812345674', otp: '123456' } });
    assert.equal(nonAdmin.data.user.role, 'customer');

    await request('/api/auth/send-otp', { method: 'POST', body: { phone: '9812345673' } });
    const admin = await request('/api/auth/verify-otp', { method: 'POST', body: { phone: '9812345673', otp: '123456' } });
    assert.equal(admin.data.user.role, 'admin');
  } finally {
    process.env.ADMIN_PHONE_NUMBERS = previous;
  }
});

test('production OTP mode never reveals a code to the client', async () => {
  process.env.OTP_MODE = 'production';
  try {
    const sent = await request('/api/auth/send-otp', { method: 'POST', body: { phone: '9812345675' } });
    assert.equal(sent.data?.demoOtp, undefined);
    assert.equal(sent.data?.devOtp, undefined);

    // With no real provider connected the request must fail rather than fall
    // back to a guessable code.
    if (sent.status === 200) {
      const guessed = await request('/api/auth/verify-otp', { method: 'POST', body: { phone: '9812345675', otp: '123456' } });
      assert.notEqual(guessed.status, 200, 'the fixed demo code must not work in production mode');
    } else {
      assert.equal(sent.status, 503);
    }
  } finally {
    process.env.OTP_MODE = 'demo';
  }
});

test('the legacy admin password endpoint requires mobile OTP instead', async () => {
  const { status, data } = await request('/api/admin/login', {
    method: 'POST',
    body: { email: 'adminlogin@test.local', password: 'CorrectHorse1' },
  });

  assert.equal(status, 410);
  assert.equal(data.code, 'OTP_REQUIRED');
  assert.match(String(data.message), /mobile number and otp only/i);
});

test('customer password login is disabled because storefront login is OTP-only', async () => {
  await createCustomer({
    email: 'shopper@test.local',
    phone: '9812345699',
    password: 'CorrectHorse1',
  });

  const byEmail = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'shopper@test.local', password: 'CorrectHorse1' },
  });
  assert.equal(byEmail.status, 404);
});

function assertAccessLifetime(token, seconds) {
  const claims = jwt.decode(token);
  assert.equal(claims.exp - claims.iat, seconds);
}

function accessTokenIssuedAgo(t, user, seconds) {
  const issuedAt = Date.now() - seconds * 1000;
  const clock = t.mock.method(Date, 'now', () => issuedAt);
  try { return generateToken(user); }
  finally { clock.mock.restore(); }
}

test('admin OTP login, mode switch and cookie refresh all issue 24-hour access tokens', async () => {
  const { user } = await createAdmin();
  const sent = await request('/api/auth/send-otp', { method: 'POST', body: { phone: user.phone } });
  assert.equal(sent.status, 200);
  const login = await request('/api/auth/verify-otp', { method: 'POST', body: { phone: user.phone, otp: '123456' } });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.role, 'admin');
  assertAccessLifetime(login.data.token, 24 * 60 * 60);
  const cookie = login.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /Max-Age=2592000/);
  for (const mode of ['admin', 'customer']) {
    const switched = await request('/api/auth/switch-mode', { method: 'POST', token: login.data.token, body: { mode } });
    assert.equal(switched.status, 200);
    assert.equal(switched.data.user.activeMode, mode);
    assertAccessLifetime(switched.data.token, 24 * 60 * 60);
  }
  const refreshed = await request('/api/auth/refresh', { method: 'POST', headers: { Cookie: cookie.split(';')[0] }, body: {} });
  assert.equal(refreshed.status, 200);
  assertAccessLifetime(refreshed.data.token, 24 * 60 * 60);
});

test('an admin can still use protected APIs just before 24 hours without a refresh cookie', async (t) => {
  const { user } = await createAdmin();
  const token = accessTokenIssuedAgo(t, user, 24 * 60 * 60 - 60);
  assert.equal((await request('/api/auth/me', { token })).status, 200);
  assert.equal((await request('/api/admin/categories', { token })).status, 200);
  const expired = accessTokenIssuedAgo(t, user, 24 * 60 * 60 + 1);
  assert.equal((await request('/api/auth/me', { token: expired })).status, 401);
});

test('customer access still expires after 15 minutes and recovers with the existing refresh cookie', async (t) => {
  const { user } = await createCustomer();
  const token = accessTokenIssuedAgo(t, user, 16 * 60);
  assert.equal((await request('/api/auth/me', { token })).status, 401);
  const refreshed = await request('/api/auth/refresh', {
    method: 'POST', body: {}, headers: { Cookie: `${COOKIE_NAME}=${generateRefreshToken(user)}` },
  });
  assert.equal(refreshed.status, 200);
  assertAccessLifetime(refreshed.data.token, 15 * 60);
});

test('explicit logout immediately revokes both long-lived admin access and refresh tokens', async () => {
  const { user, token } = await createAdmin();
  const cookie = `${COOKIE_NAME}=${generateRefreshToken(user)}`;
  assert.equal((await request('/api/auth/logout', { method: 'POST', token, body: {} })).status, 200);
  assert.equal((await request('/api/auth/me', { token })).status, 401);
  const refreshed = await request('/api/auth/refresh', { method: 'POST', headers: { Cookie: cookie }, body: {} });
  assert.equal(refreshed.status, 401);
});

test('blocking an admin immediately rejects unexpired access and refresh tokens', async () => {
  const { user, token } = await createAdmin();
  const cookie = `${COOKIE_NAME}=${generateRefreshToken(user)}`;
  await User.updateOne({ _id: user._id }, { $set: { isBlocked: true } });
  assert.equal((await request('/api/auth/me', { token })).status, 401);
  assert.equal((await request('/api/auth/refresh', { method: 'POST', headers: { Cookie: cookie }, body: {} })).status, 401);
});

test('demoting an admin immediately removes admin access and refreshes with customer lifetime', async () => {
  const { user, token } = await createAdmin();
  const cookie = `${COOKIE_NAME}=${generateRefreshToken(user)}`;
  assert.equal((await request('/api/admin/categories', { token })).status, 200);
  await User.updateOne({ _id: user._id }, { $set: { role: 'customer', activeMode: 'customer', availableModes: ['customer'] } });
  assert.equal((await request('/api/admin/categories', { token })).status, 403);
  const refreshed = await request('/api/auth/refresh', { method: 'POST', headers: { Cookie: cookie }, body: {} });
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.data.user.role, 'customer');
  assertAccessLifetime(refreshed.data.token, 15 * 60);
});
