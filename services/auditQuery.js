const { isMasterOwner } = require('../config/masterOwner');
const { ApiError } = require('../utils/apiError');
const { PRIVATE_ACTION, PRIVATE_ENTITIES, sanitizeAudit, safeText, changedFields } = require('../utils/auditData');

const OUTCOMES = ['SUCCESS', 'REJECTED', 'FAILED', 'LEGACY'];
const SOURCES = ['ADMIN', 'SELLER', 'CUSTOMER', 'WEBHOOK', 'SYSTEM', 'LEGACY'];
function textParam(query, name, max = 100) {
  const value = query?.[name];
  if (value == null || value === '') return '';
  if (typeof value !== 'string' || value.length > max) throw new ApiError('VALIDATION_ERROR', `Invalid ${name} filter`);
  return value.trim();
}
function objectId(value, name) {
  if (!/^[a-f\d]{24}$/i.test(value)) throw new ApiError('VALIDATION_ERROR', `Invalid ${name}`);
  return value;
}
function timestamp(value, name) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new ApiError('VALIDATION_ERROR', `Invalid ${name} date`);
  }
  return new Date(value);
}
function scopeFor(req) {
  const seller = String(req.baseUrl || '').toLowerCase().startsWith('/api/seller');
  if (seller && (!req.store?._id || !req.storeMember)) throw new ApiError('FORBIDDEN', 'Store membership required');
  if (!seller && !(req.user?.role === 'admin' && req.user?.activeMode === 'admin')) throw new ApiError('FORBIDDEN', 'Admin access required');
  const filter = seller ? { storeId: req.store._id } : { ...(req.tenantFilter || {}) };
  // Apply to old records too: they predate the visibility field.
  if (seller || !isMasterOwner(req.user)) {
    filter.visibility = { $ne: 'OWNER' };
    filter.action = { $not: PRIVATE_ACTION };
    filter.entityType = { $nin: PRIVATE_ENTITIES };
  }
  return filter;
}
function buildAuditQuery(req, now = new Date()) {
  const query = req.query || {};
  const filters = [scopeFor(req)];
  for (const name of ['action', 'entityType', 'entityId', 'requestId', 'actor']) {
    const value = textParam(query, name, 120);
    if (value) filters.push({ [name]: name === 'actor' ? objectId(value, 'actor') : value });
  }
  for (const [field, values] of [['outcome', OUTCOMES], ['source', SOURCES]]) {
    const value = textParam(query, field);
    if (!value) continue;
    if (!values.includes(value)) throw new ApiError('VALIDATION_ERROR', `Invalid ${field}`);
    filters.push(value === 'LEGACY' ? { [field]: { $exists: false } } : { [field]: value });
  }
  const q = textParam(query, 'q', 100);
  if (q) {
    const pattern = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filters.push({ $or: ['action', 'entityType', 'entityId', 'requestId', 'actorSnapshot.name', 'summary'].map((field) => ({ [field]: pattern })) });
  }
  const from = textParam(query, 'from');
  const to = textParam(query, 'to');
  const asOf = textParam(query, 'asOf');
  const cutoff = asOf ? timestamp(asOf, 'asOf') : now;
  if (cutoff.getTime() > now.getTime() + 5000) throw new ApiError('VALIDATION_ERROR', 'History snapshot cannot be in the future');
  const range = { $lte: cutoff };
  if (from) range.$gte = timestamp(from, 'from');
  if (to) range.$lte = new Date(Math.min(timestamp(to, 'to').getTime(), cutoff.getTime()));
  if (range.$gte && range.$gte > range.$lte) throw new ApiError('VALIDATION_ERROR', 'Start date must be before end date');
  filters.push({ createdAt: range });
  function positive(name, fallback, max) {
    const raw = textParam(query, name, 6);
    const value = raw === '' ? fallback : Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > max) throw new ApiError('VALIDATION_ERROR', `Invalid ${name}; maximum is ${max}`);
    return value;
  }
  const page = positive('page', 1, 10000);
  const limit = positive('limit', 25, 100);
  return { filter: { $and: filters }, page, limit, skip: (page - 1) * limit, asOf: cutoff.toISOString() };
}

function auditView(record, details = false) {
  const actor = record.actor;
  const snapshot = record.actorSnapshot;
  const value = {
    _id: String(record._id), action: safeText(record.action, 100), entityType: safeText(record.entityType, 80),
    entityId: safeText(record.entityId, 120), summary: safeText(record.summary),
    actor: { _id: actor?._id ? String(actor._id) : undefined,
      name: safeText(snapshot?.name || actor?.name || 'Actor unavailable', 100),
      role: safeText(snapshot?.role || '', 40), kind: snapshot?.kind || 'UNKNOWN' },
    source: record.source || 'LEGACY', outcome: record.outcome || 'LEGACY',
    createdAt: record.createdAt, requestId: safeText(record.requestId, 100),
    changedFields: (record.changedFields || []).slice(0, 80).map((key) => safeText(key, 100)),
  };
  if (details) {
    value.before = sanitizeAudit(record.before);
    value.after = sanitizeAudit(record.after);
    value.changedFields = changedFields(value.before, value.after);
    value.http = sanitizeAudit(record.http);
  }
  return value;
}

module.exports = { buildAuditQuery, scopeFor, auditView, objectId, OUTCOMES, SOURCES };
