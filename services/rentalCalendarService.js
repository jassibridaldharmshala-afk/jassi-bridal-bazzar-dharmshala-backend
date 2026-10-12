const M = require('../models/Rental');
const A = require('./rentalAlgorithms');
const X = require('./rentalStudioAlgorithms');
const S = require('./rentalService');
const { calendarSnapshot } = require('./rentalCalendarSnapshot');
const { ApiError } = require('../utils/apiError');

async function calendarSet(store, query = {}, { counter = false, customerUserId } = {}) {
  if (!Array.isArray(query.items) || !query.items.length || query.items.length > 10) throw new ApiError('VALIDATION_ERROR', 'Choose 1–10 rental offers for the calendar.');
  const items = query.items.map(item => ({ listingId: A.id(item?.listingId), quantity: A.integer(Number(item?.quantity), 'quantity', 1, 10) }));
  if (new Set(items.map(item => item.listingId)).size !== items.length) throw new ApiError('VALIDATION_ERROR', 'Combine quantities for the same rental offer.');
  const [listings, configuration] = await Promise.all([
    M.Listing.find({ _id: { $in: items.map(item => item.listingId) }, storeId: store._id, active: true }).lean(),
    S.readConfiguration(store),
  ]);
  if (listings.length !== items.length) throw new ApiError('NOT_FOUND', 'A selected rental offer is unavailable.');
  const policy = A.validatePolicy(configuration.policy);
  const now = new Date(), today = A.localKey(now, policy.timezone);
  const month = query.month || today.slice(0, 7);
  if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || Number(month.slice(0, 4)) < 2000 || Number(month.slice(0, 4)) > 2100) throw new ApiError('VALIDATION_ERROR', 'Choose a valid calendar month.');
  const days = A.integer(Number(query.days || policy.minimumDays), 'rental duration', policy.minimumDays, policy.maximumDays);
  const pickupTime = query.pickupTime || policy.pickupStart, returnTime = query.returnTime || pickupTime;
  for (const time of [pickupTime, returnTime]) if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid pickup and return time.');
  const deliveryMode = query.deliveryMode || policy.deliveryModes[0];
  if (!policy.deliveryModes.includes(deliveryMode)) throw new ApiError('VALIDATION_ERROR', 'Choose an available delivery method.');
  const count = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate();
  const rows = new Array(count);
  const periods = [];
  for (let index = 0; index < count; index += 1) {
    const date = `${month}-${String(index + 1).padStart(2, '0')}`;
    const returnDate = new Date(Date.parse(`${date}T12:00:00Z`) + days * A.DAY).toISOString().slice(0, 10);
    try {
      const schedule = { pickupAt: X.localInstant(`${date}T${pickupTime}`, policy.timezone).toISOString(), returnDueAt: X.localInstant(`${returnDate}T${returnTime}`, policy.timezone).toISOString() };
      periods.push({ index, date, schedule, dates: A.schedule(schedule, policy, now, { allowImmediate: counter }) });
    } catch (error) {
      if ((error.errorCode || error.code) !== 'VALIDATION_ERROR') throw error;
      rows[index] = { date, status: 'UNBOOKABLE', reason: error.message };
    }
  }
  const snapshot = await calendarSnapshot(store, listings, items, configuration, periods.map(p => p.dates), now, counter ? undefined : customerUserId);
  // Reuse the authoritative quote checks (pieces, buffers, maintenance and shop
  // capacity). Public counts never include customer or piece identities.
  // An authenticated customer can see only their own existing booking link.
  for (const { index, date, schedule, dates } of periods) {
    let ownBooking;
    try {
      const match = !counter && await S.findCustomerDuplicate(store, snapshot.lines, dates, customerUserId, null, snapshot);
      if (match) ownBooking = { id: String(match.booking._id), number: match.booking.number, status: match.booking.status, pickupAt: match.booking.schedule.pickupAt, returnDueAt: match.booking.schedule.returnDueAt, useDates: match.booking.schedule.useDates || [], ...(match.booking.status === 'HELD' ? { expiresAt: match.booking.expiresAt } : {}) };
      const quoted = await S.publicQuote(store, { ...schedule, items, deliveryMode }, { counter, includeAvailability: true, calendarSnapshot: snapshot });
      rows[index] = { date, status: ownBooking ? 'ALREADY_BOOKED' : 'AVAILABLE', ...schedule, availability: quoted.availability, ...(ownBooking ? { ownBooking, reason: 'You already have a booking for this item and period.' } : {}), billableDays: quoted.schedule.days, rentalPaise: quoted.quote.rentalPaise, depositPaise: quoted.quote.depositPaise, dueNowPaise: quoted.quote.dueNowPaise };
    } catch (error) {
      const code = error.errorCode || error.code;
      if (!['OUT_OF_STOCK', 'VALIDATION_ERROR'].includes(code)) throw error;
      rows[index] = { date, status: ownBooking ? 'ALREADY_BOOKED' : code === 'OUT_OF_STOCK' ? 'UNAVAILABLE' : 'UNBOOKABLE', ...(code === 'OUT_OF_STOCK' ? schedule : {}), ...(ownBooking ? { ownBooking } : {}), ...(error.details?.availability ? { availability: error.details.availability } : {}), reason: ownBooking ? 'You already have a booking for this item and period.' : error.message };
    }
  }
  return { items, month, days, pickupTime, returnTime, deliveryMode, timezone: policy.timezone, checkedAt: new Date(), rows, availabilityIsAdvisory: true, note: 'Availability covers every selected item together, including preparation, cleaning and shop capacity. Dates are secured only after a booking hold; availability is checked again before booking.' };
}
async function calendar(store, listingId, query = {}, options = {}) {
  const id = A.id(listingId), quantity = A.integer(Number(query.quantity || 1), 'quantity', 1, 10);
  return { ...(await calendarSet(store, { ...query, items: [{ listingId: id, quantity }] }, options)), listingId: id, quantity };
}
module.exports = { calendar, calendarSet };
