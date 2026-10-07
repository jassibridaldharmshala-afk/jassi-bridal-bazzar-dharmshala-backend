const router = require('express').Router();
const campaign = require('../controllers/campaignController');

router.get('/', campaign.list);
router.post('/', campaign.create);
router.get('/:id', campaign.get);
router.put('/:id', campaign.update);
router.patch('/:id/status', campaign.status);
router.post('/:id/duplicate', campaign.duplicate);
router.post('/:id/repair', campaign.repair);

module.exports = router;
