const router = require('express').Router();
const newsletter = require('../controllers/newsletterController');
const { protect } = require('../middleware/authMiddleware');
const { adminOnly } = require('../middleware/adminMiddleware');

router.post('/subscribe', newsletter.subscribe);
router.post('/unsubscribe', newsletter.unsubscribe);
router.get('/', protect, adminOnly, newsletter.adminList);

module.exports = router;
