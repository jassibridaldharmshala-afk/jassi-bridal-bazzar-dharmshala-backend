const router = require('express').Router();
const audit = require('../controllers/auditController');

router.get('/', audit.list);
router.get('/options', audit.options);
router.get('/:id', audit.get);
router.delete('/:id', audit.remove);

module.exports = router;
