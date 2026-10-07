const AnalyticsEvent = require('../models/AnalyticsEvent');
const { EVENT_ALIASES, EVENT_NAMES } = require('../models/AnalyticsEvent');
const { readAttribution } = require('../utils/attribution');
const { isSecretKey } = require('../utils/logger');

const BLOCKED_METADATA_KEYS = [
  'password', 'otp', 'token', 'authorization', 'card', 'cvv', 'pan',
  'razorpay_signature', 'razorpay_payment_id', 'key_secret', 'secret',
];

function cleanMetadata(value, depth = 0) {
  if (value == null || depth > 3) return undefined;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => cleanMetadata(item, depth + 1)).filter((item) => item !== undefined);
  if (typeof value !== 'object') {
    if (typeof value === 'string') return value.slice(0, 200);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    return undefined;
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const name = String(key).toLowerCase();
    if (isSecretKey(key) || BLOCKED_METADATA_KEYS.some((blocked) => name.includes(blocked))) continue;
    const cleaned = cleanMetadata(item, depth + 1);
    if (cleaned !== undefined) out[key] = cleaned;
  }
  return out;
}

function resolveEventName(name) {
  const resolved = EVENT_ALIASES[name] || name;
  return EVENT_NAMES.includes(resolved) ? resolved : null;
}

function recordEvent(fields) {
  const name = resolveEventName(fields?.name);
  if (!name) return Promise.resolve(null);
  const attribution = readAttribution(fields);
  return AnalyticsEvent.create({
    storeId: fields.storeId || undefined,
    name,
    sessionId: String(fields.sessionId || '').slice(0, 80) || undefined,
    userId: fields.userId || undefined,
    productId: fields.productId || undefined,
    orderId: fields.orderId || undefined,
    path: String(fields.path || '').slice(0, 300) || undefined,
    searchQuery: String(fields.searchQuery || fields.query || '').slice(0, 120) || undefined,
    source: attribution?.source,
    campaign: attribution?.campaign,
    reelId: attribution?.reelId,
    metadata: cleanMetadata(fields.metadata),
  }).catch(() => null);
}

function recordEventLater(fields) {
  setImmediate(() => {
    recordEvent(fields);
  });
}

module.exports = { cleanMetadata, recordEvent, recordEventLater };
