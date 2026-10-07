const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { asyncHandler } = require('../middleware/validate');
const { requireStorePermission, requireStoreFeature, requireActiveStoreLicenseForWrites } = require('../middleware/storeMiddleware');
const { hasStoreFeature } = require('../config/storePlans');
const { ApiError } = require('../utils/apiError');
const { WORKFLOWS } = require('../services/workflowSmartFillAlgorithms');
const service = require('../services/workflowSmartFillService');
const Store = require('../models/Store');
const StoreMember = require('../models/StoreMember');
const { isMasterOwner } = require('../config/masterOwner');
const makeLimiter = max => rateLimit({ windowMs: 60000, max, keyGenerator: req => String(req.user._id), standardHeaders: true, legacyHeaders: false, message: { success: false, code: 'SMART_FILL_RATE_LIMIT', message: 'Too many Smart Fill actions. Wait one minute before trying again; your drafts are unchanged.' } });
const limiter = makeLimiter(30), saveLimiter = makeLimiter(120);
router.use(asyncHandler(async (req, _res, next) => {
  const storeId = req.query.storeId;
  if (storeId !== undefined) {
    if (typeof storeId !== 'string' || !/^[a-f0-9]{24}$/i.test(storeId)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid store.');
    if (req.storeMember && String(req.store._id) !== storeId) throw new ApiError('FORBIDDEN', 'This store is not your active workspace.');
    const store = await Store.findById(storeId);
    if (!store) throw new ApiError('NOT_FOUND', 'Store not found.');
    if (!isMasterOwner(req.user) && !(store.isDefault && req.user.role === 'admin' && req.user.activeMode === 'admin')) {
      const membership = await StoreMember.findOne({ store: storeId, user: req.user._id, status: 'ACTIVE' });
      if (!membership) throw new ApiError('FORBIDDEN', 'Store membership is required.');
      req.storeMember = membership;
    }
    req.store = store;
  }
  next();
}));
router.use(requireActiveStoreLicenseForWrites);
function authorize(req, res, next) {
  if (!req.user?.isPhoneVerified || req.user.offlineSession || !req.store?._id) return next(new ApiError('FORBIDDEN', 'A verified store administrator is required.'));
  const workflow = req.path === '/catalog/save' ? 'catalog' : req.body?.workflow;
  if (typeof workflow !== 'string' || !Object.hasOwn(WORKFLOWS, workflow)) return next(new ApiError('VALIDATION_ERROR', 'Choose a supported Smart Fill workflow.'));
  if (req.body?.document && req.platformLicense?.managed && !req.platformLicense.features?.includes('aiProduct')) return next(new ApiError('PLAN_FEATURE_REQUIRED', 'Document AI is not included in the current plan. Pasted text still works.'));
  if (isMasterOwner(req.user)) return next();
  if (req.storeMember) return requireStorePermission(WORKFLOWS[workflow])(req, res, error => {
    if (error) return next(error);
    const finish = () => req.body?.document ? requireStoreFeature('aiProduct')(req, res, next) : next();
    const extras = workflow === 'purchase' ? ['inventory.cost.read'] : workflow === 'returns' ? ['orders.read'] : workflow === 'support' && req.body?.context?.threadId !== undefined ? ['inbox.read', 'crm.read'] : [];
    const check = index => index >= extras.length ? finish() : requireStorePermission(extras[index])(req, res, extraError => extraError ? next(extraError) : check(index + 1));
    return check(0);
  });
  if (!req.store.isDefault || req.user.role !== 'admin' || req.user.activeMode !== 'admin') return next(new ApiError('FORBIDDEN', 'You cannot use Smart Fill for this store.'));
  return next();
}
router.get('/status', (req, res) => res.set('Cache-Control', 'private, no-store').json({ algorithm: true, documentExtraction: Boolean(process.env.GEMINI_API_KEY?.trim()) && (!req.storeMember || isMasterOwner(req.user) || hasStoreFeature(req.store, 'aiProduct')) && (!req.platformLicense?.managed || req.platformLicense.features?.includes('aiProduct')), maxDocumentBytes: 512 * 1024, maxCatalogProducts: 20 }));
const activePreviews = new Set();
router.post('/preview', limiter, authorize, asyncHandler(async (req, res) => {
  const key = `${req.store._id}:${req.user._id}`;
  if (activePreviews.has(key)) throw new ApiError('DUPLICATE_REQUEST', 'Another Smart Fill preview is running. Wait for it to finish.');
  activePreviews.add(key);
  const controller = new AbortController();
  const cancel = () => { if (!res.writableEnded) controller.abort(); }; res.on('close', cancel);
  try { const result = await service.preview(req, controller.signal); if (!controller.signal.aborted) res.set('Cache-Control', 'private, no-store').json(result); }
  catch (error) { if (!controller.signal.aborted) throw error; }
  finally { activePreviews.delete(key); res.off('close', cancel); }
}));
router.post('/catalog/preview', limiter, authorize, asyncHandler(async (req, res) => res.set('Cache-Control', 'private, no-store').json(await service.catalogPreview(req))));
router.post('/catalog/save', saveLimiter, authorize, asyncHandler(async (req, res) => res.set('Cache-Control', 'private, no-store').json(await service.saveCatalogContent(req))));
module.exports = router;
