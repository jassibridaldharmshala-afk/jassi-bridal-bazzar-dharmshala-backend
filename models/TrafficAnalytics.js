const mongoose = require('mongoose');

const scope = { storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', required: true } };
const identity = { ...scope, visitorId: { type: String, required: true, maxlength: 80 }, sessionId: { type: String, required: true, maxlength: 80 } };
const dimensions = { source: String, medium: String, campaign: String, firstSource: String, device: String, browser: String, os: String };
function model(name, fields, indexes = []) {
  const schema = new mongoose.Schema(fields, { timestamps: true });
  indexes.forEach(([keys, options]) => schema.index(keys, options || {}));
  if (fields.expiresAt) schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  return mongoose.model(name, schema);
}

const Configuration = model('TrafficConfiguration', {
  ...scope, enabled: { type: Boolean, default: true }, consentRequired: { type: Boolean, default: true },
  timezone: { type: String, default: 'Asia/Kolkata' }, sessionTimeoutMinutes: { type: Number, default: 30 },
  rawRetentionDays: { type: Number, default: 90 }, summaryRetentionDays: { type: Number, default: 365 },
  attributionDays: { type: Number, default: 7 }, excludedPaths: { type: [String], default: [] },
  excludedReferrers: { type: [String], default: [] }, excludeLocalhost: { type: Boolean, default: true },
  ga4MeasurementId: { type: String, default: '' }, ga4Enabled: { type: Boolean, default: false },
  revision: { type: Number, default: 1 }, collectionStartedAt: Date, lastCollectedAt: Date,
  lastProcessedAt: Date, lastFailureAt: Date, failures: { type: Number, default: 0 },
  privacyGeneration: { type: Number, default: 1 },
  whatsappDigest: {
    enabled: { type: Boolean, default: false }, frequency: { type: String, enum: ['DAILY', 'WEEKLY'], default: 'DAILY' },
    recipient: String, consent: { type: Boolean, default: false }, templateName: String,
    language: { type: String, default: 'en' }, actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, nextRunAt: Date,
  },
}, [[{ storeId: 1 }, { unique: true }]]);

const Visitor = model('TrafficVisitor', {
  ...scope, visitorId: { type: String, required: true }, deletionHash: { type: String, required: true, select: false },
  firstSeenAt: Date, lastSeenAt: Date, firstSource: String, disabled: { type: Boolean, default: false },
  deletionPending: { type: Boolean, default: false }, privacyGeneration: Number, expiresAt: Date,
}, [[{ storeId: 1, visitorId: 1 }, { unique: true }], [{ deletionPending: 1 }]]);

const Event = model('TrafficEvent', {
  ...identity, ...dimensions, eventId: { type: String, required: true, maxlength: 80 },
  name: { type: String, required: true }, occurredAt: { type: Date, required: true }, receivedAt: Date,
  path: String, referrer: String, searchQuery: String, productId: mongoose.Schema.Types.ObjectId,
  categoryId: String, engagementMs: { type: Number, default: 0 }, processedAt: Date,
  metadata: mongoose.Schema.Types.Mixed,
  schemaVersion: { type: Number, default: 1 }, privacyGeneration: Number, expiresAt: Date,
}, [[{ storeId: 1, eventId: 1 }, { unique: true }], [{ processedAt: 1, receivedAt: 1 }],
  [{ storeId: 1, sessionId: 1, occurredAt: 1 }], [{ storeId: 1, sessionId: 1, name: 1, occurredAt: 1 }], [{ storeId: 1, occurredAt: 1, name: 1 }], [{ storeId: 1, visitorId: 1 }]]);

const Session = model('TrafficSession', {
  ...identity, ...dimensions, firstSeenAt: Date, startedAt: Date, lastActivityAt: Date,
  materializationVersion: { type: Number, default: 0 },
  landingPage: String, lastPage: String, pageViews: Number, engagementMs: Number,
  productAt: Date, cartAt: Date, checkoutAt: Date, expiresAt: Date,
}, [[{ storeId: 1, sessionId: 1 }, { unique: true }], [{ storeId: 1, startedAt: 1 }],
  [{ storeId: 1, lastActivityAt: -1 }], [{ storeId: 1, visitorId: 1 }]]);

// Compact per-visitor/session/hour facts preserve exact distinct range counts
// after raw events expire. Daily distinct counts must never be added together.
const Slice = model('TrafficSlice', {
  ...identity, ...dimensions, hour: Date, firstActivityAt: Date, lastActivityAt: Date,
  materializationVersion: { type: Number, default: 0 },
  firstSeenAt: Date, pageViews: Number, engagementMs: Number, expiresAt: Date,
}, [[{ storeId: 1, sessionId: 1, hour: 1 }, { unique: true }], [{ storeId: 1, hour: 1 }], [{ storeId: 1, visitorId: 1 }]]);

const Bucket = model('TrafficBucket', {
  ...scope, hour: Date, visitors: Number, sessions: Number, pageViews: Number, engagementMs: Number, expiresAt: Date,
  materializationVersion: { type: Number, default: 0 },
}, [[{ storeId: 1, hour: 1 }, { unique: true }]]);
const Lease = model('TrafficLease', { _id: String, owner: String, lockedUntil: Date, generation: { type: Number, default: 0 } });
const Digest = model('TrafficDigestDelivery', {
  ...scope, periodFrom: String, periodTo: String, frequency: String, actorId: mongoose.Schema.Types.ObjectId,
  status: { type: String, enum: ['PENDING', 'SENDING', 'ACCEPTED', 'FAILED', 'UNCERTAIN', 'SKIPPED'], default: 'PENDING' },
  attempts: { type: Number, default: 0 }, nextAttemptAt: Date, leaseUntil: Date, leaseToken: String,
  reason: String, acceptedAt: Date, expiresAt: Date,
}, [[{ storeId: 1, periodTo: 1, frequency: 1 }, { unique: true }], [{ status: 1, nextAttemptAt: 1 }]]);

module.exports = { Configuration, Visitor, Event, Session, Slice, Bucket, Lease, Digest };
