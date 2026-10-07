const service = require('../services/smsConfigurationService');
const { asyncHandler } = require('../middleware/validate');
const { ApiError } = require('../utils/apiError');
const { logAudit } = require('../services/auditService');

exports.authorize = (req, _res, next) => {
  // This backend has one global login system. A seller or a scoped tenant must
  // never change the credentials used by other stores or the deployment owner.
  if (req.user?.role !== 'admin' || req.user.activeMode !== 'admin' || !req.user.isPhoneVerified || req.user.offlineSession || !req.isDefaultStore || req.storeMember) {
    return next(new ApiError('FORBIDDEN', 'Only a verified deployment administrator can manage OTP providers. Store-scoped seller access cannot change global login settings.'));
  }
  return next();
};
const reply = async (req, res) => res.set('Cache-Control', 'private, no-store').json(await service.status(req.user));
exports.read = asyncHandler(reply);
exports.save = asyncHandler(async (req, res) => {
  await service.saveDraft(req.body);
  await logAudit({ req, action: 'SMS_SETTINGS_DRAFT', entityType: 'SmsConfiguration', entityId: 'deployment', summary: 'Saved an inactive OTP provider draft; current delivery unchanged.' });
  await reply(req, res);
});
exports.test = asyncHandler(async (req, res) => {
  await service.sendTest(req.body, req.user);
  await logAudit({ req, action: 'SMS_SETTINGS_TEST', entityType: 'SmsConfiguration', entityId: 'deployment', summary: 'Sent a provider activation test to the verified administrator phone.' });
  await reply(req, res);
});
exports.activate = asyncHandler(async (req, res) => {
  const provider = await service.activate(req.body, req.user);
  await logAudit({ req, action: 'SMS_SETTINGS_ACTIVATE', entityType: 'SmsConfiguration', entityId: 'deployment', after: { provider }, summary: 'Activated OTP provider after confirmation of a real test SMS.' });
  await reply(req, res);
});
exports.discard = asyncHandler(async (req, res) => {
  await service.discardDraft(req.body);
  await logAudit({ req, action: 'SMS_SETTINGS_DISCARD', entityType: 'SmsConfiguration', entityId: 'deployment', summary: 'Discarded an inactive OTP draft; current delivery unchanged.' });
  await reply(req, res);
});
