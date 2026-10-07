const router = require('express').Router();
const contact = require('../controllers/contactController');
const { protect, optionalProtect } = require('../middleware/authMiddleware');
const { adminOnly } = require('../middleware/adminMiddleware');

router.post('/', optionalProtect, contact.createMessage);
router.get('/', protect, adminOnly, contact.adminList);
router.put('/:id/status', protect, adminOnly, contact.updateStatus);

module.exports = router;
