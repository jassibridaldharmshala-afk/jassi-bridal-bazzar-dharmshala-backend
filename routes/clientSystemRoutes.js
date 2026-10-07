const router = require('express').Router();
const { protect } = require('../middleware/authMiddleware');
const { adminOnly } = require('../middleware/adminMiddleware');
const controller = require('../controllers/clientSystemController');

router.use(protect, adminOnly);
router.get('/license', controller.status);
router.post('/license/refresh', controller.refresh);
router.post('/subscription/checkout', controller.checkout);
router.post('/subscription/verify', controller.verify);

module.exports = router;
