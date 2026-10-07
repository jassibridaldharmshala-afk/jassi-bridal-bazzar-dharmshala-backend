const { asyncHandler } = require('../middleware/validate');
const { ApiError } = require('../utils/apiError');
const { logAudit } = require('../services/auditService');
const { Configuration, Visitor, Event, Session, Slice, Bucket } = require('../models/TrafficAnalytics');
const AnalyticsEvent = require('../models/AnalyticsEvent');
const { configuration, publicConfiguration, saveConfiguration } = require('../services/trafficConfigurationService');
const { ID, BOT, DAY, normalizeEvent, hashToken, tokenMatches } = require('../services/trafficAlgorithms');

exports.config = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(publicConfiguration(await configuration(req.store), req.store));
});

exports.collect = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (req.app.locals.trafficIndexesReady === false) throw new ApiError('SERVICE_UNAVAILABLE', 'Traffic analytics is initializing. Shopping is unaffected.');
  const config = await configuration(req.store);
  const ignored = reason => res.status(202).json({ success: true, accepted: 0, ignored: true, reason });
  if (!config.enabled) return ignored('disabled');
  if (BOT.test(req.headers['user-agent'] || '')) return ignored('excluded');
  if (config.consentRequired && req.body?.consent !== true) return ignored('consent_required');
  if (req.body?.privacyGeneration !== config.privacyGeneration) return ignored('settings_changed');
  if (config.excludeLocalhost && req.headers.origin) {
    let hostname; try { hostname = new URL(req.headers.origin).hostname; } catch { return ignored('excluded'); }
    if (/^(localhost|127\.|\[?::1\]?)/.test(hostname)) return ignored('excluded');
  }
  const input = req.body?.events;
  if (!Array.isArray(input) || !input.length || input.length > 20 || Buffer.byteLength(JSON.stringify(req.body)) > 32000) throw new ApiError('VALIDATION_ERROR', 'Use a small analytics batch of 1–20 events.');
  if (!ID.test(req.body.deletionToken || '')) throw new ApiError('VALIDATION_ERROR', 'Invalid analytics privacy token.');
  const now = new Date();
  const events = input.map(event => normalizeEvent(event, config, now)).filter(Boolean);
  if (!events.length) return ignored('excluded');
  await Promise.all(events.filter(event => event.name === 'SEARCH').map(async event => { event.searchQuery = await require('../services/trafficSearchPrivacyService').searchTopic(event.searchQuery, req.store); }));
  const visitorId = events[0].visitorId;
  if (events.some(event => event.visitorId !== visitorId)) throw new ApiError('VALIDATION_ERROR', 'A batch must contain one visitor.');
  const storeId = req.store._id;
  let visitor = await Visitor.findOne({ storeId, visitorId }).select('+deletionHash').lean();
  if (visitor?.disabled) return ignored('withdrawn');
  if (visitor && !tokenMatches(req.body.deletionToken, visitor.deletionHash)) throw new ApiError('FORBIDDEN', 'Invalid analytics privacy token.');
  if (!visitor) {
    visitor = await Visitor.findOneAndUpdate({ storeId, visitorId }, { $setOnInsert: { storeId, visitorId, privacyGeneration: config.privacyGeneration, deletionHash: hashToken(req.body.deletionToken), firstSeenAt: events.reduce((min, event) => event.occurredAt < min ? event.occurredAt : min, now), lastSeenAt: now, expiresAt: new Date(+now + config.summaryRetentionDays * DAY), firstSource: events[0].firstSource || events[0].source } }, { upsert: true, new: true }).select('+deletionHash').lean().catch(async error => {
      if (error.code === 11000) return Visitor.findOne({ storeId, visitorId }).select('+deletionHash').lean(); throw error;
    });
    if (visitor?.disabled || !tokenMatches(req.body.deletionToken, visitor?.deletionHash)) return ignored('withdrawn');
  }
  // Prevent a forged session ID from joining another anonymous visitor.
  const sessionIds = [...new Set(events.map(event => event.sessionId))];
  await Session.bulkWrite(sessionIds.map(sessionId => ({ updateOne: { filter: { storeId, sessionId }, update: { $setOnInsert: { storeId, sessionId, visitorId, startedAt: events.filter(event => event.sessionId === sessionId).reduce((min, event) => event.occurredAt < min ? event.occurredAt : min, now), expiresAt: new Date(+now + config.summaryRetentionDays * DAY) } }, upsert: true } })), { ordered: false }).catch(error => { if (error.code !== 11000) throw error; });
  const sessions = await Session.find({ storeId, sessionId: { $in: [...new Set(events.map(event => event.sessionId))] } }).select('sessionId visitorId').lean();
  if (sessions.length !== sessionIds.length) throw new ApiError('SERVICE_UNAVAILABLE', 'Analytics session ownership is not ready. Retry this batch.');
  if (sessions.some(session => session.visitorId !== visitorId)) throw new ApiError('VALIDATION_ERROR', 'Session identity does not match.');
  const pendingConflict = await Event.exists({ storeId, sessionId: { $in: events.map(event => event.sessionId) }, visitorId: { $ne: visitorId } });
  if (pendingConflict) throw new ApiError('VALIDATION_ERROR', 'Session identity does not match.');
  try {
    const result = await Event.bulkWrite(events.map(event => ({ updateOne: { filter: { storeId, eventId: event.eventId }, update: { $setOnInsert: { ...event, storeId, privacyGeneration: config.privacyGeneration } }, upsert: true } })), { ordered: false });
    await Visitor.updateOne({ storeId, visitorId, disabled: false }, { $min: { firstSeenAt: events.reduce((min, event) => event.occurredAt < min ? event.occurredAt : min, visitor.firstSeenAt) }, $max: { lastSeenAt: now }, $set: { expiresAt: new Date(+now + config.summaryRetentionDays * DAY) } });
    await Configuration.updateOne({ storeId }, { $max: { lastCollectedAt: now }, $min: { collectionStartedAt: now }, $setOnInsert: { storeId, timezone: config.timezone } }, { upsert: true });
    const current = await Configuration.findOne({ storeId }).select('privacyGeneration').lean();
    if (current.privacyGeneration !== config.privacyGeneration) {
      await Event.deleteMany({ storeId, privacyGeneration: config.privacyGeneration });
      await Visitor.deleteMany({ storeId, privacyGeneration: config.privacyGeneration });
      return ignored('settings_changed');
    }
    return res.status(202).json({ success: true, accepted: result.upsertedCount, duplicate: events.length - result.upsertedCount });
  } catch (error) {
    // The browser keeps its bounded batch and can retry after a DB outage.
    await Configuration.updateOne({ storeId }, { $inc: { failures: 1 }, $set: { lastFailureAt: now } }).catch(() => {});
    throw new ApiError('SERVICE_UNAVAILABLE', 'Analytics collection is temporarily unavailable.');
  }
});

