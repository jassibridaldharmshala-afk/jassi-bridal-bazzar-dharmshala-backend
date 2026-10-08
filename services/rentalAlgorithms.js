const { ApiError } = require('../utils/apiError');
const crypto = require('node:crypto');
const DAY = 86400000;
const HOUR = 3600000;
const MODES = ['SALE_ONLY', 'RENTAL_ONLY', 'SALE_AND_RENTAL'];
const DEFAULT_POLICY = Object.freeze({
  timezone: 'Asia/Kolkata', holdMinutes: 10, preparationHours: 24, cleaningHours: 24,
  minimumDays: 1, maximumDays: 30, advancePercent: 30, graceHours: 2,
  advanceMode: 'PERCENT', advanceAmountPaise: 10000, depositTiming: 'BOOKING',
  requireConditionPhotos: false, requireCustomerAcknowledgement: false,
  rentalTaxBasisPoints: 0, rentalServiceCode: '', noShowGraceHours: 24,
  noShowRetainPercent: 100, earlyReturnPolicy: 'AGREED_PERIOD', courierIntegrationEnabled: false,
  minimumLeadHours: 24, maximumAdvanceDays: 180, balanceDueHours: 24,
  lateFeePerDayPaise: 0, pickupStart: '10:00', pickupEnd: '18:00', slotMinutes: 60,
  slotCapacity: 5, closedWeekdays: [], closedDates: [],
  deliveryModes: ['STORE_PICKUP'], deliveryFeePaise: 0, returnFeePaise: 0,
  cancellationRules: [{ beforeHours: 72, retainPercent: 0 }, { beforeHours: 0, retainPercent: 100 }],
  faqs: [],
  terms: 'Return every component by the agreed deadline. Deposit settlement follows inspection. No charge is deducted without an itemised assessment.',
  ownerEmail: false, ownerWhatsapp: false, customerEmail: false, customerWhatsapp: false,
  whatsappTemplate: '', whatsappLanguage: 'en',
  trialMinutes: 60, trialReminderHours: 24,
  measurementProfilesEnabled: false, tailoringEnabled: false, maintenanceTasksEnabled: false,
  dateFirstEnabled: false, refundDashboardEnabled: false, piecePerformanceEnabled: false, waitlistEnabled: false,
  refundSlaHours: 72,
});
function invalid(message) { throw new ApiError('VALIDATION_ERROR', message); }
function integer(value, label, min = 0, max = 100000000) {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(`Enter a valid ${label}.`);
  return value;
}
function text(value, max = 500) {
  if (typeof value !== 'string' || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) invalid('Text is invalid or too long.');
  return value.trim();
}
function id(value) { if (!/^[a-f\d]{24}$/i.test(String(value || ''))) invalid('A valid record ID is required.'); return String(value); }
function operation(value) { if (!/^[A-Za-z0-9_-]{10,100}$/.test(value || '')) invalid('A unique operation ID is required.'); return value; }
function date(value) {
  // Require an explicit offset: a browser's local timezone must not decide a booking.
  if (typeof value !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) invalid('Use an ISO date and time including its timezone.');
  const day = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) || new Date(day + 'T12:00Z').toISOString().slice(0, 10) !== day) invalid('Choose a real calendar date.');
  return new Date(value);
}
function localParts(value, timezone) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(value).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
}
function localKey(value, timezone) { const p = localParts(value, timezone); return `${p.year}-${p.month}-${p.day}`; }
function timeMinutes(value) { if (!/^\d{2}:\d{2}$/.test(value || '')) invalid('Use HH:MM for shop hours.'); const [h, m] = value.split(':').map(Number); if (h > 23 || m > 59) invalid('Shop hours are invalid.'); return h * 60 + m; }
function validatePolicy(input = {}, { existing = false } = {}) {
  if (!input || Array.isArray(input) || typeof input !== 'object') invalid('Rental policy is invalid.');
  if (Object.keys(input).some(k => !(k in DEFAULT_POLICY))) invalid('Unsupported rental policy setting.');
  const p = { ...DEFAULT_POLICY, ...input };
  if (!['PERCENT', 'FIXED'].includes(p.advanceMode)) invalid('Choose percentage or fixed booking advance.');
  if (!['BOOKING', 'PICKUP'].includes(p.depositTiming)) invalid('Choose when the security deposit is collected.');
  if (!['AGREED_PERIOD', 'ACTUAL_DAYS'].includes(p.earlyReturnPolicy)) invalid('Choose an early return policy.');
  integer(p.advanceAmountPaise, 'fixed advance', 1);
  if (!existing && p.advancePercent < 1) invalid('A positive booking advance is compulsory.');
  integer(p.rentalTaxBasisPoints, 'rental tax rate', 0, 10000);
  integer(p.noShowGraceHours, 'no-show grace hours', 0, 168);
  integer(p.noShowRetainPercent, 'no-show retention', 0, 100);
  p.rentalServiceCode = text(p.rentalServiceCode, 30);
  for (const key of ['requireConditionPhotos', 'requireCustomerAcknowledgement', 'courierIntegrationEnabled']) if (typeof p[key] !== 'boolean') invalid('Choose valid rental safety settings.');
  for (const key of ['measurementProfilesEnabled', 'tailoringEnabled', 'maintenanceTasksEnabled', 'dateFirstEnabled', 'refundDashboardEnabled', 'piecePerformanceEnabled', 'waitlistEnabled']) if (typeof p[key] !== 'boolean') invalid('Choose valid studio feature switches.');
  integer(p.trialMinutes, 'trial duration', 15, 240);
  integer(p.trialReminderHours, 'trial reminder hours', 1, 168);
  integer(p.refundSlaHours, 'deposit refund deadline hours', 1, 720);
  try { new Intl.DateTimeFormat('en', { timeZone: p.timezone }).format(new Date()); } catch { invalid('Choose a valid store timezone.'); }
  for (const [k, min, max] of [['holdMinutes', 2, 30], ['preparationHours', 0, 168], ['cleaningHours', 0, 168], ['minimumDays', 1, 90], ['maximumDays', 1, 90], ['advancePercent', 0, 100], ['graceHours', 0, 72], ['minimumLeadHours', 0, 720], ['maximumAdvanceDays', 1, 365], ['balanceDueHours', 0, 720], ['slotMinutes', 15, 240], ['slotCapacity', 1, 100], ['lateFeePerDayPaise', 0, 10000000], ['deliveryFeePaise', 0, 10000000], ['returnFeePaise', 0, 10000000]]) integer(p[k], k, min, max);
  if (p.maximumDays < p.minimumDays) invalid('Maximum duration must be at least the minimum duration.');
  if (timeMinutes(p.pickupEnd) <= timeMinutes(p.pickupStart)) invalid('Shop closing time must be after opening time.');
  if (!Array.isArray(p.closedWeekdays) || p.closedWeekdays.length > 7 || p.closedWeekdays.some(d => !Number.isInteger(d) || d < 0 || d > 6)) invalid('Choose valid closed weekdays.');
  if (!Array.isArray(p.closedDates) || p.closedDates.length > 366 || p.closedDates.some(d => !/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(Date.parse(`${d}T12:00:00Z`)) || new Date(`${d}T12:00:00Z`).toISOString().slice(0, 10) !== d)) invalid('Choose valid holiday dates.');
  if (!Array.isArray(p.deliveryModes) || !p.deliveryModes.length || p.deliveryModes.some(v => !['STORE_PICKUP', 'SELF_DELIVERY', 'COURIER'].includes(v))) invalid('Choose rental delivery methods.');
  if (!Array.isArray(p.cancellationRules) || !p.cancellationRules.length || p.cancellationRules.length > 10) invalid('Add cancellation rules.');
  p.cancellationRules = p.cancellationRules.map(rule => { if (!rule || typeof rule !== 'object') invalid('Cancellation rule is invalid.'); return { beforeHours: integer(rule.beforeHours, 'cancellation hours', 0, 8760), retainPercent: integer(rule.retainPercent, 'retained percentage', 0, 100) }; }).sort((a, b) => b.beforeHours - a.beforeHours);
  if (!p.cancellationRules.some(r => r.beforeHours === 0)) invalid('Include a cancellation rule for zero hours notice.');
  if (!Array.isArray(p.faqs) || p.faqs.length > 20) invalid('Add up to 20 rental FAQs.');
  p.faqs = p.faqs.map(row => { if (!row || typeof row !== 'object') invalid('Enter a rental FAQ question and answer.'); const question = text(row.question, 200), answer = text(row.answer, 2000); if (!question || !answer) invalid('Complete each rental FAQ question and answer.'); return { question, answer }; });
  p.terms = text(p.terms, 5000); if (!p.terms) invalid('Rental terms are required.');
  for (const key of ['ownerEmail', 'ownerWhatsapp', 'customerEmail', 'customerWhatsapp']) if (typeof p[key] !== 'boolean') invalid('Choose valid notification switches.');
  p.whatsappTemplate = text(p.whatsappTemplate, 100); p.whatsappLanguage = text(p.whatsappLanguage, 10);
  if ((p.ownerWhatsapp || p.customerWhatsapp) && (!/^[a-z0-9_]{1,100}$/.test(p.whatsappTemplate) || !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(p.whatsappLanguage))) invalid('WhatsApp rental reminders need their own approved template and language.');
  return JSON.parse(JSON.stringify(p));
}
function slot(value, policy) {
  const parts = localParts(value, policy.timezone);
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  if (policy.closedWeekdays.includes(weekday) || policy.closedDates.includes(localKey(value, policy.timezone))) invalid('The store is closed on the selected date.');
  if (minutes < timeMinutes(policy.pickupStart) || minutes >= timeMinutes(policy.pickupEnd) || (minutes - timeMinutes(policy.pickupStart)) % policy.slotMinutes || value.getUTCSeconds() || value.getUTCMilliseconds()) invalid('Choose an available shop time slot.');
}
function schedule(input, policy, now = new Date(), { existing = false, allowImmediate = false } = {}) {
  const pickupAt = date(input.pickupAt), returnDueAt = date(input.returnDueAt);
  if (+returnDueAt <= +pickupAt) invalid('Return must be after pickup.');
  const days = Math.ceil((+returnDueAt - +pickupAt) / DAY);
  if (days < policy.minimumDays || days > policy.maximumDays) invalid(`Rentals must be ${policy.minimumDays}–${policy.maximumDays} days.`);
  if (!existing && (+pickupAt < +now + (allowImmediate ? -15 * 60000 : policy.minimumLeadHours * HOUR) || +pickupAt > +now + policy.maximumAdvanceDays * DAY)) invalid('Pickup is outside the allowed booking window.');
  slot(pickupAt, policy); slot(returnDueAt, policy);
  const eventAt = input.eventAt ? date(input.eventAt) : null;
  if (eventAt && (+eventAt < +pickupAt || +eventAt > +returnDueAt)) invalid('The event must fall within your rental period.');
  return { pickupAt, returnDueAt, eventAt, days, blockedFrom: new Date(+pickupAt - policy.preparationHours * HOUR), blockedUntil: new Date(+returnDueAt + policy.cleaningHours * HOUR), balanceDueAt: new Date(+pickupAt - policy.balanceDueHours * HOUR) };
}
function overlaps(a, b) { return +a.blockedFrom < +b.blockedUntil && +b.blockedFrom < +a.blockedUntil; }
function quoteFingerprint(storeId, data) {
  return crypto.createHash('sha256').update(JSON.stringify({ storeId: String(storeId), quote: data.quote, schedule: data.schedule, policyRevision: data.policyRevision })).digest('hex');
}
function advanceRules(input) {
  const advanceMode = input.advanceMode || 'STORE';
  if (!['STORE', 'PERCENT', 'FIXED'].includes(advanceMode)) invalid('Choose store default, percentage or fixed rental advance.');
  return { advanceMode, ...(advanceMode === 'PERCENT' ? { advancePercent: integer(input.advancePercent, 'rental advance percentage', 1, 100) } : {}), ...(advanceMode === 'FIXED' ? { advanceAmountPaise: integer(input.advanceAmountPaise, 'rental advance amount', 1) } : {}) };
}
function listingRules(input) {
  const dailyRatePaise = integer(input.dailyRatePaise, 'daily rate', 1), depositPaise = integer(input.depositPaise, 'security deposit');
  if (input.packages !== undefined && (!Array.isArray(input.packages) || input.packages.some(p => !p || typeof p !== 'object'))) invalid('Use a valid list of rental packages.');
  const packages = (input.packages || []).map(p => ({ days: integer(p.days, 'package days', 1, 90), pricePaise: integer(p.pricePaise, 'package price', 1) }));
  if (packages.length > 10 || new Set(packages.map(p => p.days)).size !== packages.length) invalid('Use unique rental packages (maximum 10).');
  return { dailyRatePaise, depositPaise, packages, cleaningFeePaise: integer(input.cleaningFeePaise || 0, 'cleaning fee'), alterationFeePaise: integer(input.alterationFeePaise || 0, 'alteration fee'), ...advanceRules(input) };
}
function quote(lines, dates, policy, deliveryMode) {
  if (!policy.deliveryModes.includes(deliveryMode)) invalid('This delivery method is unavailable.');
  const items = lines.map(({ listing, quantity }) => {
    integer(quantity, 'quantity', 1, 10);
    const pack = (listing.packages || []).find(p => p.days === dates.days);
    const rentPaise = (pack ? pack.pricePaise : listing.dailyRatePaise * dates.days) * quantity;
    const depositPaise = listing.depositPaise * quantity;
    const feesPaise = (listing.cleaningFeePaise + listing.alterationFeePaise) * quantity;
    return { listingId: String(listing._id), productId: String(listing.productId), title: listing.title, quantity, rentPaise, depositPaise, feesPaise, ...(listing.fitting ? { fitting: { ...listing.fitting } } : {}), components: listing.components || (listing.requirements || []).map(r => ({ label: r.label, quantity: r.quantity * quantity })), rules: listingRules(listing) };
  });
  const rentalPaise = items.reduce((n, i) => n + i.rentPaise + i.feesPaise, 0) + (deliveryMode === 'STORE_PICKUP' ? 0 : policy.deliveryFeePaise + policy.returnFeePaise);
  const depositPaise = items.reduce((n, i) => n + i.depositPaise, 0);
  const hasOverrides = items.some(i => i.rules.advanceMode !== 'STORE');
  const advanceFor = (amount, rules, quantity = 1) => rules.advanceMode === 'FIXED' ? Math.min(amount, rules.advanceAmountPaise * quantity) : Math.ceil(amount * rules.advancePercent / 100);
  const deliveryPaise = rentalPaise - items.reduce((n, i) => n + i.rentPaise + i.feesPaise, 0);
  const storePolicyPaise = deliveryPaise + items.filter(i => i.rules.advanceMode === 'STORE').reduce((n, i) => n + i.rentPaise + i.feesPaise, 0);
  const advanceRentPaise = hasOverrides
    ? items.filter(i => i.rules.advanceMode !== 'STORE').reduce((n, i) => n + advanceFor(i.rentPaise + i.feesPaise, i.rules, i.quantity), 0) + advanceFor(storePolicyPaise, policy)
    : advanceFor(rentalPaise, policy);
  const depositDueNowPaise = policy.depositTiming === 'PICKUP' ? 0 : depositPaise;
  const totalPaise = rentalPaise + depositPaise;
  integer(totalPaise, 'booking total', 1, 100000000);
  const taxPaise = Math.round(rentalPaise * (policy.rentalTaxBasisPoints || 0) / (10000 + (policy.rentalTaxBasisPoints || 0)));
  return { items, rentalPaise, depositPaise, totalPaise, advanceRentPaise, advanceMode: hasOverrides ? 'PER_ITEM' : policy.advanceMode || 'PERCENT', depositTiming: policy.depositTiming || 'BOOKING', depositDueNowPaise, dueNowPaise: advanceRentPaise + depositDueNowPaise, remainingPaise: totalPaise - advanceRentPaise - depositDueNowPaise, tax: { basisPoints: policy.rentalTaxBasisPoints || 0, taxablePaise: rentalPaise - taxPaise, taxPaise, serviceCode: policy.rentalServiceCode || '', priceMode: 'INCLUSIVE' }, deliveryMode, deliveryFeePaise: deliveryMode === 'STORE_PICKUP' ? 0 : policy.deliveryFeePaise, returnFeePaise: deliveryMode === 'STORE_PICKUP' ? 0 : policy.returnFeePaise, currency: 'INR', pricesIncludeApplicableTaxes: true };
}
function finances(booking) {
  const entries = booking.ledger || [];
  const collectedPaise = entries.filter(e => e.kind === 'COLLECTION').reduce((n, e) => n + e.amountPaise, 0);
  const reservedRefundPaise = entries.filter(e => e.kind === 'REFUND' && e.status !== 'FAILED').reduce((n, e) => n + e.amountPaise, 0);
  const refundedPaise = entries.filter(e => e.kind === 'REFUND' && e.status === 'PROCESSED').reduce((n, e) => n + e.amountPaise, 0);
  const rentalPaise = booking.adjustedRentalPaise ?? booking.quote.rentalPaise;
  const deductionsPaise = (booking.assessments || []).filter(a => a.approved).reduce((n, a) => n + a.amountPaise, 0);
  const completed = ['RETURNED', 'CANCELLED', 'EXPIRED', 'CLOSED'].includes(booking.status);
  const requiredPaise = rentalPaise + (completed ? deductionsPaise : Math.max(booking.quote.depositPaise, deductionsPaise));
  const refundEntitlementPaise = Math.max(0, collectedPaise - requiredPaise);
  const depositHeldPaise = completed || booking.quote.depositTiming === 'PICKUP' ? Math.max(0, Math.min(booking.quote.depositPaise, collectedPaise - refundedPaise - rentalPaise - deductionsPaise)) : Math.max(0, Math.min(booking.quote.depositPaise, collectedPaise - refundedPaise) - deductionsPaise);
  return { collectedPaise, refundedPaise, reservedRefundPaise, rentalPaise, deductionsPaise, balancePaise: Math.max(0, requiredPaise - collectedPaise + reservedRefundPaise), refundablePaise: Math.max(0, refundEntitlementPaise - reservedRefundPaise), depositHeldPaise };
}
function cancellationRent(booking, now = new Date(), ownerFault = false) {
  if (ownerFault) return 0;
  const hours = Math.max(0, (+booking.schedule.pickupAt - +now) / HOUR);
  const rule = booking.policy.cancellationRules.find(r => hours >= r.beforeHours);
  return Math.ceil(booking.quote.rentalPaise * (rule?.retainPercent ?? 100) / 100);
}
function paidRent(booking) {
  const f = finances(booking);
  return Math.max(0, Math.min(booking.quote.rentalPaise, f.collectedPaise - f.refundedPaise - (booking.quote.depositTiming === 'PICKUP' ? 0 : booking.quote.depositPaise)));
}
function lateEstimate(booking, now = new Date()) {
  const late = Math.max(0, +now - +booking.schedule.returnDueAt - booking.policy.graceHours * HOUR);
  return Math.ceil(late / DAY) * booking.policy.lateFeePerDayPaise;
}
module.exports = { DAY, HOUR, MODES, DEFAULT_POLICY, integer, text, id, operation, date, localKey, slot, schedule, overlaps, quoteFingerprint, validatePolicy, advanceRules, listingRules, quote, finances, cancellationRent, paidRent, lateEstimate };
