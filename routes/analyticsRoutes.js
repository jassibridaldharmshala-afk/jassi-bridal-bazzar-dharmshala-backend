const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const analytics = require('../controllers/analyticsController');
const { optionalProtect } = require('../middleware/authMiddleware');
const { optionalResolveStore } = require('../middleware/storeMiddleware');
const traffic = require('../controllers/trafficController');
const { ipKeyGenerator } = require('express-rate-limit');
const { ID } = require('../services/trafficAlgorithms');
const collectorLimit = rateLimit({ windowMs: 60000, limit: 600, standardHeaders: true, legacyHeaders: false });
const visitorLimit = rateLimit({ windowMs: 60000, limit: 60, standardHeaders: true, legacyHeaders: false, keyGenerator: req => `${ipKeyGenerator(req.ip)}:${ID.test(req.body?.events?.[0]?.visitorId || '') ? req.body.events[0].visitorId : 'unknown'}` });

const limiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });

router.post('/events', limiter, optionalProtect, optionalResolveStore, analytics.track);
router.get('/config', limiter, optionalResolveStore, traffic.config);
router.post('/collect', collectorLimit, visitorLimit, optionalResolveStore, traffic.collect);
router.post('/forget', limiter, optionalResolveStore, traffic.forget);

module.exports = router;
