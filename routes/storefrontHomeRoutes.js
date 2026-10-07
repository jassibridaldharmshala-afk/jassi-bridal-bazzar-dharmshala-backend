const router = require('express').Router();
const controller = require('../controllers/storefrontHomeController');

router.get('/', controller.getMobileHome);
router.get('/discovery', require('../controllers/storefrontDiscoveryController').discovery);

module.exports = router;
