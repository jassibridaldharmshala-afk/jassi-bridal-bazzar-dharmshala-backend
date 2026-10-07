const router = require('express').Router();
const crm = require('../controllers/crmController');

router.get('/export', crm.exportCustomers);
router.put('/settings', crm.updateRules);
router.post('/bulk-tags', crm.bulkTags);
router.post('/:userId/privacy-requests', crm.createPrivacyRequest);
router.patch('/:userId/privacy-requests/:requestId', crm.updatePrivacyRequest);
router.get('/:userId', crm.get);
router.put('/:userId/restrictions', crm.updateRestrictions);
router.put('/:userId', crm.update);
router.get('/', crm.list);

module.exports = router;
