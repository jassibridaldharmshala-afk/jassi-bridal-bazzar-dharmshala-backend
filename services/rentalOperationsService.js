const M = require('../models/Rental');
const A = require('./rentalAlgorithms');
const X = require('./rentalStudioAlgorithms');
const { ApiError } = require('../utils/apiError');
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function dateRange(day, timezone) {
  const value = new Date(`${day}T12:00Z`);
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(+value) || value.toISOString().slice(0, 10) !== day) throw new ApiError('VALIDATION_ERROR', 'Choose a valid operations date.');
  const next = new Date(Date.parse(`${day}T12:00Z`) + A.DAY).toISOString().slice(0, 10);
  return { from: X.localInstant(`${day}T00:00`, timezone), to: X.localInstant(`${next}T00:00`, timezone) };
}
async function bookingFilter(store, query, userId) {
  const filter = { storeId: store._id, ...(userId ? { userId } : {}) }, and = [];
  if (query.status) { if (!['HELD', 'CONFIRMED', 'PREPARING', 'READY', 'OUT', 'RETURNED', 'CLOSED', 'CANCELLED', 'EXPIRED'].includes(query.status)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid booking status.'); filter.status = query.status; }
  if (query.search) {
    const search = A.text(query.search, 100);
    if (!search.trim()) throw new ApiError('VALIDATION_ERROR', 'Enter a booking search.');
    const regex = new RegExp(escape(search.trim()), 'i');
    and.push({ $or: [{ number: regex }, { 'customer.name': regex }, { 'customer.phone': regex }] });
  }
  if (query.from || query.to) { const from = A.date(query.from), to = A.date(query.to); if (+to <= +from || +to - +from > 93 * A.DAY) throw new ApiError('VALIDATION_ERROR', 'Use a calendar range of at most 93 days.'); and.push({ $or: [{ 'schedule.pickupAt': { $lt: to }, 'schedule.returnDueAt': { $gt: from } }, { 'trial.at': { $gte: from, $lt: to } }] }); }
  const view = query.overdue === 'true' ? 'overdue' : (query.view || 'all');
  if (!['all', 'pickups', 'returns', 'overdue', 'balance', 'refunds'].includes(view)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid booking desk view.');
  const now = new Date();
  if (['pickups', 'returns'].includes(view)) {
    const { policy } = await require('./rentalService').readConfiguration(store);
    const { from, to } = dateRange(query.day || A.localKey(now, policy.timezone), policy.timezone);
    and.push(view === 'pickups' ? { status: { $in: ['CONFIRMED', 'PREPARING', 'READY'] }, 'schedule.pickupAt': { $gte: from, $lt: to } } : { status: 'OUT', 'schedule.returnDueAt': { $gte: from, $lt: to } });
  }
  if (view === 'overdue') and.push({ status: 'OUT', 'schedule.returnDueAt': { $lt: now } });
  if (view === 'balance') and.push({ status: { $in: ['CONFIRMED', 'PREPARING', 'READY', 'OUT', 'RETURNED'] } });
  if (view === 'refunds') and.push({ status: { $in: ['RETURNED', 'CANCELLED', 'EXPIRED', 'CLOSED'] } });
  if (and.length) filter.$and = and;
  return { filter, view };
}
// Exactly the money rules in A.finances, evaluated before pagination. No totals
// or search results silently omit bookings outside the first page.
function financialPipeline(filter, view) {
  const sum = (field, condition) => ({ $sum: { $map: { input: { $filter: { input: { $ifNull: [field, []] }, as: 'e', cond: condition } }, as: 'e', in: '$$e.amountPaise' } } });
  const completed = { $in: ['$status', ['RETURNED', 'CANCELLED', 'EXPIRED', 'CLOSED']] };
  return [
    { $match: filter },
    { $set: { _collected: sum('$ledger', { $eq: ['$$e.kind', 'COLLECTION'] }), _reserved: sum('$ledger', { $and: [{ $eq: ['$$e.kind', 'REFUND'] }, { $ne: ['$$e.status', 'FAILED'] }] }), _deductions: sum('$assessments', { $eq: ['$$e.approved', true] }), _rent: { $ifNull: ['$adjustedRentalPaise', '$quote.rentalPaise'] } } },
    { $set: { _required: { $add: ['$_rent', { $cond: [completed, '$_deductions', { $max: ['$quote.depositPaise', '$_deductions'] }] }] } } },
    { $match: { $expr: { $gt: [view === 'balance' ? { $add: [{ $subtract: ['$_required', '$_collected'] }, '$_reserved'] } : { $subtract: [{ $subtract: ['$_collected', '$_required'] }, '$_reserved'] }, 0] } } },
  ];
}
async function dailyDesk(store, query = {}) {
  const { policy } = await require('./rentalService').readConfiguration(store);
  const day = query.day || A.localKey(new Date(), policy.timezone);
  dateRange(day, policy.timezone);
  const entries = await Promise.all(['pickups', 'returns', 'overdue', 'balance', 'refunds'].map(async view => {
    const { filter } = await bookingFilter(store, { day, view });
    const total = ['balance', 'refunds'].includes(view) ? (await M.Booking.aggregate([...financialPipeline(filter, view), { $count: 'total' }]))[0]?.total || 0 : await M.Booking.countDocuments(filter);
    return [view, total];
  }));
  return { day, timezone: policy.timezone, counts: Object.fromEntries(entries), checkedAt: new Date() };
}
async function timeline(store, query = {}) {
  const { policy } = await require('./rentalService').readConfiguration(store);
  const start = query.start || A.localKey(new Date(), policy.timezone), days = A.integer(Number(query.days || 7), 'timeline duration', 1, 31);
  const from = dateRange(start, policy.timezone).from, end = new Date(Date.parse(`${start}T12:00Z`) + days * A.DAY).toISOString().slice(0, 10), to = dateRange(end, policy.timezone).from;
  const page = A.integer(Number(query.page || 1), 'page', 1, 10000);
  const filter = { storeId: store._id };
  if (query.search) { const regex = new RegExp(escape(A.text(query.search, 100)), 'i'); filter.$or = [{ code: regex }, { label: regex }, { poolKey: regex }]; }
  const [assets, total] = await Promise.all([M.Asset.find(filter).sort({ code: 1, _id: 1 }).skip((page - 1) * 20).limit(20).select('_id code label poolKey status currentBookingId returnDueAt saleConversion').lean(), M.Asset.countDocuments(filter)]);
  const reservations = await M.Reservation.find({ storeId: store._id, assetId: { $in: assets.map(a => a._id) }, active: true, blockedFrom: { $lt: to }, blockedUntil: { $gt: from }, $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] }).limit(2001).lean();
  if (reservations.length > 2000) throw new ApiError('VALIDATION_ERROR', 'Narrow the piece search or timeline period.');
  const bookingIds = [...new Set([...reservations.map(r => r.bookingId), ...assets.map(a => a.currentBookingId)].filter(Boolean).map(String))];
  const bookings = await M.Booking.find({ storeId: store._id, _id: { $in: bookingIds } }).select('_id number schedule status expiresAt allocations').lean();
  const byId = new Map(bookings.map(b => [String(b._id), b]));
  const overdueTasks = await M.Task.find({ storeId: store._id, assetId: { $in: assets.map(a => a._id) }, status: { $in: require('./rentalStudioService').openTasks }, dueAt: { $lte: new Date() } }).select('assetId').lean();
  const segment = (kind, begin, until, extra = {}) => ({ kind, from: new Date(Math.max(+from, +new Date(begin))), to: new Date(Math.min(+to, +new Date(until))), ...extra });
  const rows = assets.map(asset => {
    const segments = [];
    if (overdueTasks.some(t => String(t.assetId) === String(asset._id))) segments.push(segment('OVERDUE_TASK', new Date(), to, { needsRelease: true }));
    for (const r of reservations.filter(r => String(r.assetId) === String(asset._id))) {
      const b = byId.get(String(r.bookingId));
      if (r.kind !== 'BOOKING' || !b) { segments.push(segment(r.kind, r.blockedFrom, r.blockedUntil)); continue; }
      if (['CANCELLED', 'EXPIRED', 'CLOSED'].includes(b.status) || (b.status === 'HELD' && +b.expiresAt <= Date.now())) continue;
      const extra = { bookingId: b._id, number: b.number, status: b.status };
      const allocation = b.allocations.find(a => String(a.assetId) === String(asset._id));
      const returned = allocation?.receivedAt || allocation?.lostAt;
      const useEnd = returned && +returned < +new Date(b.schedule.returnDueAt) ? returned : b.schedule.returnDueAt;
      segments.push(segment('PREPARATION', r.blockedFrom, b.schedule.pickupAt, extra));
      segments.push(segment(b.status === 'HELD' ? 'HELD' : 'BOOKED', b.schedule.pickupAt, useEnd, extra));
      segments.push(segment('CLEANING_BUFFER', useEnd, r.blockedUntil, extra));
    }
    if (['CLEANING', 'REPAIR', 'INSPECTION', 'LOST', 'RETIRED'].includes(asset.status) || asset.saleConversion) segments.push(segment(asset.saleConversion ? 'SOLD' : asset.status, new Date(), to, { needsRelease: true }));
    if (asset.status === 'OUT' && asset.currentBookingId) {
      const b = byId.get(String(asset.currentBookingId));
      const overdue = +asset.returnDueAt < Date.now();
      segments.push(segment(overdue ? 'OVERDUE' : 'OUT', Math.max(+from, Date.now()), overdue ? to : asset.returnDueAt, b ? { bookingId: b._id, number: b.number, status: b.status } : {}));
    }
    return { _id: asset._id, code: asset.code, label: asset.label, poolKey: asset.poolKey, status: asset.status, segments: segments.filter(s => +s.to > +s.from) };
  });
  const dates = Array.from({ length: days }, (_, i) => new Date(Date.parse(`${start}T12:00Z`) + i * A.DAY).toISOString().slice(0, 10));
  return { start, days, dates, timezone: policy.timezone, rows, total, page, pages: Math.ceil(total / 20), checkedAt: new Date(), note: 'Planning view. Cleaning/repair and overdue pieces remain blocked until staff release them. Actual rental availability is checked for the selected period before booking.' };
}
module.exports = { bookingFilter, financialPipeline, dailyDesk, timeline, dateRange };
