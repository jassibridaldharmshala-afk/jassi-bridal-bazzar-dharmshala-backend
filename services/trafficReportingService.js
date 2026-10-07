const { Event, Session, Slice, Configuration } = require('../models/TrafficAnalytics');
const Order = require('../models/Order');
const Product = require('../models/Product');
const { DEFAULTS, configuration } = require('./trafficConfigurationService');
const { trafficRange, DAY, cleanText } = require('./trafficAlgorithms');
const { andFilter } = require('./storeService');
const round = n => Math.round(Number(n || 0) * 100) / 100;
const pair = field => ({ storeId: '$storeId', id: `$${field}` });
const QUARTER = 900000;
const cache = new Map();
function invalidateTrafficCache(storeId) { for (const key of cache.keys()) if (!storeId || key.startsWith(`${storeId}:`) || key.startsWith('all:')) cache.delete(key); }

function filtered(scope, query) {
  const filter = { ...scope, expiresAt: { $gt: new Date() } };
  for (const key of ['source', 'campaign', 'device', 'browser']) if (query[key]) filter[key] = cleanText(query[key]);
  return filter;
}
function factsPipeline(scope, query, range) {
  const endBucket = new Date(Math.floor(+range.to / QUARTER) * QUARTER);
  const match = filtered(scope, query);
  const pipeline = [{ $match: andFilter(match, { hour: { $gte: range.from, $lt: endBucket } }) }];
  // Read the partial final bucket from raw events so yesterday's 13:08
  // comparison never accidentally includes events through 13:15.
  if (range.to > endBucket) pipeline.push({ $unionWith: { coll: Event.collection.name, pipeline: [
    { $match: andFilter(filtered(scope, {}), { occurredAt: { $gte: endBucket, $lt: range.to } }) },
    { $sort: { occurredAt: 1, eventId: 1 } },
    { $group: { _id: { storeId: '$storeId', sessionId: '$sessionId' }, storeId: { $first: '$storeId' }, sessionId: { $first: '$sessionId' }, visitorId: { $first: '$visitorId' }, hour: { $first: endBucket }, source: { $first: '$source' }, firstSource: { $first: '$firstSource' }, campaign: { $first: '$campaign' }, device: { $first: '$device' }, browser: { $first: '$browser' }, os: { $first: '$os' }, firstActivityAt: { $min: '$occurredAt' }, lastActivityAt: { $max: '$occurredAt' }, pageViews: { $sum: { $cond: [{ $eq: ['$name', 'PAGE_VIEW'] }, 1, 0] } }, engagementMs: { $sum: '$engagementMs' } } },
    { $lookup: { from: 'trafficvisitors', let: { store: '$storeId', visitor: '$visitorId' }, pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$storeId', '$$store'] }, { $eq: ['$visitorId', '$$visitor'] }, { $eq: ['$disabled', false] }] } } }, { $project: { firstSeenAt: 1, firstSource: 1 } }], as: 'visitor' } },
    { $match: { 'visitor.0': { $exists: true } } }, { $set: { firstSeenAt: { $arrayElemAt: ['$visitor.firstSeenAt', 0] }, firstSource: { $arrayElemAt: ['$visitor.firstSource', 0] } } },
    { $lookup: { from: Session.collection.name, let: { store: '$storeId', session: '$sessionId' }, pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$storeId', '$$store'] }, { $eq: ['$sessionId', '$$session'] }] } } }, { $project: { source: 1, campaign: 1, device: 1, browser: 1, os: 1 } }], as: 'session' } },
    { $set: Object.fromEntries(['source', 'campaign', 'device', 'browser', 'os'].map(key => [key, { $ifNull: [{ $arrayElemAt: [`$session.${key}`, 0] }, `$${key}`] }])) },
    { $match: Object.fromEntries(['source', 'campaign', 'device', 'browser'].filter(key => query[key]).map(key => [key, cleanText(query[key])])) },
  ] } });
  return pipeline;
}
async function overview(scope, query, range, timezone) {
  // Count grouped identities, never accumulate an unbounded array of visitor IDs.
  const distribution = (label, output = 'label') => [
    { $group: { _id: { label, visitor: pair('visitorId'), session: pair('sessionId') }, pageViews: { $sum: '$pageViews' } } },
    { $group: { _id: { label: '$_id.label', visitor: '$_id.visitor' }, sessions: { $sum: 1 }, pageViews: { $sum: '$pageViews' } } },
    { $group: { _id: '$_id.label', visitors: { $sum: 1 }, sessions: { $sum: '$sessions' }, pageViews: { $sum: '$pageViews' } } },
    { $project: { _id: 0, [output]: { $ifNull: ['$_id', 'unknown'] }, sessions: 1, visitors: 1, pageViews: 1 } },
  ];
  const breakdown = key => [...distribution(`$${key}`), { $sort: { sessions: -1, label: 1 } }, { $limit: 30 }];
  const [result] = await Slice.aggregate([...factsPipeline(scope, query, range), { $facet: {
    totals: [{ $group: { _id: null, pageViews: { $sum: '$pageViews' }, engagementMs: { $sum: '$engagementMs' } } }],
    sessionCount: [{ $group: { _id: pair('sessionId') } }, { $count: 'value' }],
    types: [{ $group: { _id: pair('visitorId'), firstSeenAt: { $min: '$firstSeenAt' } } }, { $group: { _id: { $cond: [{ $gte: ['$firstSeenAt', range.from] }, 'new', 'returning'] }, count: { $sum: 1 } } }],
    sources: breakdown('source'), firstSources: breakdown('firstSource'), campaigns: breakdown('campaign'), devices: breakdown('device'), browsers: breakdown('browser'), operatingSystems: breakdown('os'),
    series: [...distribution({ $dateToString: { date: '$hour', format: range.days === 1 ? '%Y-%m-%d %H:00 %z' : '%Y-%m-%d', timezone } }, 'key'), { $sort: { key: 1 } }],
  } }]).option({ maxTimeMS: 15000 });
  const totals = result.totals[0] || {};
  const count = key => result.types.find(row => row._id === key)?.count || 0;
  const sessions = result.sessionCount[0]?.value || 0;
  return { ...result, totals: { visitors: count('new') + count('returning'), sessions, pageViews: totals.pageViews || 0, newVisitors: count('new'), returningVisitors: count('returning'), engagementMs: totals.engagementMs || 0, averageEngagementSeconds: sessions ? round(totals.engagementMs / sessions / 1000) : 0 } };
}

async function funnel(scope, query, range) {
  const match = andFilter(filtered(scope, query), { startedAt: { $gte: range.from, $lt: range.to }, pageViews: { $exists: true } });
  const [result] = await Session.aggregate([{ $match: match }, { $lookup: {
    from: Order.collection.name, let: { store: '$storeId', visitor: '$visitorId', session: '$sessionId', checkout: '$checkoutAt' },
    pipeline: [{ $match: { $expr: { $and: [
      { $eq: ['$storeId', '$$store'] }, { $eq: ['$traffic.visitorId', '$$visitor'] }, { $eq: ['$traffic.sessionId', '$$session'] },
      { $ne: ['$$checkout', null] }, { $gte: ['$createdAt', '$$checkout'] }, { $lte: ['$createdAt', { $add: ['$$checkout', DAY] }] },
      { $not: [{ $in: ['$orderStatus', ['Pending', 'Cancelled']] }] }, { $ne: ['$paymentStatus', 'Failed'] },
    ] } } }, { $project: { paymentMethod: 1, paymentStatus: 1, paymentState: 1 } }], as: 'orders',
  } }, { $group: { _id: null, visitors: { $sum: 1 }, product: { $sum: { $cond: ['$productAt', 1, 0] } }, cart: { $sum: { $cond: ['$cartAt', 1, 0] } }, checkout: { $sum: { $cond: ['$checkoutAt', 1, 0] } }, order: { $sum: { $cond: [{ $gt: [{ $size: '$orders' }, 0] }, 1, 0] } }, payment: { $sum: { $cond: [{ $gt: [{ $size: { $filter: { input: '$orders', as: 'order', cond: { $and: [{ $ne: ['$$order.paymentMethod', 'COD'] }, { $or: [{ $in: ['$$order.paymentState', ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED']] }, { $in: ['$$order.paymentStatus', ['Paid', 'Refunded']] }] }] } } } }, 0] }, 1, 0] } }, engaged: { $sum: { $cond: [{ $or: [{ $gte: ['$engagementMs', 10000] }, { $gte: ['$pageViews', 2] }, { $gt: [{ $size: '$orders' }, 0] }] }, 1, 0] } } } }]).option({ maxTimeMS: 15000 });
  const values = result || {};
  const labels = [['visitors', 'Visits started'], ['product', 'Product viewed'], ['cart', 'Added to bag'], ['checkout', 'Checkout started'], ['order', 'Verified order'], ['payment', 'Online payment confirmed']];
  const steps = labels.map(([key, label], index) => ({ label, value: values[key] || 0, rate: index && values[labels[index - 1][0]] ? round(values[key] / values[labels[index - 1][0]] * 100) : index ? 0 : 100 }));
  return { steps, conversionRate: values.visitors ? round(values.order / values.visitors * 100) : 0, engagementRate: values.visitors ? round(values.engaged / values.visitors * 100) : 0, bounceRate: values.visitors ? round((1 - values.engaged / values.visitors) * 100) : 0, note: 'Sessions started in this period. Ordered steps must occur within 24 hours of the previous step; verified orders must be placed within 24 hours of checkout. Outcomes reflect current order state. COD collection is not an online-payment step.' };
}
async function details(scope, query, range) {
  const match = andFilter(filtered(scope, query), { occurredAt: { $gte: range.from, $lt: range.to } });
  const rank = (name, field) => [{ $match: { name, [field]: { $exists: true, $nin: ['', null] } } }, { $group: { _id: { label: `$${field}`, visitor: pair('visitorId') }, value: { $sum: 1 } } }, { $group: { _id: '$_id.label', value: { $sum: '$value' }, visitors: { $sum: 1 } } }, { $sort: { value: -1, _id: 1 } }, { $limit: 20 }, { $project: { _id: 0, label: { $toString: '$_id' }, value: 1, visitors: 1 } }];
  const [result] = await Event.aggregate([{ $match: match }, { $facet: { pages: rank('PAGE_VIEW', 'path'), products: rank('PRODUCT_VIEW', 'productId'), searches: rank('SEARCH', 'searchQuery'), categories: rank('HOME_CATEGORY_CLICK', 'categoryId') } }]).option({ maxTimeMS: 15000 });
  const ids = result.products.map(row => row.label);
  if (ids.length) {
    const products = await Product.find(andFilter(scope, { _id: { $in: ids } })).select('name').lean();
    const names = Object.fromEntries(products.map(row => [String(row._id), row.name]));
    result.products = result.products.map(row => ({ ...row, label: names[row.label] || 'Unavailable product' }));
  }
  const [landings, lastPages] = await Promise.all(['landingPage', 'lastPage'].map(field => Session.aggregate([{ $match: andFilter(filtered(scope, query), { startedAt: { $gte: range.from, $lt: range.to } }) }, { $group: { _id: `$${field}`, value: { $sum: 1 } } }, { $sort: { value: -1 } }, { $limit: 20 }, { $project: { _id: 0, label: '$_id', value: 1 } }])));
  return { ...result, landings, lastPages };
}
async function commerce(scope, range) {
  const [row] = await Order.aggregate([{ $match: andFilter(scope, { createdAt: { $gte: range.from, $lt: range.to } }) }, { $group: {
    _id: null,
    ordersPlaced: { $sum: { $cond: [{ $not: [{ $in: ['$orderStatus', ['Pending', 'Cancelled']] }] }, 1, 0] } },
    codPlaced: { $sum: { $cond: [{ $and: [{ $eq: ['$paymentMethod', 'COD'] }, { $not: [{ $in: ['$orderStatus', ['Pending', 'Cancelled']] }] }] }, 1, 0] } },
    onlinePaid: { $sum: { $cond: [{ $and: [{ $ne: ['$paymentMethod', 'COD'] }, { $or: [{ $in: ['$paymentState', ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED']] }, { $in: ['$paymentStatus', ['Paid', 'Refunded']] }] }] }, 1, 0] } },
    codCollected: { $sum: { $cond: [{ $and: [{ $eq: ['$paymentMethod', 'COD'] }, { $eq: ['$paymentStatus', 'Paid'] }] }, 1, 0] } },
    cancelled: { $sum: { $cond: [{ $eq: ['$orderStatus', 'Cancelled'] }, 1, 0] } },
    refunds: { $sum: { $ifNull: ['$refundedAmount', 0] } },
  } }]);
  return { ordersPlaced: 0, codPlaced: 0, onlinePaid: 0, codCollected: 0, cancelled: 0, refunds: 0, ...row, note: 'All store orders placed in the selected period, including customers not tracked by analytics. Payment/refund status is current, not a cash-flow-by-payment-date report. Source/device traffic filters do not filter these totals.' };
}
function completeSeries(rows, range, timezone, collectionStartedAt) {
  if (!rows.length) return rows;
  const values = new Map(rows.map(row => [row.key, row]));
  const step = range.days === 1 ? 3600000 : DAY;
  const first = collectionStartedAt ? +new Date(collectionStartedAt) : +range.from;
  const result = [];
  const formatter = new Intl.DateTimeFormat('en', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' });
  for (let at = +range.from; at < +range.to;) {
    const date = new Date(at); const day = require('./trafficAlgorithms').dateKey(date, timezone);
    let key = day;
    if (range.days === 1) {
      const parts = Object.fromEntries(formatter.formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
      const offset = parts.timeZoneName.replace('GMT', '').replace(':', '') || '+0000';
      key = `${day} ${parts.hour}:00 ${offset}`;
    }
    const next = range.days === 1 ? at + step : +require('./trafficAlgorithms').midnight(require('./trafficAlgorithms').shiftDate(day, 1), timezone);
    if (values.has(key) || (collectionStartedAt ? next > first : key >= rows[0].key)) result.push(values.get(key) || { key, visitors: 0, sessions: 0, pageViews: 0 });
    at = next;
  }
  return result;
}
async function buildTrafficReport(context, config) {
  const timezone = config.timezone;
  const query = context.query || {};
  const scope = context.store ? { storeId: context.store._id } : context.tenantFilter || {};
  const range = trafficRange(query, timezone);
  const previousRange = { ...range, from: range.previousFrom, to: range.previousTo };
  const [current, previous, journey, ranked, sales, active, pending, lastEvent] = await Promise.all([
    overview(scope, query, range, timezone), overview(scope, query, previousRange, timezone), funnel(scope, query, range), details(scope, query, range), commerce(context.tenantFilter || scope, range),
    Session.aggregate([{ $match: andFilter(filtered(scope, query), { lastActivityAt: { $gte: new Date(Date.now() - 300000) } }) }, { $group: { _id: pair('visitorId') } }, { $count: 'value' }]),
    Event.findOne(andFilter(scope, { processedAt: { $exists: false }, expiresAt: { $gt: new Date() } })).sort({ receivedAt: 1 }).select('receivedAt').lean(),
    Event.findOne(scope).sort({ receivedAt: -1 }).select('receivedAt').lean(),
  ]);
  const metrics = Object.fromEntries(Object.entries(current.totals).filter(([key]) => key !== 'engagementMs').map(([key, value]) => [key, { value, previous: previous.totals[key], delta: previous.totals[key] > 0 ? round((value - previous.totals[key]) / previous.totals[key] * 100) : null }]));
  const lagSeconds = pending ? Math.max(0, Math.floor((Date.now() - +pending.receivedAt) / 1000)) : 0;
  const rawAvailableFrom = new Date(Date.now() - config.rawRetentionDays * DAY);
  return {
    calculatedAt: new Date(), timezone, range: { ...range, from: range.from.toISOString(), to: range.to.toISOString() }, metrics,
    activeVisitors: active[0]?.value || 0, series: completeSeries(current.series, range, timezone, config.collectionStartedAt), sources: current.sources, firstSources: current.firstSources,
    campaigns: current.campaigns, devices: current.devices, browsers: current.browsers, operatingSystems: current.operatingSystems,
    funnel: journey, details: ranked, commerce: sales,
    health: { enabled: config.enabled, state: !config.enabled ? 'disabled' : lagSeconds > 60 ? 'delayed' : !lastEvent ? 'awaiting_data' : 'collecting', pendingSince: pending?.receivedAt, lagSeconds, lastCollectedAt: config.lastCollectedAt || lastEvent?.receivedAt, lastProcessedAt: config.lastProcessedAt, collectionStartedAt: config.collectionStartedAt, failures: config.failures || 0, lastFailureAt: config.lastFailureAt },
    retention: { rawDays: config.rawRetentionDays, summaryDays: config.summaryRetentionDays, rawAvailableFrom, detailsPartial: range.from < rawAvailableFrom },
    definitions: { visitors: 'Distinct anonymous browser identities, not guaranteed unique people. Counts are deduplicated across the selected period.', sessions: 'Distinct visits with activity in this period. A new visit starts after the configured inactivity timeout.', active: 'Distinct visitors with collected activity in the last 5 minutes; updates can lag behind collection.', engagement: 'Foreground interaction time only. An engaged session has at least 10 active seconds, 2 page views, or a verified order.', comparison: 'Previous calendar period matched to the same elapsed duration. A partial final bucket is read from raw events.', privacy: 'Consent, blocked storage, ad blockers and network loss can reduce measured traffic. No fingerprinting or precise location is collected.' },
    ignoredFilters: Object.keys(query).filter(key => ['status', 'paymentMethod', 'coupon', 'city', 'pincode', 'provider', 'product', 'category'].includes(key)),
  };
}
async function trafficReport(context) {
  const config = context.store ? await configuration(context.store) : { ...DEFAULTS, timezone: context.timezone };
  const query = Object.fromEntries(Object.entries(context.query || {}).sort(([a], [b]) => a.localeCompare(b)));
  const key = `${context.store?._id || 'all'}:${config.revision}:${config.privacyGeneration}:${config.timezone}:${Math.floor(Date.now() / 15000)}:${JSON.stringify(query)}:${JSON.stringify(context.tenantFilter || {})}`;
  const existing = cache.get(key); if (existing?.until > Date.now()) return existing.promise;
  if (cache.size >= 200) cache.delete(cache.keys().next().value);
  const promise = buildTrafficReport(context, config).catch(error => { cache.delete(key); throw error; });
  cache.set(key, { until: Date.now() + 15000, promise }); return promise;
}
module.exports = { trafficReport, overview, factsPipeline, funnel, commerce, completeSeries, invalidateTrafficCache };
