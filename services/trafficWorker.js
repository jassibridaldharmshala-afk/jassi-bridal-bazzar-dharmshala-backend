const crypto = require('node:crypto');
const { Configuration, Visitor, Event, Session, Slice, Bucket, Lease, Digest } = require('../models/TrafficAnalytics');
const AnalyticsEvent = require('../models/AnalyticsEvent');
const { EVENT_NAMES } = require('../models/AnalyticsEvent');
const { DEFAULTS } = require('./trafficConfigurationService');
const { DAY } = require('./trafficAlgorithms');
let timer; let running = false;

async function withLease(work) {
  const owner = crypto.randomUUID();
  const now = new Date();
  let claimed;
  try {
    claimed = await Lease.findOneAndUpdate({ _id: 'traffic-materializer', $or: [{ lockedUntil: { $lte: now } }, { lockedUntil: { $exists: false } }] }, { $set: { owner, lockedUntil: new Date(+now + 120000) }, $inc: { generation: 1 } }, { upsert: true, new: true }).lean();
  } catch (error) { if (error.code === 11000) return null; throw error; }
  if (!claimed) return null;
  const renew = setInterval(() => Lease.updateOne({ _id: claimed._id, owner }, { $set: { lockedUntil: new Date(Date.now() + 120000) } }).catch(() => {}), 30000);
  renew.unref();
  const guard = async () => { if (!await Lease.exists({ _id: claimed._id, owner, lockedUntil: { $gt: new Date() } })) throw new Error('Traffic worker lease expired; the pending batch will be recovered.'); };
  try { return await work({ version: claimed.generation, guard }); }
  finally { clearInterval(renew); await Lease.updateOne({ _id: claimed._id, owner }, { $set: { lockedUntil: new Date(0) }, $unset: { owner: 1 } }).catch(() => {}); }
}

const fenced = (filter, version) => ({ ...filter, $or: [{ materializationVersion: { $lte: version } }, { materializationVersion: { $exists: false } }] });
async function rebuildBucket(storeId, hour, config, version = 0) {
  const [facts] = await Slice.aggregate([{ $match: { storeId, hour, expiresAt: { $gt: new Date() } } }, { $group: { _id: '$visitorId', sessions: { $sum: 1 }, pageViews: { $sum: '$pageViews' }, engagementMs: { $sum: '$engagementMs' } } }, { $group: { _id: null, visitors: { $sum: 1 }, sessions: { $sum: '$sessions' }, pageViews: { $sum: '$pageViews' }, engagementMs: { $sum: '$engagementMs' } } }]);
  if (!facts) return Bucket.deleteOne(fenced({ storeId, hour }, version));
  return Bucket.updateOne(fenced({ storeId, hour }, version), { $set: { materializationVersion: version, visitors: facts.visitors, sessions: facts.sessions, pageViews: facts.pageViews, engagementMs: facts.engagementMs, expiresAt: new Date(+hour + config.summaryRetentionDays * DAY) } }, { upsert: true });
}
async function eraseVisitor(visitor, lease = { version: 0, guard: async () => {} }) {
  await lease.guard();
  const filter = { storeId: visitor.storeId, visitorId: visitor.visitorId };
  const hours = await Slice.distinct('hour', filter);
  const eventIds = await Event.distinct('eventId', filter);
  await Promise.all([Event, Session, Slice].map(Model => Model.deleteMany(filter)));
  await require('../models/Order').updateMany({ storeId: visitor.storeId, 'traffic.visitorId': visitor.visitorId }, { $unset: { traffic: 1, attribution: 1 } });
  // Bridge rows intentionally contain no persistent user/visitor identifiers.
  if (eventIds.length) await AnalyticsEvent.deleteMany({ storeId: visitor.storeId, trafficEventId: { $in: eventIds } });
  // Rows whose raw event has already expired expire with the same raw retention.
  const config = { ...DEFAULTS, ...await Configuration.findOne({ storeId: visitor.storeId }).lean() };
  for (const hour of hours) { await lease.guard(); await rebuildBucket(visitor.storeId, hour, config, lease.version); }
  await Visitor.updateOne({ _id: visitor._id }, { $set: { deletionPending: false } });
  require('./trafficReportingService').invalidateTrafficCache(visitor.storeId);
}

