const router = require('express').Router();
const auth = require('../controllers/authController');
const dashboard = require('../controllers/dashboardController');
const inventory = require('../controllers/inventoryController');
const reports = require('../controllers/reportController');
const { protect } = require('../middleware/authMiddleware');
const { adminOnly } = require('../middleware/adminMiddleware');
const { optionalResolveStore, requireAdminCustomerStoreAccess } = require('../middleware/storeMiddleware');

router.post('/login', auth.adminLogin);
router.get('/profile', protect, adminOnly, auth.profile);
router.get('/dashboard/stats', protect, adminOnly, dashboard.stats);
router.get('/dashboard/overview', protect, adminOnly, dashboard.overview);
router.get('/dashboard/recent-orders', protect, adminOnly, dashboard.recentOrders);
router.get('/dashboard/low-stock', protect, adminOnly, dashboard.lowStock);
router.get('/inventory/low-stock', protect, adminOnly, dashboard.lowStock);
router.get('/inventory/catalog', protect, adminOnly, inventory.catalog);
router.get('/inventory/summary', protect, adminOnly, inventory.summary);
router.get('/inventory/export', protect, adminOnly, inventory.exportCatalog);
router.get('/inventory/history', protect, adminOnly, inventory.history);
router.post('/inventory/adjustments', protect, adminOnly, inventory.adjust);
router.post('/inventory/adjustments/:id/reverse', protect, adminOnly, inventory.reverse);
router.post('/inventory/bulk-adjustments', protect, adminOnly, inventory.bulkAdjust);
router.get('/inventory/purchase-orders', protect, adminOnly, inventory.listPurchaseOrders);
router.post('/inventory/purchase-orders', protect, adminOnly, inventory.createPurchaseOrder);
router.post('/inventory/purchase-orders/:id/receive', protect, adminOnly, inventory.receivePurchaseOrder);
router.post('/inventory/purchase-orders/:id/cancel', protect, adminOnly, inventory.cancelPurchaseOrder);
router.get('/reports/options', protect, adminOnly, optionalResolveStore, requireAdminCustomerStoreAccess, reports.options);
router.get('/reports/views', protect, adminOnly, optionalResolveStore, requireAdminCustomerStoreAccess, reports.listViews);
router.post('/reports/views', protect, adminOnly, optionalResolveStore, requireAdminCustomerStoreAccess, reports.createView);
router.put('/reports/views/:id', protect, adminOnly, optionalResolveStore, requireAdminCustomerStoreAccess, reports.updateView);
router.delete('/reports/views/:id', protect, adminOnly, optionalResolveStore, requireAdminCustomerStoreAccess, reports.deleteView);
router.post('/reports/views/:id/run', protect, adminOnly, optionalResolveStore, requireAdminCustomerStoreAccess, reports.runView);
router.post('/reports/export', protect, adminOnly, optionalResolveStore, requireAdminCustomerStoreAccess, reports.exportReport);
router.get('/reports/center/:section', protect, adminOnly, optionalResolveStore, requireAdminCustomerStoreAccess, reports.section);
router.get('/reports/sales', protect, adminOnly, optionalResolveStore, requireAdminCustomerStoreAccess, dashboard.salesReport);
router.get('/reports/products', protect, adminOnly, optionalResolveStore, requireAdminCustomerStoreAccess, dashboard.productReport);
// Customer listing, blocking and role changes live in customerAdminRoutes,
// which is mounted earlier on /api/admin/customers and carries the
// self-lockout and id validation guards.

module.exports = router;