exports.forget = asyncHandler(async (req, res) => {
  const { visitorId, deletionToken } = req.body || {};
  if (!ID.test(visitorId || '') || !ID.test(deletionToken || '')) throw new ApiError('VALIDATION_ERROR', 'Invalid analytics privacy request.');
  let visitor = await Visitor.findOne({ storeId: req.store._id, visitorId }).select('+deletionHash').lean();
  if (!visitor) visitor = await Visitor.findOneAndUpdate({ storeId: req.store._id, visitorId }, { $setOnInsert: { storeId: req.store._id, visitorId, deletionHash: hashToken(deletionToken), disabled: true, deletionPending: true, expiresAt: new Date(Date.now() + 2 * DAY) } }, { upsert: true, new: true }).select('+deletionHash').lean().catch(async error => { if (error.code === 11000) return Visitor.findOne({ storeId: req.store._id, visitorId }).select('+deletionHash').lean(); throw error; });
  if (visitor && !tokenMatches(deletionToken, visitor.deletionHash)) throw new ApiError('FORBIDDEN', 'Invalid analytics privacy token.');
  if (visitor) await Visitor.updateOne({ _id: visitor._id }, { $set: { disabled: true, deletionPending: true, expiresAt: new Date(Date.now() + 2 * DAY) } });
  require('../services/trafficReportingService').invalidateTrafficCache(req.store._id);
  res.set('Cache-Control', 'no-store');
  res.status(202).json({ success: true, deletionQueued: Boolean(visitor) });
});

