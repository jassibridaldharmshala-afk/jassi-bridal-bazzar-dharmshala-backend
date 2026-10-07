const router = require('express').Router();
const notifications = require('../controllers/notificationController');
const { protect } = require('../middleware/authMiddleware');

router.get('/', protect, notifications.myNotifications);
router.get('/summary', protect, notifications.summary);
router.patch('/read-all', protect, notifications.markAllRead);
router.patch('/:id/read', protect, notifications.markRead);

module.exports = router;
