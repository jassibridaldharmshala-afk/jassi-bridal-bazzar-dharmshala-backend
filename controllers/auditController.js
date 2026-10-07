const AuditLog = require('../models/AuditLog');
const { asyncHandler } = require('../middleware/validate');
const { ApiError, forbidden } = require('../utils/apiError');
const { buildAuditQuery, scopeFor, auditView, objectId } = require('../services/auditQuery');
const { hasAuditWriteFailures, logAudit } = require('../services/auditService');
const { isPrivateAudit } = require('../utils/auditData');

const canDelete = (req) => !String(req.baseUrl || '').toLowerCase().startsWith('/api/seller')
  && req.user?.role === 'admin' && req.user?.activeMode === 'admin';
const missingEvent = () => new ApiError('AUDIT_EVENT_NOT_FOUND', 'Audit event not found or no longer accessible', { statusCode: 404 });

exports.list = asyncHandler(async (req, res) => {
  const { filter, page, limit, skip, asOf } = buildAuditQuery(req);
  const [records, total] = await Promise.all([
    AuditLog.find(filter).select('-before -after -ip -http').populate('actor', 'name')
      .sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).maxTimeMS(5000).lean(),
    AuditLog.countDocuments(filter).maxTimeMS(5000),
  ]);
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    items: records.map((record) => auditView(record)), page, limit, total,
    totalPages: Math.max(1, Math.ceil(total / limit)), asOf,
    recordingWarning: !String(req.baseUrl || '').toLowerCase().startsWith('/api/seller') && hasAuditWriteFailures()
      ? 'Some events could not be saved since this server started. Ask the server owner to check AUDIT_WRITE_FAILED in server logs. This history may be incomplete.' : '',
  });
});

exports.options = asyncHandler(async (req, res) => {
  const filter = scopeFor(req);
  // Bounded result sets and query deadlines; no entire history sent to browser.
  const read = (field) => AuditLog.aggregate([
    { $match: filter }, { $group: { _id: '$' + field } }, { $sort: { _id: 1 } }, { $limit: 200 },
  ]).option({ maxTimeMS: 5000 });
  const [actions, entities] = await Promise.all([read('action'), read('entityType')]);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ actions: actions.map((row) => row._id).filter(Boolean), entityTypes: entities.map((row) => row._id).filter(Boolean) });
});

exports.get = asyncHandler(async (req, res) => {
  const filter = { $and: [scopeFor(req), { _id: objectId(String(req.params.id || ''), 'event id') }] };
  const record = await AuditLog.findOne(filter).populate('actor', 'name').maxTimeMS(5000).lean();
  if (!record) throw missingEvent();
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ...auditView(record, true), canDelete: canDelete(req) });
});

exports.remove = asyncHandler(async (req, res) => {
  if (!canDelete(req)) throw forbidden('Only admins in admin mode can delete audit events');
  // A single atomic claim, with the same store and owner visibility as reads.
  const filter = { $and: [scopeFor(req), { _id: objectId(String(req.params.id || ''), 'event id') }] };
  const record = await AuditLog.findOneAndDelete(filter)
    .select('_id storeId action entityType visibility').maxTimeMS(5000).lean();
  if (!record) throw missingEvent();
  // Preserve who removed the event without copying its original snapshots.
  // Deleting owner-only history must not expose its reference to other admins.
  await logAudit({
    req, action: record.visibility === 'OWNER' || isPrivateAudit(record) ? 'MASTER_AUDIT_LOG_DELETE' : 'AUDIT_LOG_DELETE',
    entityType: 'AuditLog', entityId: record._id, storeId: record.storeId,
    summary: 'Audit event deleted',
  });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, id: String(record._id) });
});
