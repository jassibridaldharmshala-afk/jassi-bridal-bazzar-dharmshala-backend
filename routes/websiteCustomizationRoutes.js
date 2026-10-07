const router = require('express').Router();
const customization = require('../controllers/websiteCustomizationController');

router.get('/', customization.getWorkspace);
router.get('/presets', customization.getPresets);
router.get('/themes', customization.listThemes);
router.post('/themes', customization.createTheme);
router.get('/themes/:id', customization.getTheme);
router.put('/themes/:id/draft', customization.updateDraft);
router.post('/themes/:id/preflight', customization.preflightTheme);
router.post('/themes/:id/discard', customization.discardDraft);
router.post('/themes/:id/duplicate', customization.duplicateTheme);
router.post('/themes/:id/publish', customization.publishTheme);
router.post('/themes/:id/schedule', customization.scheduleTheme);
router.delete('/themes/:id/schedule', customization.cancelThemeSchedule);
router.post('/themes/:id/activate', customization.activateTheme);
router.delete('/themes/:id', customization.deleteTheme);
router.get('/themes/:id/history', customization.getHistory);
router.post('/themes/:id/history/:versionId/restore', customization.restoreVersion);

module.exports = router;
