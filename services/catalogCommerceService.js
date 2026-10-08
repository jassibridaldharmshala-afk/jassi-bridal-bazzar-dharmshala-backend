const M = require('../models/Rental');
const { batchReadiness } = require('./rentalSetupService');
// Apply this before pagination on every storefront collection.
async function publicFilter(req) {
  const config = req.store?._id ? await M.Configuration.findOne({ storeId: req.store._id }).select('mode').lean() : null;
  const shopMode = config?.mode || req.store?.catalogStructure?.commerce?.mode || 'SALE_ONLY';
  const mode = req.query?.mode || '';
  if (mode === 'buy') return shopMode === 'RENTAL_ONLY' ? { _id: { $in: [] } } : { commerceMode: { $ne: 'RENTAL_ONLY' } };
  if (mode === 'rent' || shopMode === 'RENTAL_ONLY') {
    if (shopMode === 'SALE_ONLY' || !req.store?._id) return { _id: { $in: [] } };
    const offers = await M.Listing.find({ storeId: req.store._id, active: true }).lean();
    const readiness = await batchReadiness(req.store, offers);
    return { _id: { $in: [...new Map(offers.filter(row => readiness.get(String(row._id)).ready).map(row => [String(row.productId), row.productId])).values()] } };
  }
  return shopMode === 'SALE_ONLY' ? { commerceMode: { $ne: 'RENTAL_ONLY' } } : {};
}
module.exports = { publicFilter };
