const M = require('../models/Rental');
async function enrich(products, req) {
  if (!req.store?._id || String(req.baseUrl || '').startsWith('/api/admin') || String(req.baseUrl || '').startsWith('/api/seller')) return products;
  const eligible = products.filter(p => ['RENTAL_ONLY', 'SALE_AND_RENTAL'].includes(p.commerceMode));
  if (!eligible.length) return products;
  const config = await M.Configuration.findOne({ storeId: req.store._id }).select('mode').maxTimeMS(4000).lean();
  if ((config?.mode || req.store.catalogStructure?.commerce?.mode || 'SALE_ONLY') === 'SALE_ONLY') return products;
  // A single aggregate per response, including all home rails, rather than an
  // offer query from every individual product card.
  const rows = await M.Listing.aggregate([
    { $match: { storeId: req.store._id, productId: { $in: eligible.map(p => require('mongoose').Types.ObjectId.createFromHexString(String(p._id))) }, active: true } },
    { $sort: { dailyRatePaise: 1, _id: 1 } },
    { $group: { _id: '$productId', dailyRatePaise: { $first: '$dailyRatePaise' }, depositPaise: { $first: '$depositPaise' }, fitting: { $first: '$fitting' } } },
  ]).option({ maxTimeMS: 4000 });
  const byId = new Map(rows.map(({ _id, ...price }) => [String(_id), price]));
  return products.map(p => byId.has(String(p._id)) ? { ...p, rentalPreview: byId.get(String(p._id)) } : p);
}
module.exports = { enrich };
