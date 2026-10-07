const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { protect } = require('../../middleware/authMiddleware');
const { adminOnly } = require('../../middleware/adminMiddleware');
const controller = require('./socialImport.controller');
const importLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 15, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: (req) => String(req.user._id), message: { message: 'Too many imports. Please wait before trying again.' } });
router.use(protect, adminOnly);
router.get('/capabilities', controller.capabilities);
router.get('/', controller.list);
router.post('/', importLimit, controller.create);
router.get('/:id', controller.get);
router.post('/:id/retry', importLimit, controller.retry);
router.post('/:id/cancel', controller.cancel);
router.post('/:id/draft', controller.createDraft);
router.post('/:id/review', controller.saveReview);
router.post('/:id/publish', controller.publishReview);
module.exports = router;
