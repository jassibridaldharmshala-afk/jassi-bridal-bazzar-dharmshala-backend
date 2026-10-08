const router = require('express').Router();
const { protect } = require('../middleware/authMiddleware');
router.get('/:id', protect, require('../services/privateEvidenceService').retrieve);
module.exports = router;

