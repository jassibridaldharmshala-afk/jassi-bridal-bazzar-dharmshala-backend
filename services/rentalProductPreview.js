const M = require('../models/Rental');
const { batchReadiness } = require('./rentalSetupService');
async function enrich(products, req) {
  if (!req.store?._id) return products;
  const privateCatalogue = String(req.baseUrl || '').startsWith('/api/admin') || String(req.baseUrl || '').startsWith('/api/seller');
  const eligible = products.filter(p => ['RENTAL_ONLY', 'SALE_AND_RENTAL'].includes(p.commerceMode));
  if (!eligible.length) return products;
  const configuration = await require('./rentalService').readConfiguration(req.store);
  const rows = await M.Listing.find({ storeId: req.store._id, productId: { $in: eligible.map(p => p._id) } }).sort('dailyRatePaise _id').lean();
  const statuses = await batchReadiness(req.store, rows);
  const grouped = new Map();
  for (const row of rows) { const id = String(row.productId); if (!grouped.has(id)) grouped.set(id, []); grouped.get(id).push(row); }
  return products.map(p => {
    const offers = grouped.get(String(p._id));
    if (!offers) return ['RENTAL_ONLY', 'SALE_AND_RENTAL'].includes(p.commerceMode) ? { ...p, rentalStatus: { live: false, label: 'Setup pending', ...(privateCatalogue ? { pieces: { ready: 0, reserved: 0, booked: 0, cleaning: 0 } } : {}) } } : p;
    const live = configuration.mode !== 'SALE_ONLY' ? offers.find(row => row.active && statuses.get(String(row._id)).ready) : null;
    // General and variant-specific offers may share the same physical pieces.
    const pieces = new Map();
    for (const row of offers) for (const c of statuses.get(String(row._id)).components) {
      for (const piece of c._pieceStates) pieces.set(piece.id, piece);
    }
    const values = [...pieces.values()];
    const totals = { ready: values.filter(p => p.status === 'READY').length,
      reserved: values.filter(p => p.status !== 'OUT' && p.reserved).length,
      booked: values.filter(p => p.status === 'OUT').length,
      cleaning: values.filter(p => ['CLEANING', 'REPAIR'].includes(p.status)).length };
    const result = { ...p, rentalStatus: { live: !!live, label: live ? 'Live' : 'Setup pending', ...(privateCatalogue ? { listingId: String((live || offers[0])._id), pieces: totals } : {}) } };
    if (live) result.rentalPreview = { listingId: String(live._id), dailyRatePaise: live.dailyRatePaise, depositPaise: live.depositPaise, ...(live.fitting ? { fitting: live.fitting } : {}) };
    return result;
  });
}
module.exports = { enrich };
