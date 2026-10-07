const { logAudit } = require('../services/auditService');

// Fallback records HTTP requests, NOT proof of a database mutation.
function auditAdminRequests(req, res, next) {
  const path = String(req.originalUrl || '').split('?')[0];
  const match = path.match(/^\/api\/(admin|seller|master)(?:\/([a-z-]+))?(?:\/|$)/i);
  if (!match || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const area = match[1].toLowerCase();
  const resource = (match[2] || 'workspace').toLowerCase();
  if (['login', 'logout', 'refresh', 'send-otp', 'verify-otp'].includes(resource)) return next();
  res.once('finish', () => {
    if (!req.user || req.auditEventRecorded && res.statusCode < 400) return;
    if (area === 'seller' && !req.store?._id) return;
    const outcome = res.statusCode >= 500 ? 'FAILED' : res.statusCode >= 400 ? 'REJECTED' : 'SUCCESS';
    logAudit({
      req, action: 'ADMIN_REQUEST', entityType: 'AdminRequest',
      entityId: req.params?.id || req.params?.userId || req.params?.jobId,
      source: area === 'seller' ? 'SELLER' : 'ADMIN', outcome,
      summary: `${req.method} ${resource} request ${outcome === 'SUCCESS' ? 'completed' : outcome.toLowerCase()}`,
      http: { method: req.method, route: `/api/${area}/${resource}${typeof req.route?.path === 'string' ? req.route.path : ''}`, statusCode: res.statusCode },
    });
  });
  next();
}
module.exports = { auditAdminRequests };
