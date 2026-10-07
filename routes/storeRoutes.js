const router = require('express').Router();
const store = require('../controllers/storeController');
const { protect } = require('../middleware/authMiddleware');
const { requireStoreMember, requireStorePermission, stripClientStoreId } = require('../middleware/storeMiddleware');


router.get('/', protect, store.listMine);
router.get('/resolve', store.resolveHost);
router.get('/me/current', protect, requireStoreMember, store.getMine);
router.put('/me/current', protect, requireStoreMember, requireStorePermission('settings.write'), stripClientStoreId, store.updateMine);
router.post('/me/current/publish', protect, requireStoreMember, requireStorePermission('settings.write'), store.publishMine);
router.get('/:slug', store.getPublic);

module.exports = router;
