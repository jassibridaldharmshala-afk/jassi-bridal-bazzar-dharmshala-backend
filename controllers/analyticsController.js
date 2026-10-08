const AnalyticsEvent = require('../models/AnalyticsEvent');
const Order = require('../models/Order');
const { EVENT_ALIASES, EVENT_NAMES } = require('../models/AnalyticsEvent');
const { asyncHandler } = require('../middleware/validate');
const { requireEnum, optionalString } = require('../utils/validators');
const { recordEvent } = require('../services/analyticsService');
const { readAttribution } = require('../utils/attribution');

const TRACKABLE_NAMES = EVENT_NAMES.concat(Object.keys(EVENT_ALIASES));

exports.track = asyncHandler(async (req, res) => {
  const name = requireEnum(req.body?.name, TRACKABLE_NAMES, 'name');
  if (require('../services/trafficAlgorithms').RESERVED_EVENTS.has(name)) return res.status(202).json({ success: true, ignored: true, reason: 'server_only_event' });
  const config = await require('../services/trafficConfigurationService').configuration(req.store);
  if (!config.enabled || config.consentRequired && req.body?.consent !== true) return res.status(202).json({ success: true, ignored: true, reason: 'privacy_settings' });
  const attribution = readAttribution(req.body);
  const event = await recordEvent({
    name,
    storeId: req.store?._id,
    sessionId: optionalString(req.body?.sessionId, 'sessionId', { max: 80 }),
    productId: req.body?.productId,
    path: require('../services/trafficAlgorithms').cleanPath(req.body?.path),
    searchQuery: name === 'SEARCH' ? await require('../services/trafficSearchPrivacyService').searchTopic(req.body?.searchQuery || req.body?.query, req.store) : undefined,
    source: require('../services/trafficAlgorithms').cleanText(attribution?.source),
    campaign: require('../services/trafficAlgorithms').cleanText(attribution?.campaign),
    reelId: attribution?.reelId,
    metadata: Object.fromEntries(['surface', 'sectionId', 'action', 'milestone', 'categoryId', 'categoryName', 'bannerId'].filter(key => req.body?.metadata?.[key] !== undefined).map(key => [key, require('../services/trafficAlgorithms').cleanText(req.body.metadata[key], 100)])),
  });
  res.status(202).json({ success: true, id: event?._id });
});

exports.funnel = asyncHandler(async (req, res) => {
  const match = { ...(req.tenantFilter || {}) };
  const since = daysAgo(req.query.range);
  if (since) match.createdAt = { $gte: since };

  const rows = await AnalyticsEvent.aggregate([
    { $match: match },
    { $group: { _id: '$name', count: { $sum: 1 } } },
  ]);
  const byName = Object.fromEntries(EVENT_NAMES.map((name) => [name, 0]));
  for (const row of rows) byName[row._id] = row.count;

  const sources = await AnalyticsEvent.aggregate([
    { $match: { ...match, source: { $exists: true, $ne: '' } } },
    { $group: { _id: '$source', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 20 },
  ]);

  const campaigns = await AnalyticsEvent.aggregate([
    { $match: { ...match, $or: [{ campaign: { $exists: true, $ne: '' } }, { reelId: { $exists: true, $ne: '' } }] } },
    {
      $group: {
        _id: { source: '$source', campaign: '$campaign', reelId: '$reelId' },
        events: { $sum: 1 },
        productViews: { $sum: { $cond: [{ $eq: ['$name', 'PRODUCT_VIEW'] }, 1, 0] } },
        addToCart: { $sum: { $cond: [{ $eq: ['$name', 'ADD_TO_CART'] }, 1, 0] } },
        purchases: { $sum: { $cond: [{ $eq: ['$name', 'PURCHASE'] }, 1, 0] } },
      },
    },
    { $sort: { events: -1 } },
    { $limit: 20 },
  ]);

  const orderMatch = { ...(req.tenantFilter || {}), orderStatus: { $ne: 'Cancelled' } };
  if (since) orderMatch.createdAt = { $gte: since };
  const attributedOrders = await Order.aggregate([
    { $match: { ...orderMatch, 'attribution.source': { $exists: true, $ne: '' } } },
    {
      $group: {
        _id: { source: '$attribution.source', campaign: '$attribution.campaign', reelId: '$attribution.reelId' },
        orders: { $sum: 1 },
        revenue: { $sum: '$finalAmount' },
      },
    },
    { $sort: { revenue: -1 } },
    { $limit: 20 },
  ]);

  res.json({
    range: req.query.range || '30d',
    events: byName,
    rentalFunnel: ['RENTAL_CTA', 'RENTAL_DATES_CHECK', 'RENTAL_QUOTE_SUCCESS', 'RENTAL_QUOTE_FAILURE', 'RENTAL_HOLD_CREATED', 'RENTAL_PAYMENT_VERIFIED'].map(name => ({ name, count: byName[name] || 0 })),
    sources: sources.map((row) => ({ source: row._id, count: row.count })),
    campaigns: campaigns.map((row) => ({
      source: row._id.source || '',
      campaign: row._id.campaign || '',
      reelId: row._id.reelId || '',
      events: row.events,
      productViews: row.productViews,
      addToCart: row.addToCart,
      purchases: row.purchases,
    })),
    attributedSales: attributedOrders.map((row) => ({
      source: row._id.source || '',
      campaign: row._id.campaign || '',
      reelId: row._id.reelId || '',
      orders: row.orders,
      revenue: Math.round(Number(row.revenue || 0) * 100) / 100,
    })),
    note: 'Counts are from events and orders stored by this app. Instagram view counts are not imported.',
  });
});

function daysAgo(range) {
  const days = { today: 1, '7d': 7, '30d': 30, '90d': 90 }[String(range || '30d')];
  if (!days) return null;
  const date = new Date();
  if (range === 'today') date.setHours(0, 0, 0, 0);
  else date.setDate(date.getDate() - days);
  return date;
}
