const { asyncHandler } = require('../middleware/validate');
const service = require('../services/storefrontDiscoveryService');
const { homeProduct } = require('./storefrontHomeController');
exports.discovery = asyncHandler(async (req, res) => {
  const data = await service.discovery(req);
  // Recently viewed comes from this browser, never a shared/public cache.
  res.set('Cache-Control', 'private, no-store').json({ ...data, recentlyViewed: data.recentlyViewed.map(p => homeProduct(p, req)) });
});
exports.completeLook = asyncHandler(async (req, res) => {
  const data = await service.completeLook(req);
  res.set('Cache-Control', 'no-store').json({ ...data, products: data.products.map(p => ({ ...homeProduct(p, req), discoveryPurchase: p.discoveryPurchase, ...(p.rentalPreview ? { rentalPreview: p.rentalPreview } : {}) })) });
});
