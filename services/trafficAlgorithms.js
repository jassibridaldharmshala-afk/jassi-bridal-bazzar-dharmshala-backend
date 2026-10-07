const crypto = require('node:crypto');
const { ApiError } = require('../utils/apiError');
const DAY = 86400000;
const PUBLIC_EVENTS = new Set(['PAGE_VIEW', 'ENGAGEMENT', 'STORE_VIEW', 'HOME_SECTION_VIEW', 'HOME_PRODUCT_CLICK', 'HOME_CATEGORY_CLICK', 'HOME_VIEW_ALL', 'HOME_SCROLL', 'PRODUCT_VIEW', 'SEARCH', 'FILTER_USED', 'WISHLIST_ADD', 'ADD_TO_CART', 'REMOVE_FROM_CART', 'BEGIN_CHECKOUT', 'CHECKOUT_START', 'COUPON_APPLIED', 'BANNER_IMPRESSION', 'BANNER_CLICK', 'WHATSAPP_CLICK', 'INSTAGRAM_SOURCE', 'ATTRIBUTION_CAPTURE']);
const RESERVED_EVENTS = new Set(['PURCHASE', 'PAYMENT_SUCCESS', 'PAYMENT_FAILED', 'PAYMENT_STARTED', 'RETURN_REQUESTED']);
const INTERNAL = /^\/(admin|seller|master|api|auth|login|register)(\/|$)/i;
const BOT = /bot\b|crawler|spider|headless|lighthouse|pagespeed|preview|facebookexternalhit|curl\/|wget\//i;
const PRIVATE_TEXT = /[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:\+?\d[\s().-]*){8,}|bearer\s|(?:password|token|otp|secret|signature)=/i;
const ID = /^[a-zA-Z0-9_-]{20,80}$/;

function cleanText(value, max = 80) {
  const text = String(value || '').normalize('NFKC').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);
  return PRIVATE_TEXT.test(text) ? '[redacted]' : text;
}
function cleanPath(value) {
  try {
    const url = new URL(String(value || '/'), 'https://analytics.invalid');
    if (!url.pathname.startsWith('/') || url.pathname.startsWith('//')) return '/';
    return url.pathname.split('/').map(part => {
      let decoded; try { decoded = decodeURIComponent(part); } catch { decoded = part; }
      return PRIVATE_TEXT.test(decoded) || decoded.length > 100 ? '[redacted]' : part;
    }).join('/').slice(0, 300);
  } catch { return '/'; }
}
function excluded(path, config) {
  const logicalPath = path.replace(/^\/store\/[^/]+(?=\/|$)/, '') || '/';
  return INTERNAL.test(logicalPath) || (config.excludedPaths || []).some(prefix => prefix === '/' || logicalPath === prefix || logicalPath.startsWith(`${prefix.replace(/\/$/, '')}/`));
}
function normalizeEvent(input, config, now = new Date()) {
  if (!input || !ID.test(input.eventId || '') || !ID.test(input.visitorId || '') || !ID.test(input.sessionId || '')) throw new ApiError('VALIDATION_ERROR', 'Invalid analytics identity.');
  const name = input.name === 'CHECKOUT_START' ? 'BEGIN_CHECKOUT' : input.name;
  if (!PUBLIC_EVENTS.has(name)) throw new ApiError('VALIDATION_ERROR', 'Only storefront events can be collected.');
  const occurredAt = new Date(input.occurredAt);
  if (!Number.isFinite(occurredAt.getTime()) || occurredAt > new Date(+now + 60000) || occurredAt < new Date(+now - DAY)) throw new ApiError('VALIDATION_ERROR', 'Analytics events must be within the last 24 hours.');
  const path = cleanPath(input.path);
  if (excluded(path, config)) return null;
  let referrer = '';
  try { referrer = new URL(input.referrer).hostname.toLowerCase().slice(0, 120); } catch { /* Never keep a full referrer URL. */ }
  if (config.excludedReferrers.includes(referrer)) return null;
  return {
    eventId: input.eventId, visitorId: input.visitorId, sessionId: input.sessionId, name, path,
    occurredAt: occurredAt > now ? now : occurredAt, receivedAt: now, referrer,
    source: cleanText(input.source).toLowerCase() || (referrer ? 'referral' : 'direct/unknown'),
    medium: cleanText(input.medium), campaign: cleanText(input.campaign), firstSource: cleanText(input.firstSource).toLowerCase(),
    device: ['mobile', 'desktop', 'tablet'].includes(input.device) ? input.device : 'unknown',
    browser: ['Chrome', 'Safari', 'Firefox', 'Edge', 'Opera', 'Other'].includes(input.browser) ? input.browser : 'Other',
    os: ['Android', 'iOS', 'Windows', 'macOS', 'Linux', 'Other'].includes(input.os) ? input.os : 'Other',
    searchQuery: name === 'SEARCH' ? cleanText(input.searchQuery, 120) : '',
    productId: /^[a-f\d]{24}$/i.test(input.productId || '') ? input.productId : undefined,
    categoryId: cleanText(input.categoryId || input.metadata?.categoryId, 80),
    metadata: Object.fromEntries(['surface', 'sectionId', 'categoryId', 'categoryName', 'action', 'milestone', 'bannerId', 'placement'].filter(key => input.metadata?.[key] !== undefined).map(key => [key, cleanText(input.metadata[key], 100)])),
    engagementMs: name === 'ENGAGEMENT' ? Math.max(0, Math.min(15000, Math.round(Number(input.engagementMs) || 0))) : 0,
    expiresAt: new Date(+now + config.rawRetentionDays * DAY), schemaVersion: 1,
  };
}
const hashToken = token => crypto.createHash('sha256').update(String(token)).digest('hex');
function tokenMatches(token, hash) {
  if (!ID.test(token || '') || !/^[a-f0-9]{64}$/i.test(hash || '')) return false;
  return crypto.timingSafeEqual(Buffer.from(hashToken(token)), Buffer.from(hash));
}

