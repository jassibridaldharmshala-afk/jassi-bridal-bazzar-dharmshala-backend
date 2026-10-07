const router = require('express').Router();
const product = require('../controllers/productController');

router.get('/', product.getProducts);
router.get('/:slug/complete-look', require('../controllers/storefrontDiscoveryController').completeLook);
router.get('/:slug', product.getProductBySlug);

module.exports = router;
