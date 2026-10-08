const mongoose = require('mongoose');
const Product = require('../models/Product');
const M = require('../models/Rental');
const { defaultStoreFilter } = require('./storeService');
const { batchReadiness } = require('./rentalSetupService');
const { ApiError } = require('../utils/apiError');
// Cursor pagination scans bounded batches; no permanent inventory condition is
// confused with temporary cleaning or date reservations.
async function queue(store, query = {}) {
  const limit = require('./rentalAlgorithms').integer(query.limit ?? 24, 'limit', 1, 50);
  if (query.after && !mongoose.isValidObjectId(query.after)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid queue cursor.');
  const scope = store.isDefault ? defaultStoreFilter(store._id) : { storeId: store._id };
  const configuration = await require('./rentalService').readConfiguration(store);
  const shopReasons = [
    configuration.mode === 'SALE_ONLY' && { code: 'RENTALS_DISABLED', message: 'Enable rentals in shop policies.' },
    configuration.readiness.acceptingOrders === false && { code: 'ORDERS_PAUSED', message: configuration.readiness.pauseMessage || 'New bookings are paused.' },
    !configuration.readiness.onlinePayments && { code: 'PAYMENT_UNAVAILABLE', message: 'Configure an enabled online payment method.' },
  ].filter(Boolean);
  const rows = []; let after = query.after || '', scanned = 0, more = true;
  const search = String(query.search || '').trim().slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  while (rows.length < limit && scanned < 1000 && more) {
    const products = await Product.find({ $and: [scope, { commerceMode: { $in: ['RENTAL_ONLY', 'SALE_AND_RENTAL'] }, isArchived: { $ne: true },
      ...(after ? { _id: { $gt: after } } : {}), ...(search ? { name: new RegExp(search, 'i') } : {}) }] })
      .select('_id name slug commerceMode isActive publishAt').sort('_id').limit(50).maxTimeMS(5000).lean();
    more = products.length === 50;
    if (!products.length) break;
    const offers = await M.Listing.find({ storeId: store._id, productId: { $in: products.map(p => p._id) } }).lean();
    const readiness = await batchReadiness(store, offers);
    for (const product of products) {
      after = String(product._id); scanned++;
      const listingRows = offers.filter(row => String(row.productId) === after).map(row => ({ _id: row._id, title: row.title, active: row.active,
        reasons: [...(readiness.get(String(row._id))?.reasons || []), ...(!row.active ? [{ code: 'OFFER_INACTIVE', message: 'Review and activate this offer.' }] : [])] }));
      const reasons = [...shopReasons, ...(!listingRows.length ? [{ code: 'OFFER_MISSING', message: 'Add a rental rate and offer, then register actual pieces.' }] : [])];
      if (reasons.length || listingRows.some(row => row.reasons.length)) rows.push({ product, offers: listingRows, reasons });
      if (rows.length === limit || scanned === 1000) { more = true; break; }
    }
  }
  return { rows, next: more ? after : null, hasMore: more, scanned, configurationReasons: shopReasons,
    note: 'Temporary cleaning and booked dates are handled by availability, not missing-piece setup.' };
}
module.exports = { queue };

