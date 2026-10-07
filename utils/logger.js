const crypto = require('crypto');
const { getJwtSecret } = require('../config/env');

const SECRET_KEYS = [
  'password', 'otp', 'demoOtp', 'devOtp', 'token', 'refreshToken', 'authorization',
  'jwt', 'secret', 'razorpay_secret', 'razorpaySecret', 'webhookSecret', 'key_secret',
  'accessToken', 'encryptedAccessToken', 'encryptedRefreshToken',
  'apiKey', 'authKey', 'accountSid', 'credentials', 'codeHash',
];

function isSecretKey(key) {
  const name = String(key || '').toLowerCase();
  return SECRET_KEYS.some((item) => name.includes(item.toLowerCase()));
}

function redact(value, depth = 0) {
  if (value == null || depth > 4) return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = isSecretKey(key) ? '[redacted]' : redact(item, depth + 1);
  }
  return out;
}

function log(level, message, fields = {}) {
  const payload = redact({
    ts: new Date().toISOString(),
    level,
    message,
    requestId: fields.requestId,
    userId: fields.userId ? String(fields.userId) : undefined,
    storeId: fields.storeId ? String(fields.storeId) : undefined,
    orderId: fields.orderId ? String(fields.orderId) : undefined,
    ...fields,
  });
  const line = JSON.stringify(payload);
  if (level === 'error') console.error(line);
  else console.log(line);
}

function newRequestId() {
  return crypto.randomUUID();
}

module.exports = { isSecretKey, log, newRequestId, redact };
