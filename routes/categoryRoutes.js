const router = require('express').Router();
const category = require('../controllers/categoryController');
const { protect } = require('../middleware/authMiddleware');
const { adminOnly } = require('../middleware/adminMiddleware');
const { validateObjectIdParam } = require('../middleware/validate');

// The public storefront receives visible, non-archived categories only. The
// admin mount already authenticates this route and receives management data.
router.get('/', category.getCategories);

router.use(protect, adminOnly);
router.put('/reorder', category.reorderCategories);
router.get('/:id/impact', validateObjectIdParam(), category.getCategoryImpact);
router.post('/:id/reassign', validateObjectIdParam(), category.reassignCategory);
router.patch('/:id/status', validateObjectIdParam(), category.updateCategoryStatus);
router.patch('/:id/archive', validateObjectIdParam(), category.archiveCategory);
router.patch('/:id/restore', validateObjectIdParam(), category.restoreCategory);
router.get('/:id', validateObjectIdParam(), category.getCategoryById);
router.post('/', category.createCategory);
router.put('/:id', validateObjectIdParam(), category.updateCategory);
router.delete('/:id', validateObjectIdParam(), category.deleteCategory);

module.exports = router;
