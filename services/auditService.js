const mongoose = require('mongoose');
const AuditLog = require('../models/AuditLog');
const { log } = require('../utils/logger');
const { sanitizeAudit, safeText, changedFields, isPrivateAudit } = require('../utils/auditData');

let writeFailures = 0;
const validId = (value) => /^[a-f\d]{24}$/i.test(String(value || '')) && mongoose.isValidObjectId(value);

function requestSource(req) {
  if (req?.storeMember) return 'SELLER';
  if (req?.user?.role === 'admin' && req.user.activeMode === 'admin') return 'ADMIN';
  return req?.user ? 'CUSTOMER' : 'SYSTEM';
}

// Awaitable, non-blocking for business operations. Audit storage failures are
// observable, without leaking a database error or invalidating a saved order.
async function logAudit({ req, action, entityType, entityId, before, after, storeId, source, outcome = 'SUCCESS', summary, http, session, strict = false }) {
  if (req) req.auditEventRecorded = true;
  try {
    const actorId = req?.user?._id;
    const resolvedStore = storeId || req?.store?._id;
    if (resolvedStore && !validId(resolvedStore)) throw new Error('Invalid audit store scope');
    const safeBefore = sanitizeAudit(before);
    const safeAfter = sanitizeAudit(after);
    const resolvedSource = source || requestSource(req);
    const path = String(req?.originalUrl || req?.baseUrl || '').split('?')[0];
    const event = {
      storeId: validId(resolvedStore) ? resolvedStore : undefined,
      actor: validId(actorId) ? actorId : undefined,
      actorSnapshot: {
        name: safeText(req?.user?.name || (resolvedSource === 'WEBHOOK' ? 'Payment gateway' : req?.user ? 'Account' : 'System'), 100),
        role: safeText(req?.storeMember?.role || req?.user?.role || '', 40),
        kind: req?.user ? 'USER' : resolvedSource === 'WEBHOOK' ? 'WEBHOOK' : 'SYSTEM',
      },
      action: safeText(action, 100), entityType: safeText(entityType, 80),
      entityId: entityId == null ? undefined : safeText(entityId, 120),
      before: safeBefore, after: safeAfter,
      changedFields: changedFields(safeBefore, safeAfter),
      source: resolvedSource, outcome,
      visibility: isPrivateAudit({ action, entityType, path }) ? 'OWNER' : 'STORE',
      summary: summary ? safeText(summary) : undefined,
      requestId: safeText(req?.requestId, 100) || undefined,
      http: http ? sanitizeAudit(http) : undefined,
      // No IP, request bodies, cookies or headers are retained.
    };
    if (session) return (await AuditLog.create([event], { session }))[0];
    return await AuditLog.create(event);
  } catch (error) {
    writeFailures += 1;
    try {
      log('error', 'Audit event could not be persisted', {
        code: 'AUDIT_WRITE_FAILED', action: safeText(action, 100),
        requestId: safeText(req?.requestId, 100),
      });
    } catch { /* A failed logging transport must not reject a saved order. */ }
    if (strict) throw error;
    return null;
  }
}

const hasAuditWriteFailures = () => writeFailures > 0;
module.exports = { logAudit, requestSource, hasAuditWriteFailures };