function parts(date, timezone) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
}
function dateKey(date, timezone) { const p = parts(date, timezone); return `${p.year}-${p.month}-${p.day}`; }
function shiftDate(key, days) { const date = new Date(`${key}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); }
function midnight(key, timezone) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !Number.isFinite(Date.parse(`${key}T00:00:00Z`)) || new Date(`${key}T00:00:00Z`).toISOString().slice(0, 10) !== key) throw new ApiError('VALIDATION_ERROR', 'Choose a valid calendar date.');
  const nominal = Date.parse(`${key}T00:00:00Z`);
  let result = nominal;
  for (let i = 0; i < 4; i += 1) { const p = parts(new Date(result), timezone); const represented = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second); result += nominal - represented; }
  return new Date(result);
}
function trafficRange(query = {}, timezone = 'Asia/Kolkata', now = new Date()) {
  const today = dateKey(now, timezone);
  const preset = query.from || query.to ? 'custom' : query.range || 'today';
  let fromKey = today; let toKey = today;
  if (preset === 'custom') { fromKey = String(query.from || ''); toKey = String(query.to || ''); }
  else if (preset === 'yesterday') { fromKey = shiftDate(today, -1); toKey = fromKey; }
  else if (preset === 'month') fromKey = `${today.slice(0, 7)}-01`;
  else if (preset !== 'today') {
    const days = { '7d': 7, '30d': 30, '90d': 90 }[preset];
    if (!days) throw new ApiError('VALIDATION_ERROR', 'Choose a valid traffic range.');
    fromKey = shiftDate(today, 1 - days);
  }
  const from = midnight(fromKey, timezone);
  const to = new Date(Math.min(+midnight(shiftDate(toKey, 1), timezone), +now + 1));
  if (toKey > today || fromKey > toKey || to <= from || to - from > 366 * DAY) throw new ApiError('VALIDATION_ERROR', 'Choose a date range up to today, no longer than 366 days.');
  const days = Math.round((Date.parse(`${toKey}T00:00:00Z`) - Date.parse(`${fromKey}T00:00:00Z`)) / DAY) + 1;
  const previousFrom = midnight(shiftDate(fromKey, -days), timezone);
  const previousEnd = midnight(fromKey, timezone);
  const elapsed = +to - +from;
  const previousTo = new Date(Math.min(+previousEnd, +previousFrom + elapsed));
  return { preset, from, to, previousFrom, previousTo, fromDate: fromKey, toDate: toKey, days, timezone };
}
module.exports = { DAY, ID, BOT, PUBLIC_EVENTS, RESERVED_EVENTS, cleanText, cleanPath, excluded, normalizeEvent, hashToken, tokenMatches, dateKey, midnight, shiftDate, trafficRange };
