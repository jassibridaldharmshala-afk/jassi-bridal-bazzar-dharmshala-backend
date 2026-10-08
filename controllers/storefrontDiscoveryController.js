const { asyncHandler } = require('../middleware/validate');
const service = require('../services/storefrontDiscoveryService');
const { homeProduct } = require('./storefrontHomeController');
exports.discovery = asyncHandler(async (req, res) => {
  req.commerceFilter = await require('../services/catalogCommerceService').publicFilter(req);
  const data = await service.discovery(req);
  // Recently viewed comes from this browser, never a shared/public cache.
  const rows = await require('../services/rentalProductPreview').enrich(data.recentlyViewed.map(p => homeProduct(p, req)), req);
  res.set('Cache-Control', 'private, no-store').json({ ...data, recentlyViewed: rows });
});
exports.completeLook = asyncHandler(async (req, res) => {
  req.commerceFilter = await require('../services/catalogCommerceService').publicFilter(req);
  const data = await service.completeLook(req);
  const rows = await require('../services/rentalProductPreview').enrich(data.products.map(p => ({ ...homeProduct(p, req), discoveryPurchase: p.discoveryPurchase, ...(p.rentalPreview ? { rentalPreview: p.rentalPreview } : {}) })), req);
  res.set('Cache-Control', 'no-store').json({ ...data, products: rows });
});