exports.readSettings = asyncHandler(async (req, res) => {
  const digest = require('../services/trafficDigestService');
  const deliveries = await require('../models/TrafficAnalytics').Digest.find({ storeId: req.store._id }).select('-leaseToken -actorId').sort('-createdAt').limit(20).lean();
  res.set('Cache-Control', 'private, no-store'); res.json({ ...await configuration(req.store), whatsappProvider: await digest.readiness(req.store._id), digestDeliveries: deliveries });
});
exports.saveSettings = asyncHandler(async (req, res) => {
  if (req.body?.whatsappDigest?.enabled && req.storeMember && (!require('../models/StoreMember').roleAllows(req.storeMember.role, 'reports.manage') || !require('../models/StoreMember').roleAllows(req.storeMember.role, 'reports.export'))) throw new ApiError('FORBIDDEN', 'Digest scheduling requires report-management/export permission.');
  const result = await saveConfiguration(req.store, req.body || {}, req.user._id);
  require('../services/trafficReportingService').invalidateTrafficCache(req.store._id);
  await logAudit({ req, action: 'TRAFFIC_SETTINGS_UPDATE', entityType: 'TrafficConfiguration', entityId: result._id, storeId: req.store._id, after: { enabled: result.enabled, consentRequired: result.consentRequired, revision: result.revision, rawRetentionDays: result.rawRetentionDays, summaryRetentionDays: result.summaryRetentionDays } });
  res.set('Cache-Control', 'private, no-store'); res.json({ ...result, whatsappProvider: await require('../services/trafficDigestService').readiness(req.store._id) });
});
exports.retryDigest = asyncHandler(async (req, res) => {
  if (req.storeMember && (!require('../models/StoreMember').roleAllows(req.storeMember.role, 'reports.manage') || !require('../models/StoreMember').roleAllows(req.storeMember.role, 'reports.export'))) throw new ApiError('FORBIDDEN', 'Digest retry requires report-management/export permission.');
  if (!require('mongoose').isValidObjectId(req.params.id)) throw new ApiError('VALIDATION_ERROR', 'Invalid digest ID.');
  await require('../services/trafficDigestService').retry(req.store._id, req.params.id, req.body?.confirmUncertain);
  await logAudit({ req, action: 'TRAFFIC_DIGEST_RETRY', entityType: 'TrafficDigestDelivery', entityId: req.params.id, storeId: req.store._id });
  res.status(202).json({ success: true });
});
exports.clearHistory = asyncHandler(async (req, res) => {
  if (req.body?.confirmation !== 'DELETE ANALYTICS') throw new ApiError('VALIDATION_ERROR', 'Type DELETE ANALYTICS to permanently remove this store’s analytics.');
  const storeId = req.store._id;
  // Fence in-flight old browser batches before deleting only this tenant's data.
  const cleared = await require('../services/trafficWorker').withLease(async () => {
    await Configuration.updateOne({ storeId }, { $inc: { privacyGeneration: 1, revision: 1 }, $unset: { collectionStartedAt: 1, lastCollectedAt: 1, lastProcessedAt: 1 } }, { upsert: true });
    await Promise.all([Event, Session, Slice, Bucket, Visitor].map(Model => Model.deleteMany({ storeId })));
    await AnalyticsEvent.deleteMany({ storeId, trafficEventId: { $exists: true } });
    await require('../models/Order').updateMany({ storeId, 'traffic.visitorId': { $exists: true } }, { $unset: { traffic: 1, attribution: 1 } });
    return true;
  });
  if (!cleared) throw new ApiError('CONFLICT', 'Analytics is processing a batch. Try again shortly.', { statusCode: 409 });
  require('../services/trafficReportingService').invalidateTrafficCache(storeId);
  await logAudit({ req, action: 'TRAFFIC_HISTORY_DELETE', entityType: 'TrafficConfiguration', entityId: storeId, storeId, after: { confirmed: true } });
  res.json({ success: true });
});
