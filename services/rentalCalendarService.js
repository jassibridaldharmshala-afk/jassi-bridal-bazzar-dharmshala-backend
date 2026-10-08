const M = require('../models/Rental');
const A = require('./rentalAlgorithms');
const X = require('./rentalStudioAlgorithms');
const S = require('./rentalService');
const { ApiError } = require('../utils/apiError');

async function calendarSet(store, query = {}, { counter = false } = {}) {
  if (!Array.isArray(query.items) || !query.items.length || query.items.length > 10) throw new ApiError('VALIDATION_ERROR', 'Choose 1–10 rental offers for the calendar.');
  const items = query.items.map(item => ({ listingId: A.id(item?.listingId), quantity: A.integer(Number(item?.quantity), 'quantity', 1, 10) }));
  if (new Set(items.map(item => item.listingId)).size !== items.length) throw new ApiError('VALIDATION_ERROR', 'Combine quantities for the same rental offer.');
  const listings = await M.Listing.find({ _id: { $in: items.map(item => item.listingId) }, storeId: store._id, active: true }).select('productId').lean();
  if (listings.length !== items.length) throw new ApiError('NOT_FOUND', 'A selected rental offer is unavailable.');
  // Check every selected product before starting the bounded monthly quote scan.
  for (const listing of listings) {
    const data = await S.publicListings(store, listing.productId);
    if (!data.enabled || !data.listings.some(row => String(row._id) === String(listing._id))) throw new ApiError('NOT_FOUND', 'A selected rental offer is unavailable.');
  }
  const policy = A.validatePolicy((await S.readConfiguration(store)).policy);
  const today = A.localKey(new Date(), policy.timezone);
  const month = query.month || today.slice(0, 7);
  if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || Number(month.slice(0, 4)) < 2000 || Number(month.slice(0, 4)) > 2100) throw new ApiError('VALIDATION_ERROR', 'Choose a valid calendar month.');
  const days = A.integer(Number(query.days || policy.minimumDays), 'rental duration', policy.minimumDays, policy.maximumDays);
  const pickupTime = query.pickupTime || policy.pickupStart, returnTime = query.returnTime || pickupTime;
  for (const time of [pickupTime, returnTime]) if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid pickup and return time.');
  const deliveryMode = query.deliveryMode || policy.deliveryModes[0];
  if (!policy.deliveryModes.includes(deliveryMode)) throw new ApiError('VALIDATION_ERROR', 'Choose an available delivery method.');
  const count = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate();
  const rows = new Array(count);
  let cursor = 0;
  // Reuse the authoritative quote checks (pieces, buffers, maintenance and shop
  // capacity). No reservations, customer names or booking identifiers leave this API.
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cursor < count) {
      const index = cursor++, date = `${month}-${String(index + 1).padStart(2, '0')}`;
      const returnDate = new Date(Date.parse(`${date}T12:00:00Z`) + days * A.DAY).toISOString().slice(0, 10);
      try {
        const pickupAt = X.localInstant(`${date}T${pickupTime}`, policy.timezone).toISOString();
        const returnDueAt = X.localInstant(`${returnDate}T${returnTime}`, policy.timezone).toISOString();
        const quoted = await S.publicQuote(store, { pickupAt, returnDueAt, items, deliveryMode }, { counter });
        rows[index] = { date, status: 'AVAILABLE', pickupAt, returnDueAt, billableDays: quoted.schedule.days, rentalPaise: quoted.quote.rentalPaise, depositPaise: quoted.quote.depositPaise, dueNowPaise: quoted.quote.dueNowPaise };
      } catch (error) {
        const code = error.errorCode || error.code;
        if (!['OUT_OF_STOCK', 'VALIDATION_ERROR'].includes(code)) throw error;
        rows[index] = { date, status: code === 'OUT_OF_STOCK' ? 'UNAVAILABLE' : 'UNBOOKABLE', reason: error.message };
      }
    }
  }));
  return { items, month, days, pickupTime, returnTime, deliveryMode, timezone: policy.timezone, checkedAt: new Date(), rows, availabilityIsAdvisory: true, note: 'Availability covers every selected item together, including preparation, cleaning and shop capacity. Dates are secured only after a booking hold; availability is checked again before booking.' };
}
async function calendar(store, listingId, query = {}) {
  const id = A.id(listingId), quantity = A.integer(Number(query.quantity || 1), 'quantity', 1, 10);
  return { ...(await calendarSet(store, { ...query, items: [{ listingId: id, quantity }] })), listingId: id, quantity };
}
module.exports = { calendar, calendarSet };
