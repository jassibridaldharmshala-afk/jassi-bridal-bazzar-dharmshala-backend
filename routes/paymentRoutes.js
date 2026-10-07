const router = require('express').Router();
const { protect } = require('../middleware/authMiddleware');
const paymentController = require('../controllers/paymentController');
const { wrapPaymentHandler } = require('../utils/paymentRouteHandler');

router.use(protect);

router.post('/create-order', wrapPaymentHandler(paymentController.createPaymentOrder));
router.post('/verify', wrapPaymentHandler(paymentController.verifyPayment));
router.post('/failure', wrapPaymentHandler(paymentController.recordPaymentFailure));

module.exports = router;
