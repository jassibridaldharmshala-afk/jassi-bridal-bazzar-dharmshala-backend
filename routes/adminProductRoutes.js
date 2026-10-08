const router = require('express').Router();
const product = require('../controllers/productController');
const smartFill = require('../controllers/productSmartFillController');

router.get('/', product.getProducts);
router.post('/photo-grouping', smartFill.limiter, smartFill.groupUpload, smartFill.groupPhotos);
router.get('/smart-fill/status', smartFill.status);
router.post('/smart-fill', smartFill.limiter, smartFill.fill);
router.get('/quick-analyze/status', product.getQuickAddVisionStatus);
router.post('/quick-analyze', product.analyzeQuickAdd);
router.get('/export', product.exportProducts);
router.get('/duplicate-check', product.checkDuplicates);
router.post('/bulk', product.bulkUpdateProducts);
router.get('/:id', product.getProductById);
router.post('/', product.createProduct);
router.put('/:id', product.updateProduct);
router.delete('/:id', product.deleteProduct);
router.get('/:id/deletion-preview', product.productDeletionPreview);
router.delete('/:id/permanent', product.permanentlyDeleteProduct);
router.post('/:id/duplicate', product.duplicateProduct);
router.patch('/:id/restore', product.restoreProduct);
router.patch('/:id/status', product.updateStatus);
router.patch('/:id/stock', product.updateStock);
router.patch('/:id/mark-out-of-stock', product.markOutOfStock);
router.patch('/:id/hide', product.hideProduct);

module.exports = router;
