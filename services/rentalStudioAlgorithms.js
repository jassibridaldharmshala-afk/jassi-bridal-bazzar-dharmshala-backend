const crypto = require('node:crypto');
const A = require('./rentalAlgorithms');
const { ApiError } = require('../utils/apiError');
const fail = message => { throw new ApiError('VALIDATION_ERROR', message); };
const MEASUREMENTS = ['bust', 'chest', 'waist', 'hips', 'shoulder', 'sleeve', 'armhole', 'blouseLength', 'outfitLength', 'bottomLength'];
function fingerprint(input) {
  const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' && !(value instanceof Date)
    ? Object.fromEntries(Object.keys(value).sort().filter(key => !['revision', 'operationId'].includes(key)).map(key => [key, stable(value[key])])) : value;
  return crypto.createHash('sha256').update(JSON.stringify(stable(input))).digest('hex');
}
function customerKey(booking) {
  const phone = String(booking.customer?.phone || '').replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '');
  if (!phone) fail('A customer phone is required for measurements.');
  return crypto.createHash('sha256').update(String(booking.storeId) + ':' + phone).digest('hex');
}
function measurementValues(input) {
  if (!['in', 'cm'].includes(input.unit)) fail('Choose inches or centimetres.');
  if (!input.values || typeof input.values !== 'object' || Array.isArray(input.values) || Object.keys(input.values).some(key => !MEASUREMENTS.includes(key))) fail('Choose supported body measurements.');
  const values = {};
  for (const [key, value] of Object.entries(input.values)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > (input.unit === 'in' ? 150 : 380) || Math.abs(Math.round(value * 100) - value * 100) > 0.000001) fail('Measurements must be positive numbers with at most two decimal places.');
    values[key] = value;
  }
  if (!Object.keys(values).length) fail('Enter at least one measurement.');
  return values;
}
function trialWindow(input, policy, now = new Date()) {
  const at = A.date(input.at), minutes = A.integer(input.minutes ?? policy.trialMinutes ?? 60, 'trial minutes', 15, 240);
  const until = new Date(+at + minutes * 60000);
  A.slot(at, policy);
  if (+at < +now || A.localKey(at, policy.timezone) !== A.localKey(new Date(+until - 1), policy.timezone)) fail('Choose a future trial within one shop day.');
  const end = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: policy.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(until).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  const [closingHour, closingMinute] = policy.pickupEnd.split(':').map(Number);
  if (Number(end.hour) * 60 + Number(end.minute) > closingHour * 60 + closingMinute) fail('The trial must finish before the shop closes.');
  return { at, until, minutes };
}
function localInstant(value, timezone) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value || '')) fail('Choose a valid local date/time.');
  const local = instant => Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(instant)).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  const key = instant => { const p = local(instant); return p.year + '-' + p.month + '-' + p.day + 'T' + p.hour + ':' + p.minute; };
  const target = Date.parse(value + ':00Z'); let instant = target;
  for (let i = 0; i < 4; i += 1) instant += target - Date.parse(key(instant) + ':00Z');
  if (key(instant) !== value) fail('This local time is unavailable in the store timezone.');
  return new Date(instant);
}
function refundPosition(b, now = new Date()) {
  const f = A.finances(b);
  const pendingPaise = Math.max(0, f.reservedRefundPaise - f.refundedPaise);
  const terminal = ['RETURNED', 'CANCELLED', 'EXPIRED', 'CLOSED'].includes(b.status);
  const inspectionPending = b.status === 'RETURNED' && b.allocations.some(a => !a.disposition && !a.readyAt);
  const dueAt = b.refundDueAt ? new Date(b.refundDueAt) : null;
  return { refundablePaise: terminal ? f.refundablePaise : 0, pendingPaise, inspectionPending,
    disputePending: (b.requests || []).some(r => r.type === 'DISPUTE' && r.status === 'PENDING'),
    ageHours: b.refundEligibleAt ? Math.max(0, (+now - +new Date(b.refundEligibleAt)) / A.HOUR) : 0,
    overdue: !!dueAt && +dueAt < +now && f.refundablePaise + pendingPaise > 0, dueAt };
}
function intervalHours(intervals, from, to) {
  const windows = intervals.map(([start, end]) => [Math.max(+new Date(start), +from), Math.min(+new Date(end), +to)]).filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  let hours = 0, start, end;
  for (const [s, e] of windows) {
    if (start === undefined) { start = s; end = e; }
    else if (s <= end) end = Math.max(end, e);
    else { hours += (end - start) / A.HOUR; start = s; end = e; }
  }
  return hours + (start === undefined ? 0 : (end - start) / A.HOUR);
}
function distribute(amount, weights) {
  const total = weights.reduce((sum, n) => sum + n, 0);
  if (!total || !amount) return weights.map(() => 0);
  const rows = weights.map((weight, index) => ({ index, amount: Math.floor(amount * weight / total), fraction: amount * weight / total % 1 }));
  let remainder = amount - rows.reduce((sum, row) => sum + row.amount, 0);
  for (const row of [...rows].sort((a, b) => b.fraction - a.fraction || a.index - b.index)) if (remainder-- > 0) row.amount += 1;
  return rows.map(row => row.amount);
}
module.exports = { MEASUREMENTS, fingerprint, customerKey, measurementValues, trialWindow, localInstant, refundPosition, intervalHours, distribute };
