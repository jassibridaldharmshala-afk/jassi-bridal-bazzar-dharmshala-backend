const router = require('express').Router();
const seo = require('../controllers/seoController');
const { optionalResolveStore } = require('../middleware/storeMiddleware');

router.get('/robots.txt', optionalResolveStore, seo.robots);
router.get('/sitemap.xml', optionalResolveStore, seo.sitemap);
router.get('/share/product/:slug', optionalResolveStore, seo.productShare);

module.exports = router;
