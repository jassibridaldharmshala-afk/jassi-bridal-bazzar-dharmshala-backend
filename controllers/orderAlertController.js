const service = require('../services/orderAlertService');
const { asyncHandler } = require('../middleware/validate');
const { requireObjectId } = require('../utils/validators');
const { ApiError } = require('../utils/apiError');
const { isMasterOwner } = require('../config/masterOwner');
const { logAudit } = require('../services/auditService');

exports.authorize = (req, _res, next) => {
  const deploymentAdmin = req.store?.isDefault && req.user?.role === 'admin' && req.user?.activeMode === 'admin';
  const owner = req.storeMember?.role === 'OWNER' || String(req.store?.owner || '') === String(req.user?._id || '');
  if (!req.store?._id || !req.user?.isPhoneVerified || req.user?.offlineSession || !(deploymentAdmin || owner || isMasterOwner(req.user))) {
    return next(new ApiError('FORBIDDEN', 'Only the verified store owner or deployment administrator can manage external order alerts.'));
  }
  return next();
};
const respond = (res, data) => res.set('Cache-Control', 'private, no-store').json(data);
exports.read = asyncHandler(async (req, res) => respond(res, await service.read(req.store._id)));
exports.save = asyncHandler(async (req, res) => {
  const data = await service.save(req.store._id, req.body || {}, req.user._id);
  await logAudit({ req, action: 'ORDER_ALERT_SETTINGS_UPDATED', entityType: 'OrderAlertConfiguration', entityId: req.store._id, storeId: req.store._id,
    after: { emailEnabled: data.email.enabled, whatsappEnabled: data.whatsapp.enabled, revision: data.revision } });
  respond(res, data);
});
exports.test = asyncHandler(async (req, res) => {
  const data = await service.sendTest(req.store._id, req.body?.channel);
  await logAudit({ req, action: 'ORDER_ALERT_TEST', entityType: 'OrderAlertConfiguration', entityId: req.store._id, storeId: req.store._id, after: { channel: req.body?.channel } });
  respond(res, data);
});
exports.retry = asyncHandler(async (req, res) => {
  requireObjectId(req.params.id, 'alert id');
  const data = await service.retry(req.store._id, req.params.id, req.body?.confirmUncertain);
  await logAudit({ req, action: 'ORDER_ALERT_RETRY', entityType: 'OrderAlertDelivery', entityId: req.params.id, storeId: req.store._id });
  respond(res, data);
});
