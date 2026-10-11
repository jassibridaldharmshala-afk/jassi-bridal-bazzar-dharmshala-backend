const M = require('../models/Rental');
const { batchReadiness } = require('./rentalSetupService');
// Apply this before pagination on every storefront collection.
async function publicFilter(req) {
  if (req.publicCommerceFilter) return req.publicCommerceFilter;
  const config = req.store?._id ? await M.Configuration.findOne({ storeId: req.store._id }).select('mode').lean() : null;
  const shopMode = config?.mode || req.store?.catalogStructure?.commerce?.mode || 'SALE_ONLY';
  const mode = req.query?.mode || '';
  if (mode === 'buy') return shopMode === 'RENTAL_ONLY' ? { _id: { $in: [] } } : { commerceMode: { $ne: 'RENTAL_ONLY' } };
  if (mode === 'rent' || shopMode === 'RENTAL_ONLY') {
    req.rentalCatalogRates = new Map();
    if (shopMode === 'SALE_ONLY' || !req.store?._id) return { _id: { $in: [] } };
    const offers = await M.Listing.find({ storeId: req.store._id, active: true }).lean();
    const readiness = await batchReadiness(req.store, offers);
    for (const offer of offers) {
      if (!readiness.get(String(offer._id))?.ready) continue;
      const id = String(offer.productId), previous = req.rentalCatalogRates.get(id);
      if (!previous || offer.dailyRatePaise < previous.dailyRatePaise) {
        req.rentalCatalogRates.set(id, { productId: offer.productId, dailyRatePaise: offer.dailyRatePaise });
      }
    }
    req.publicCommerceFilter = { _id: { $in: [...req.rentalCatalogRates.values()].map(row => row.productId) } };
    return req.publicCommerceFilter;
  }
  return shopMode === 'SALE_ONLY' ? { commerceMode: { $ne: 'RENTAL_ONLY' } } : {};
}
module.exports = { publicFilter };
