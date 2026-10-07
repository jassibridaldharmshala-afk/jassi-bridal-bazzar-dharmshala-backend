const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { cleanPath, cleanText, normalizeEvent, trafficRange, hashToken, tokenMatches } = require('../services/trafficAlgorithms');
const { DEFAULTS, validateConfiguration } = require('../services/trafficConfigurationService');
const trafficContext = require('../utils/trafficContext');
const event = overrides => ({ eventId: crypto.randomUUID(), visitorId: crypto.randomUUID(), sessionId: crypto.randomUUID(), name: 'PAGE_VIEW', occurredAt: new Date().toISOString(), path: '/', ...overrides });
test('IST midnight and equal elapsed comparison', () => {
  const range = trafficRange({ range: 'today' }, 'Asia/Kolkata', new Date('2026-10-01T08:08:00Z'));
  assert.equal(range.from.toISOString(), '2026-09-30T18:30:00.000Z');
  assert.equal(range.previousFrom.toISOString(), '2026-09-29T18:30:00.000Z');
  assert.equal(range.previousTo.toISOString(), '2026-09-30T08:08:00.001Z');
});
test('calendar ranges handle DST and reject impossible/future dates', () => {
  const range = trafficRange({ from: '2026-03-08', to: '2026-03-08' }, 'America/New_York', new Date('2026-03-10T12:00:00Z'));
  assert.equal(range.to - range.from, 23 * 3600000);
  assert.throws(() => trafficRange({ from: '2026-02-30', to: '2026-03-01' }));
  assert.throws(() => trafficRange({ from: '2099-01-01', to: '2099-01-02' }));
});
test('raw query strings, emails, phones and arbitrary metadata are not retained', () => {
  assert.equal(cleanPath('/product/item?token=secret&email=person@example.com'), '/product/item');
  assert.equal(cleanPath('/profile/person%40example.com'), '/profile/[redacted]');
  assert.equal(cleanText('call +91 9876543210'), '[redacted]');
  const value = normalizeEvent(event({ referrer: 'https://example.com/?secret=foo', searchQuery: 'person@example.com', name: 'SEARCH', metadata: { token: 'secret', sectionId: 'featured' } }), DEFAULTS);
  assert.equal(value.referrer, 'example.com'); assert.equal(value.searchQuery, '[redacted]'); assert.deepEqual(value.metadata, { sectionId: 'featured' });
});
test('server-only purchase events, stale clocks and unbounded engagement are rejected', () => {
  assert.throws(() => normalizeEvent(event({ name: 'PURCHASE' }), DEFAULTS));
  assert.throws(() => normalizeEvent(event({ occurredAt: '2000-01-01' }), DEFAULTS));
  assert.equal(normalizeEvent(event({ name: 'ENGAGEMENT', engagementMs: 999999 }), DEFAULTS).engagementMs, 15000);
});
test('internal and additional excluded paths are filtered', () => {
  assert.equal(normalizeEvent(event({ path: '/store/jewellery/admin/orders' }), DEFAULTS), null);
  assert.equal(normalizeEvent(event({ path: '/test/demo' }), { ...DEFAULTS, excludedPaths: ['/test'] }), null);
});
test('settings enforce retention, timezone and GA4 consent', () => {
  assert.throws(() => validateConfiguration({ rawRetentionDays: 7 }, DEFAULTS));
  assert.equal(validateConfiguration({ rawRetentionDays: 7, confirmRetentionReduction: true }, DEFAULTS).rawRetentionDays, 7);
  assert.throws(() => validateConfiguration({ timezone: 'invalid' }, DEFAULTS));
  assert.throws(() => validateConfiguration({ ga4Enabled: true, ga4MeasurementId: 'G-ABCDEF', consentRequired: false }, DEFAULTS));
  assert.throws(() => validateConfiguration({ summaryRetentionDays: 30, rawRetentionDays: 90, confirmRetentionReduction: true }, DEFAULTS));
});
test('deletion token and checkout context never confer payment/store authority', () => {
  const token = crypto.randomUUID(); assert.equal(tokenMatches(token, hashToken(token)), true); assert.equal(tokenMatches(crypto.randomUUID(), hashToken(token)), false);
  assert.equal(trafficContext({ traffic: { visitorId: crypto.randomUUID(), sessionId: crypto.randomUUID() } }), undefined);
  const input = { visitorId: crypto.randomUUID(), sessionId: crypto.randomUUID(), consent: true, storeId: 'forged', paymentStatus: 'Paid' };
  assert.deepEqual(trafficContext({ traffic: input }), { visitorId: input.visitorId, sessionId: input.sessionId });
});
test('hourly charts fill measured-period gaps without inventing pre-collection history', () => {
  const { completeSeries } = require('../services/trafficReportingService');
  const range = trafficRange({ range: 'today' }, 'Asia/Kolkata', new Date('2026-10-01T08:08:00Z'));
  const rows = completeSeries([{ key: '2026-10-01 12:00 +0530', visitors: 3, sessions: 4, pageViews: 5 }], range, 'Asia/Kolkata', new Date('2026-10-01T05:25:00Z'));
  assert.equal(rows.length, 4); assert.equal(rows[0].key, '2026-10-01 10:00 +0530'); assert.equal(rows[0].visitors, 0); assert.equal(rows[2].visitors, 3);
  assert.deepEqual(completeSeries([], range, 'Asia/Kolkata', new Date()), []);
});
test('hourly charts preserve both repeated local hours at the DST fall-back boundary', () => {
  const { completeSeries } = require('../services/trafficReportingService');
  const range = trafficRange({ from: '2026-11-01', to: '2026-11-01' }, 'America/New_York', new Date('2026-11-03T12:00:00Z'));
  const rows = completeSeries([{ key: '2026-11-01 01:00 -0400', visitors: 1 }], range, 'America/New_York', range.from);
  assert.equal(rows.length, 25); assert.equal(new Set(rows.map(row => row.key)).size, 25); assert.ok(rows.some(row => row.key === '2026-11-01 01:00 -0500'));
});