async function materialize(storeId, sessionId, config, lease = { version: 0, guard: async () => {} }) {
  const match = { storeId, sessionId, privacyGeneration: config.privacyGeneration, expiresAt: { $gt: new Date() } };
  const snapshotIds = await Event.find({ ...match, processedAt: { $exists: false } }).select('_id').lean();
  if (!snapshotIds.length) return;
  const [result] = await Event.aggregate([{ $match: match }, { $sort: { occurredAt: 1, eventId: 1 } }, { $facet: {
    session: [{ $group: { _id: null, visitorId: { $first: '$visitorId' }, startedAt: { $min: '$occurredAt' }, lastActivityAt: { $max: '$occurredAt' }, landingPage: { $first: '$path' }, lastPage: { $last: '$path' }, source: { $first: '$source' }, medium: { $first: '$medium' }, campaign: { $first: '$campaign' }, device: { $first: '$device' }, browser: { $first: '$browser' }, os: { $first: '$os' }, pageViews: { $sum: { $cond: [{ $eq: ['$name', 'PAGE_VIEW'] }, 1, 0] } }, engagementMs: { $sum: '$engagementMs' } } }],
    slices: [{ $group: { _id: { $dateTrunc: { date: '$occurredAt', unit: 'minute', binSize: 15, timezone: 'UTC' } }, firstActivityAt: { $min: '$occurredAt' }, lastActivityAt: { $max: '$occurredAt' }, pageViews: { $sum: { $cond: [{ $eq: ['$name', 'PAGE_VIEW'] }, 1, 0] } }, engagementMs: { $sum: '$engagementMs' } } }],
  } }]).option({ maxTimeMS: 15000 });
  const facts = result?.session?.[0];
  if (!facts) return;
  const visitor = await Visitor.findOne({ storeId, visitorId: facts.visitorId, disabled: false }).lean();
  if (!visitor) { await Event.deleteMany(match); return; }
  const step = (name, after) => Event.findOne({ ...match, name, ...(after ? { occurredAt: { $gte: after, $lte: new Date(+after + DAY) } } : {}) }).sort({ occurredAt: 1 }).select('occurredAt').lean();
  const product = await step('PRODUCT_VIEW');
  const cart = product ? await step('ADD_TO_CART', product.occurredAt) : null;
  const checkout = cart ? await step('BEGIN_CHECKOUT', cart.occurredAt) : null;
  delete facts._id;
  const shared = { storeId, sessionId, materializationVersion: lease.version, visitorId: facts.visitorId, firstSeenAt: visitor.firstSeenAt, firstSource: visitor.firstSource, source: facts.source, medium: facts.medium, campaign: facts.campaign, device: facts.device, browser: facts.browser, os: facts.os };
  await lease.guard();
  await Session.updateOne(fenced({ storeId, sessionId }, lease.version), { $set: { ...facts, ...shared, productAt: product?.occurredAt || null, cartAt: cart?.occurredAt || null, checkoutAt: checkout?.occurredAt || null, expiresAt: new Date(+facts.lastActivityAt + config.summaryRetentionDays * DAY) } }, { upsert: true });
  await lease.guard();
  await Slice.bulkWrite(result.slices.map(slice => ({ updateOne: { filter: fenced({ storeId, sessionId, hour: slice._id }, lease.version), update: { $set: { ...shared, hour: slice._id, firstActivityAt: slice.firstActivityAt, lastActivityAt: slice.lastActivityAt, pageViews: slice.pageViews, engagementMs: slice.engagementMs, expiresAt: new Date(+slice._id + config.summaryRetentionDays * DAY) } }, upsert: true } })));
  for (const slice of result.slices) { await lease.guard(); await rebuildBucket(storeId, slice._id, config, lease.version); }
  await lease.guard();
  const bridge = await Event.find({ _id: { $in: snapshotIds.map(row => row._id) }, name: { $in: EVENT_NAMES } }).lean();
  if (bridge.length) await AnalyticsEvent.bulkWrite(bridge.map(event => ({ updateOne: { filter: { storeId, trafficEventId: event.eventId }, update: { $setOnInsert: { storeId, trafficEventId: event.eventId, name: event.name, sessionId, productId: event.productId, path: event.path, searchQuery: event.searchQuery, source: event.source, campaign: event.campaign, metadata: event.metadata, createdAt: event.occurredAt, expiresAt: event.expiresAt } }, upsert: true } })));
  // Mark only the captured pending IDs. Events arriving during aggregation
  // remain pending and trigger a full, idempotent rebuild on the next tick.
  await Event.updateMany({ _id: { $in: snapshotIds.map(row => row._id) } }, { $set: { processedAt: new Date() } });
  await Configuration.updateOne({ storeId }, { $set: { lastProcessedAt: new Date() } });
  require('./trafficReportingService').invalidateTrafficCache(storeId);
}
async function tick() {
  if (running) return;
  running = true;
  try {
    return await withLease(async lease => {
      const deletions = await Visitor.find({ deletionPending: true }).limit(50).lean();
      for (const visitor of deletions) await eraseVisitor(visitor, lease);
      const pending = await Event.aggregate([{ $match: { processedAt: { $exists: false }, expiresAt: { $gt: new Date() } } }, { $sort: { receivedAt: 1 } }, { $limit: 2000 }, { $group: { _id: { storeId: '$storeId', sessionId: '$sessionId' } } }, { $limit: 100 }]);
      for (const row of pending) {
        const { storeId, sessionId } = row._id;
        const config = { ...DEFAULTS, ...await Configuration.findOne({ storeId }).lean() };
        await Event.deleteMany({ storeId, privacyGeneration: { $ne: config.privacyGeneration } });
        try { await lease.guard(); await materialize(storeId, sessionId, config, lease); }
        catch (error) { await Configuration.updateOne({ storeId }, { $inc: { failures: 1 }, $set: { lastFailureAt: new Date() } }); }
      }
      return { sessions: pending.length, deletions: deletions.length };
    });
  } finally { running = false; }
}
function startWorker() {
  if (timer || process.env.NODE_ENV === 'test') return stopWorker;
  tick().catch(() => {});
  timer = setInterval(() => tick().catch(() => {}), 15000); timer.unref();
  return stopWorker;
}
function stopWorker() { if (timer) clearInterval(timer); timer = null; }
async function ensureIndexes() { await Promise.all([Configuration, Visitor, Event, Session, Slice, Bucket, Lease, Digest, AnalyticsEvent].map(Model => Model.createIndexes())); }
module.exports = { tick, materialize, eraseVisitor, rebuildBucket, withLease, startWorker, stopWorker, ensureIndexes };
