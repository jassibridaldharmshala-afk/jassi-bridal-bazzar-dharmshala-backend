const M = require('../models/Rental');
const Product = require('../models/Product');
const A = require('./rentalAlgorithms');
const X = require('./rentalStudioAlgorithms');
const { ApiError } = require('../utils/apiError');
const S = () => require('./rentalService');
const fail = (message, code = 'VALIDATION_ERROR') => { throw new ApiError(code, message); };
const unavailable = error => ['OUT_OF_STOCK', 'NOT_FOUND'].includes(error.errorCode || error.code);
async function availability(store, query, { counter = false } = {}) {
  const configuration = await S().readConfiguration(store);
  if (!configuration.policy.dateFirstEnabled) fail('Date-first rental shopping is disabled.', 'CHECKOUT_RESTRICTED');
  const dates = A.schedule(query, configuration.policy, new Date(), { allowImmediate: counter });
  const quantity = A.integer(Number(query.quantity || 1), 'quantity', 1, 10);
  const data = await S().catalogue(store, query);
  const rows = new Array(data.rows.length);
  let cursor = 0;
  // Four concurrent read-only checks keep mobile date searches responsive without flooding the database.
  // Final booking still rechecks and reserves all requested pieces atomically.
  await Promise.all(Array.from({ length: Math.min(4, data.rows.length) }, async () => {
    while (cursor < data.rows.length) {
      const index = cursor++, listing = data.rows[index];
      try {
        const quoted = await S().publicQuote(store, { pickupAt: dates.pickupAt.toISOString(), returnDueAt: dates.returnDueAt.toISOString(),
          items: [{ listingId: String(listing._id), quantity }], deliveryMode: query.deliveryMode || 'STORE_PICKUP' }, { counter });
        rows[index] = { ...listing, availability: 'AVAILABLE', quoted };
      } catch (error) {
        if (!unavailable(error)) throw error;
        rows[index] = { ...listing, availability: 'UNAVAILABLE', availabilityReason: error.message };
      }
    }
  }));
  rows.sort((a, b) => (a.availability === 'AVAILABLE' ? 0 : 1) - (b.availability === 'AVAILABLE' ? 0 : 1));
  return { ...data, schedule: dates, rows, availabilityIsAdvisory: true };
}
async function alternatives(store, listingId, query, { counter = false } = {}) {
  const config = await S().readConfiguration(store);
  if (!config.policy.dateFirstEnabled) fail('Date-first shopping is disabled.');
  const listing = await M.Listing.findOne({ storeId: store._id, _id: A.id(listingId), active: true }).lean();
  if (!listing) fail('Rental offer not found.', 'NOT_FOUND');
  const dates = A.schedule(query, config.policy, new Date(), { allowImmediate: counter });
  const quantity = A.integer(Number(query.quantity || 1), 'quantity', 1, 10), nextDates = [], matches = [];
  for (let offset = 1; offset <= 14 && nextDates.length < 3; offset += 1) {
    const shift = date => {
      const local = A.localKey(date, config.policy.timezone);
      const day = new Date(Date.parse(local + 'T12:00Z') + offset * A.DAY).toISOString().slice(0, 10);
      const time = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: config.policy.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
      return X.localInstant(day + 'T' + time.hour + ':' + time.minute, config.policy.timezone).toISOString();
    };
    try {
      const quoted = await S().publicQuote(store, { pickupAt: shift(dates.pickupAt), returnDueAt: shift(dates.returnDueAt),
        items: [{ listingId: String(listing._id), quantity }], deliveryMode: query.deliveryMode || 'STORE_PICKUP' }, { counter });
      nextDates.push({ schedule: quoted.schedule, totalPaise: quoted.quote.totalPaise });
    } catch (error) { if (!unavailable(error) && (error.errorCode || error.code) !== 'VALIDATION_ERROR') throw error; }
  }
  const product = await Product.findOne({ _id: listing.productId, storeId: store._id }).select('category').lean();
  const data = await S().catalogue(store, { ...query, page: 1 });
  for (const other of data.rows.filter(row => String(row._id) !== String(listing._id) && String(row.product?.category || '') === String(product?.category || '') && (!listing.size || row.size === listing.size)).slice(0, 6)) {
    try {
      const quoted = await S().publicQuote(store, { pickupAt: dates.pickupAt.toISOString(), returnDueAt: dates.returnDueAt.toISOString(), items: [{ listingId: String(other._id), quantity }], deliveryMode: query.deliveryMode || 'STORE_PICKUP' }, { counter });
      matches.push({ ...other, totalPaise: quoted.quote.totalPaise });
    } catch (error) { if (!unavailable(error)) throw error; }
  }
  return { nextDates, matches, searchWindowDays: 14, note: 'Suggestions are not reservations. Review the latest price and pay the compulsory advance through normal booking.' };
}
async function slots(store, query, { counter = false } = {}) {
  const config = await S().readConfiguration(store);
  if (!config.policy.dateFirstEnabled) fail('Date-first shopping is disabled.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(query.date || '') || !Number.isFinite(Date.parse(query.date + 'T12:00Z'))) fail('Choose a valid shop date.');
  const p = config.policy, [h, m] = p.pickupStart.split(':').map(Number), [eh, em] = p.pickupEnd.split(':').map(Number), rows = [];
  for (let minute = h * 60 + m; minute < eh * 60 + em; minute += p.slotMinutes) {
    const time = String(Math.floor(minute / 60)).padStart(2, '0') + ':' + String(minute % 60).padStart(2, '0');
    let at;
    try { at = X.localInstant(query.date + 'T' + time, p.timezone); A.slot(at, p); } catch (error) { if ((error.errorCode || error.code) === 'VALIDATION_ERROR') continue; throw error; }
    const count = await M.Booking.countDocuments({ storeId: store._id, status: { $in: ['HELD', 'CONFIRMED', 'PREPARING', 'READY', 'OUT'] },
      $and: [{ $or: [{ 'schedule.pickupAt': at }, { 'schedule.returnDueAt': at },
        { 'trial.at': { $lte: at }, 'trial.until': { $gt: at }, 'trial.status': { $in: ['SCHEDULED', 'ATTENDED'] } },
        { 'trial.at': at, 'trial.status': { $exists: false } }] }, { $or: [{ status: { $ne: 'HELD' } }, { expiresAt: { $gt: new Date() } }] }] });
    rows.push({ at, time, capacityLeft: Math.max(0, p.slotCapacity - count), available: count < p.slotCapacity && +at >= Date.now() + (counter ? -15 * 60000 : p.minimumLeadHours * A.HOUR) && +at <= Date.now() + p.maximumAdvanceDays * A.DAY });
  }
  return { timezone: p.timezone, rows, note: 'Shop capacity only; outfit availability is checked separately.' };
}
function waitlistView(row) {
  const { fingerprint, customer, operationId, ...value } = row.toObject ? row.toObject() : { ...row };
  return value;
}
async function joinWaitlist(store, input, user) {
  A.operation(input.operationId);
  if (!user?.isPhoneVerified || user.offlineSession || input.consent !== true) fail('Sign in with a verified phone and explicitly request availability updates.', 'FORBIDDEN');
  return S().transaction(store, async session => {
    const old = await M.Waitlist.findOne({ storeId: store._id, userId: user._id, operationId: input.operationId }).session(session);
    if (old) { if (old.fingerprint !== X.fingerprint(input)) fail('This waitlist attempt belongs to different details.'); return waitlistView(old); }
    const config = await S().readConfiguration(store);
    if (!config.policy.waitlistEnabled || config.mode === 'SALE_ONLY') fail('This store is not accepting rental waitlist requests.', 'CHECKOUT_RESTRICTED');
    await require('./customerAccessService').assertCustomerCanCheckout({ storeId: store._id, userId: user._id });
    const dates = A.schedule(input, config.policy);
    if (!Array.isArray(input.items) || !input.items.length || input.items.length > 10) fail('Choose 1–10 rental offers.');
    const items = input.items.map(item => ({ listingId: A.id(item.listingId), quantity: A.integer(item.quantity, 'quantity', 1, 10) }));
    if (new Set(items.map(i => i.listingId)).size !== items.length) fail('Combine duplicate waitlist offers.');
    for (const item of items) {
      const listing = await M.Listing.findOne({ storeId: store._id, _id: item.listingId, active: true }).session(session).lean();
      if (!listing) fail('Choose an active rental offer from this store.', 'NOT_FOUND');
      await S().publicListings(store, String(listing.productId));
    }
    if (!config.policy.deliveryModes.includes(input.deliveryMode || 'STORE_PICKUP')) fail('Choose an enabled rental delivery method.');
    const existing = await M.Waitlist.find({ storeId: store._id, userId: user._id, status: { $in: ['WAITING', 'NOTIFIED'] } }).session(session).lean();
    if (existing.some(row => +new Date(row.schedule.pickupAt) === +dates.pickupAt && +new Date(row.schedule.returnDueAt) === +dates.returnDueAt && X.fingerprint(row.items.map(i => [String(i.listingId), i.quantity]).sort()) === X.fingerprint(items.map(i => [i.listingId, i.quantity]).sort()))) fail('You already have an active waitlist request for these items and dates.');
    if (existing.length >= 5) fail('Keep at most five active rental waitlist requests.');
    const email = A.text(input.email || user.email || '', 254);
    if (email && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) fail('Enter a valid email for availability updates.');
    const row = new M.Waitlist({ storeId: store._id, userId: user._id, operationId: input.operationId, fingerprint: X.fingerprint(input),
      items, schedule: dates, deliveryMode: input.deliveryMode || 'STORE_PICKUP', consentAt: new Date(),
      customer: { name: user.name || 'Customer', phone: user.phone, email: input.emailConsent === true ? email : '', whatsappConsent: input.whatsappConsent === true } });
    await row.save({ session }); return waitlistView(row);
  });
}
async function listWaitlist(store, query, userId) {
  const page = A.integer(Number(query.page || 1), 'page', 1, 10000), filter = { storeId: store._id, ...(userId ? { userId } : {}) };
  const [rows, total] = await Promise.all([M.Waitlist.find(filter).sort('-createdAt').skip((page - 1) * 30).limit(30).lean(), M.Waitlist.countDocuments(filter)]);
  const offers = await M.Listing.find({ storeId: store._id, _id: { $in: rows.flatMap(row => row.items.map(i => i.listingId)) } }).select('_id title').lean();
  const names = new Map(offers.map(o => [String(o._id), o.title]));
  return { rows: rows.map(row => ({ ...waitlistView(row), items: row.items.map(i => ({ ...i, title: names.get(String(i.listingId)) || 'Unavailable offer' })) })), page, pages: Math.ceil(total / 30), total };
}
async function cancelWaitlist(store, waitlistId, input, userId) {
  return S().transaction(store, async session => {
    const row = await M.Waitlist.findOne({ storeId: store._id, _id: A.id(waitlistId), userId }).session(session);
    if (!row) fail('Waitlist request not found.', 'NOT_FOUND');
    if (row.status === 'CANCELLED') return waitlistView(row);
    if (row.revision !== input.revision || !['WAITING', 'NOTIFIED'].includes(row.status)) fail('Reload this waitlist request before cancelling.');
    row.status = 'CANCELLED'; row.revision += 1; await row.save({ session }); return waitlistView(row);
  });
}
async function getWaitlist(store, waitlistId, userId) {
  const row = await M.Waitlist.findOne({ storeId: store._id, _id: A.id(waitlistId), userId }).lean();
  if (!row) fail('Waitlist request not found.', 'NOT_FOUND');
  return waitlistView(row);
}
module.exports = { availability, alternatives, slots, joinWaitlist, listWaitlist, cancelWaitlist, getWaitlist, waitlistView };
