const router = require('express').Router();
const controller = require('../controllers/businessController');

router.get('/overview', controller.overview);
router.get('/abandoned-carts', controller.abandonedCarts);
router.post('/abandoned-carts/:id/reminder', controller.remindAbandonedCart);
router.post('/assistant', controller.assistant);
router.post('/customer-offers', controller.customerOffer);
router.put('/festival', controller.updateFestival);

module.exports = router;
