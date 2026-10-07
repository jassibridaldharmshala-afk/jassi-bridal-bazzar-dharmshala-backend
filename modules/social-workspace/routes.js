const express = require('express');
const mongoose = require('mongoose');
const { protect } = require('../../middleware/authMiddleware');
const { requireStoreMember } = require('../../middleware/storeMiddleware');
const { ensureDefaultStore } = require('../../services/storeService');
const StoreMember = require('../../models/StoreMember');
const { Connection, Thread } = require('./models');
const meta = require('./meta');
const oauth = require('./oauth');
const inbox = require('./inbox');
const publishing = require('./publishing');
const assistant = require('./assistant');
const insights = require('./insights');
const { getStorageProvider } = require('../../services/mediaStorage.service');
const { rateLimit } = require('express-rate-limit');
const { logAudit } = require('../../services/auditService');
const { wrap } = oauth;
const router = express.Router();
router.use(protect);
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (req.user.role === 'admin' && req.user.activeMode === 'admin') {
    return ensureDefaultStore().then(store => { req.socialStore = store; req.socialWorkspace = 'admin'; req.socialAllows = () => true; next(); }).catch(next);
  }
  if (req.user.activeMode !== 'seller') return res.status(403).json({ message: 'Open the admin or seller workspace to manage social accounts.' });
  return requireStoreMember(req, res, error => { if (error) return next(error); req.socialStore = req.store; req.socialWorkspace = 'seller'; req.socialAllows = permission => StoreMember.roleAllows(req.storeMember.role, permission); next(); });
});
const allow = (...permissions) => (req, res, next) => permissions.some(p => req.socialAllows(p)) ? next() : res.status(403).json({ message: 'Your store role does not have access to this action.' });
const writes = rateLimit({ windowMs: 60000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false, keyGenerator: req => String(req.user._id), message: { message: 'Too many social actions. Please wait a minute.' } });
router.use((req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) res.once('finish', () => {
    logAudit({ req, storeId: req.socialStore._id, action: 'SOCIAL_WORKSPACE_REQUEST', entityType: 'SocialWorkspace', entityId: req.params.id,
      summary: `${req.method} social workspace ${String(req.route?.path || '').replace(/:[\w]+/g, 'record')} request`,
      outcome: res.statusCode >= 500 ? 'FAILED' : res.statusCode >= 400 ? 'REJECTED' : 'SUCCESS' });
  });
  next();
});
router.param('id', (req, res, next, id) => mongoose.isValidObjectId(id) ? next() : res.status(400).json({ message: 'Invalid record identifier.' }));
router.get('/status', allow('inbox.read', 'marketing.read', 'instagram.read'), wrap(async (req, res) => {
  const c = meta.config();
  const facebookMissing = [['META_APP_ID', c.appId], ['META_APP_SECRET', c.secret], ['META_REDIRECT_URI', c.callback], ['META_WEBHOOK_VERIFY_TOKEN', c.verifyToken]].filter(([, value]) => !value).map(([key]) => key);
  const instagramMissing = [['INSTAGRAM_BUSINESS_APP_ID', c.instagramAppId], ['INSTAGRAM_BUSINESS_APP_SECRET', c.instagramSecret], ['INSTAGRAM_BUSINESS_REDIRECT_URI', c.instagramCallback], ['META_WEBHOOK_VERIFY_TOKEN', c.verifyToken]].filter(([, value]) => !value).map(([key]) => key);
  const missing = facebookMissing.length <= instagramMissing.length ? facebookMissing : instagramMissing;
  const accounts = await Connection.find({ storeId: req.socialStore._id }).sort({ provider: 1, name: 1 }).lean();
  const [memberships, agents, unread, overdue] = await Promise.all([
    req.socialWorkspace === 'seller' ? StoreMember.find({ user: req.user._id, status: 'ACTIVE' }).populate('store', 'name slug').lean() : [],
    StoreMember.find({ store: req.socialStore._id, status: 'ACTIVE' }).populate('user', 'name').lean(),
    Thread.countDocuments({ storeId: req.socialStore._id, $expr: { $gt: ['$lastInboundAt', { $ifNull: ['$readAt', new Date(0)] }] } }),
    Thread.countDocuments({ storeId: req.socialStore._id, resolved: false, lastInboundAt: { $lt: new Date(Date.now() - 3600000) }, $or: [{ snoozedUntil: null }, { snoozedUntil: { $lte: new Date() } }] }),
  ]);
  res.json({ configured: !facebookMissing.length || !instagramMissing.length, missing, workspace: req.socialWorkspace, connectionMethods: { facebook: { configured: !facebookMissing.length, missing: facebookMissing }, instagram: { configured: !instagramMissing.length, missing: instagramMissing } }, mediaStorage: getStorageProvider(), store: { id: req.socialStore._id, name: req.socialStore.name },
    stores: memberships.map(m => ({ id: m.store?._id, name: m.store?.name })).filter(s => s.id),
    permissions: { connect: req.socialAllows('instagram.write'), inbox: req.socialAllows('inbox.read'), reply: req.socialAllows('inbox.write'), publish: req.socialAllows('marketing.write'), catalog: req.socialAllows('catalog.read') || req.socialAllows('inbox.read'), customerContext: req.socialAllows('crm.read'), customerPii: req.socialAllows('crm.pii.read') },
    inbox: { unread, overdue }, agents: [...(req.socialWorkspace === 'admin' ? [{ id: req.user._id, name: req.user.name || 'Store owner', role: 'OWNER' }] : []), ...agents.filter(member => member.user).map(member => ({ id: member.user._id, name: member.user.name || 'Team member', role: member.role }))].filter((agent, index, all) => all.findIndex(item => String(item.id) === String(agent.id)) === index),
    accounts: accounts.map(({ token, facebookUserId, permissions, syncLease, ...a }) => ({ ...a, ...(a.expiresAt && a.expiresAt <= new Date() ? { status: 'expired' } : {}), capabilities: meta.capabilities({ ...a, permissions }) })),
  });
}));
router.post('/connect', writes, allow('instagram.write'), wrap(oauth.start));
router.get('/pending/:id', allow('instagram.write'), wrap(oauth.pending));
router.post('/pending/:id', writes, allow('instagram.write'), wrap(oauth.activate));
router.delete('/accounts/:id', writes, allow('instagram.write'), wrap(oauth.disconnect));
router.post('/accounts/:id/sync', writes, allow('inbox.read'), wrap(inbox.syncAccount));
router.get('/threads', allow('inbox.read'), wrap(inbox.list));
router.get('/threads/:id', allow('inbox.read'), wrap(inbox.detail));
router.post('/threads/:id/read', allow('inbox.read'), wrap(inbox.markRead));
router.patch('/threads/:id', writes, allow('inbox.write'), wrap(inbox.update));
router.post('/threads/:id/notes', writes, allow('inbox.write'), wrap(inbox.addNote));
router.post('/threads/:id/reply-presence', allow('inbox.write'), wrap(inbox.replyPresence));
router.get('/customers', allow('crm.read'), wrap(inbox.searchCustomers));
router.put('/threads/:id/customer', writes, allow('crm.read'), wrap(inbox.linkCustomer));
router.get('/threads/:id/context', allow('crm.read'), wrap(inbox.context));
router.post('/threads/:id/history', writes, allow('inbox.read'), wrap(inbox.older));
router.post('/threads/:id/reply', writes, allow('inbox.write'), wrap(inbox.reply));
router.post('/threads/:id/suggest-reply', writes, allow('inbox.write'), wrap(assistant.suggestReply));
router.get('/insights', allow('marketing.read', 'inbox.read'), wrap(insights.overview));
router.get('/products', allow('catalog.read', 'inbox.read', 'marketing.read'), wrap(publishing.products));
router.get('/posts', allow('marketing.read'), wrap(publishing.list));
router.get('/posts/:id', allow('marketing.read'), wrap(publishing.get));
router.post('/posts', writes, allow('marketing.write'), wrap(publishing.saveDraft));
router.put('/posts/:id', writes, allow('marketing.write'), wrap(publishing.saveDraft));
router.post('/posts/:id/video', writes, allow('marketing.write'), wrap(publishing.generate));
router.post('/posts/:id/publish', writes, allow('marketing.write'), wrap(publishing.publish));
router.post('/posts/:id/cancel-schedule', writes, allow('marketing.write'), wrap(publishing.cancelSchedule));
router.post('/posts/:id/retry', writes, allow('marketing.write'), wrap(publishing.retry));
router.post('/posts/:id/suggest-caption', writes, allow('marketing.write'), wrap(assistant.suggestCaption));
router.delete('/posts/:id', writes, allow('marketing.write'), wrap(publishing.remove));
router.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.statusCode || (error.name === 'CastError' || error.name === 'ValidationError' ? 400 : error.code === 11000 || error.name === 'VersionError' ? 409 : 500);
  res.status(status).json({ message: status >= 500 ? 'Social studio could not complete this request. Please try again.' : error.name === 'CastError' ? 'Invalid record identifier.' : error.code === 11000 || error.name === 'VersionError' ? 'This record changed. Refresh before trying again.' : error.message, code: error.code === 'REPLY_WINDOW_CLOSED' ? error.code : 'SOCIAL_ERROR' });
});
module.exports = router;
