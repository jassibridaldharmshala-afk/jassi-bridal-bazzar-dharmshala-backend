const crypto = require('node:crypto');
const M = require('../models/Rental');
const S = require('./rentalService');
const A = require('./rentalAlgorithms');
const Store = require('../models/Store');
const StoreMember = require('../models/StoreMember');
const User = require('../models/User');
const Notification = require('../models/Notification');
const ProviderConfiguration = require('../models/OrderAlertConfiguration');
const providers = require('./orderAlertProviders');
let timer; let running = false;
const reminderEvents = ['BALANCE_DUE', 'PICKUP_DUE', 'RETURN_DUE', 'OVERDUE'];
function title(event) { return ({ CONFIRMED: 'Rental booking confirmed', PAYMENT_RECEIVED: 'Rental payment received', LATE_PAYMENT_REVIEW: 'Late rental payment needs review', CUSTOMER_REQUEST: 'Rental request needs review', BALANCE_DUE: 'Rental balance payment due', PICKUP_DUE: 'Rental pickup is approaching', RETURN_DUE: 'Rental return is approaching', OVERDUE: 'Rental return is overdue', RECEIVE: 'Rental return received', REFUND_PROCESSED: 'Rental refund processed', REFUND_ATTENTION: 'Rental refund needs attention' })[event] || `Rental ${event.toLowerCase().replace(/_/g, ' ')}`; }
function message(booking, event) {
  if (booking.studioMessage) return booking.studioMessage;
  if (event === 'TRIAL_DUE') return booking.number + ': Trial / fitting is approaching at ' + new Intl.DateTimeFormat('en-IN', { timeZone: booking.policy.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(booking.trial.at)) + '. Review your appointment in My rentals.';
  if (event === 'REFUND_OVERDUE') return booking.number + ': Deposit/refund settlement is overdue. Review inspection, disputes and the original payment refund status; no automatic deduction or refund has been made.';
  const fmt = value => new Intl.DateTimeFormat('en-IN', { timeZone: booking.policy.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  return `${booking.number}: ${title(event)}. Pickup ${fmt(booking.schedule.pickupAt)}; return by ${fmt(booking.schedule.returnDueAt)} (${booking.policy.timezone}). Open your rental workspace for the current details.`;
}
async function reminders(store) {
  const now = Date.now();
  const rows = M.Booking.find({ storeId: store._id, status: { $in: ['CONFIRMED', 'PREPARING', 'READY', 'OUT'] }, $or: [{ 'schedule.balanceDueAt': { $lte: new Date(now) } }, { 'schedule.pickupAt': { $lte: new Date(now + A.DAY) } }, { 'schedule.returnDueAt': { $lte: new Date(now + A.DAY) } }] }).lean().cursor();
  for await (const b of rows) {
    const key = A.localKey(new Date(), b.policy.timezone);
    const events = [];
    if (A.finances(b).balancePaise && +b.schedule.balanceDueAt <= now) events.push('BALANCE_DUE');
    if (b.status !== 'OUT' && +b.schedule.pickupAt <= now + A.DAY) events.push('PICKUP_DUE');
    if (b.status === 'OUT' && +b.schedule.returnDueAt <= now + A.DAY) events.push(+b.schedule.returnDueAt < now ? 'OVERDUE' : 'RETURN_DUE');
    for (const e of events) await S.enqueue(b, e, undefined, `${key}:${+b.schedule.returnDueAt}:${+b.schedule.pickupAt}`);
    if (events.includes('OVERDUE')) {
      const affected = await M.Reservation.find({ storeId: store._id, active: true, assetId: { $in: b.allocations.filter(a => !a.receivedAt).map(a => a.assetId) }, bookingId: { $ne: b._id, $exists: true }, blockedFrom: { $lte: new Date(now + 7 * A.DAY) }, blockedUntil: { $gt: new Date(now) } }).distinct('bookingId');
      for (const bookingId of affected.slice(0, 50)) {
        const next = await M.Booking.findOne({ _id: bookingId, storeId: store._id, status: { $in: ['CONFIRMED', 'PREPARING', 'READY'] } }).lean();
        if (next) await S.enqueue(next, 'PIECE_DELAY_REVIEW', undefined, `${b._id}:${key}`);
      }
    }
  }
}
async function deliver(job) {
  const store = await Store.findById(job.storeId).lean();
  if (!store) return { skipped: 'Store is no longer available.' };
  const booking = job.taskId || job.waitlistId ? await require('./rentalStudioWorker').context(job, store) : await M.Booking.findOne({ _id: job.bookingId, storeId: job.storeId }).lean();
  if (!booking || !store) return { skipped: 'Booking/store is no longer available.' };
  if (reminderEvents.includes(job.event) && !['CONFIRMED', 'PREPARING', 'READY', 'OUT'].includes(booking.status)) return { skipped: 'Reminder is no longer relevant.' };
  const now = Date.now();
  if (job.event === 'TRIAL_DUE' && (!['HELD', 'CONFIRMED', 'PREPARING', 'READY'].includes(booking.status) || booking.trial?.status !== 'SCHEDULED' || +new Date(booking.trial.at) <= now || (job.reminderTrialAt && +new Date(job.reminderTrialAt) !== +new Date(booking.trial.at)) || (booking.status === 'HELD' && +new Date(booking.expiresAt) <= now))) return { skipped: 'Trial reminder is no longer relevant.' };
  if (job.event === 'REFUND_OVERDUE' && !require('./rentalStudioAlgorithms').refundPosition(booking).overdue) return { skipped: 'Refund deadline is no longer outstanding.' };
  if (job.event === 'REFUND_OVERDUE' && !(await S.readConfiguration(store)).policy.refundDashboardEnabled) return { skipped: 'Refund deadline monitoring is disabled.' };
  if (reminderEvents.includes(job.event)) {
    for (const [saved, current] of [['reminderPickupAt', 'pickupAt'], ['reminderReturnDueAt', 'returnDueAt'], ['reminderBalanceDueAt', 'balanceDueAt']]) {
      if (job[saved] && +new Date(job[saved]) !== +new Date(booking.schedule[current])) return { skipped: 'Booking dates changed after this reminder was queued.' };
    }
    if (job.event === 'PICKUP_DUE' && (booking.status === 'OUT' || +new Date(booking.schedule.pickupAt) > now + A.DAY)) return { skipped: 'Pickup is no longer due.' };
    if (job.event === 'RETURN_DUE' && (+new Date(booking.schedule.returnDueAt) <= now || +new Date(booking.schedule.returnDueAt) > now + A.DAY)) return { skipped: 'Return reminder is no longer due.' };
    if (job.event === 'OVERDUE' && +new Date(booking.schedule.returnDueAt) >= now) return { skipped: 'Return is no longer overdue.' };
    if (job.event === 'BALANCE_DUE' && +new Date(booking.schedule.balanceDueAt) > now) return { skipped: 'Balance due date changed.' };
  }
  if (job.event === 'BALANCE_DUE' && !A.finances(booking).balancePaise) return { skipped: 'Balance already paid.' };
  if (['RETURN_DUE', 'OVERDUE'].includes(job.event) && booking.status !== 'OUT') return { skipped: 'Return already received.' };
  const body = message(booking, job.event);
  if (job.channel === 'IN_APP') {
    let recipients = job.audience === 'CUSTOMER' ? [booking.userId].filter(Boolean) : (await StoreMember.find({ store: store._id, status: 'ACTIVE', role: { $in: ['OWNER', 'MANAGER', 'ORDER_MANAGER', 'WAREHOUSE'] } }).select('user').lean()).map(m => m.user);
    if (job.audience === 'OWNER') {
      if (store.owner) recipients.push(store.owner);
      if (store.isDefault) recipients.push(...(await User.find({ role: 'admin', isBlocked: { $ne: true } }).select('_id').lean()).map(u => u._id));
    }
    for (const userId of [...new Set(recipients.map(String))]) {
      const dedupeKey = `${job.dedupeKey}:${userId}`;
      await Notification.updateOne({ dedupeKey }, { $setOnInsert: { dedupeKey, user: userId, storeId: store._id, audience: job.audience === 'OWNER' ? 'ADMIN' : 'CUSTOMER', event: `RENTAL_${job.event}`, title: title(job.event), message: body, channel: 'IN_APP', status: 'SENT', metadata: booking.notificationMetadata || { rentalBookingId: String(booking._id), ...(!store.isDefault && job.audience === 'CUSTOMER' ? { storeSlug: store.slug } : {}) } } }, { upsert: true });
    }
    return { messageId: 'in-app' };
  }
  const configuration = await S.readConfiguration(store);
  const switchKey = `${job.audience === 'OWNER' ? 'owner' : 'customer'}${job.channel === 'EMAIL' ? 'Email' : 'Whatsapp'}`;
  if (!configuration.policy[switchKey]) return { skipped: 'This rental notification channel is disabled.' };
  const provider = await ProviderConfiguration.findOne({ storeId: store._id }).select('+email.apiKey +whatsapp.accessToken').lean();
  if (!provider?.storefrontUrl) throw new Error('Configure encrypted provider credentials and storefront URL in Order alerts.');
  const recipient = job.audience === 'OWNER' ? job.channel === 'EMAIL' ? provider.email?.recipient : provider.whatsapp?.recipient : job.channel === 'EMAIL' ? booking.customer.email : booking.customer.phone;
  if (!recipient || (job.channel === 'WHATSAPP' && !(job.audience === 'OWNER' ? provider.whatsapp?.consent : booking.customer.whatsappConsent))) return { skipped: 'Recipient or WhatsApp consent is missing.' };
  const url = new URL(provider.storefrontUrl); if (url.protocol !== 'https:') throw new Error('A secure storefront URL is required.');
  url.pathname = booking.studioPath || (job.audience === 'OWNER' ? store.isDefault ? '/admin/rentals' : '/seller/rentals' : store.isDefault ? '/rentals' : `/store/${encodeURIComponent(store.slug)}/rentals`);
  url.search = booking.studioSearch || `?id=${booking._id}`;
  if (job.audience === 'OWNER' && !store.isDefault) url.searchParams.set('storeId', String(store._id));
  url.hash = '';
  const amount = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(booking.quote.totalPaise / 100);
  return providers.deliver(job.channel, { ...provider, whatsapp: { ...provider.whatsapp, templateName: configuration.policy.whatsappTemplate, language: configuration.policy.whatsappLanguage } }, recipient, { rental: true, title: title(job.event), body, storeName: store.name, number: booking.number, amount, payment: title(job.event), link: url.toString(), itemCount: booking.quote.items.length });
}
async function reconcileRefunds(store) {
  return S.reconcileRefunds(store);
}
async function tick() {
  if (running) return; running = true;
  try {
    await S.ensureIndexes(); await Notification.init();
    const ids = await M.Configuration.distinct('storeId');
    for (const storeId of ids) {
      const store = await Store.findById(storeId).lean(); if (!store) continue;
      try { await S.expireHolds(store); await reminders(store); await require('./rentalStudioWorker').reminders(store); await require('./rentalCourierService').recoverInterrupted(store); } catch { console.warn('Rental availability/reminders need review; existing records are preserved.'); }
      if (!(process.env.NODE_ENV === 'test' && process.env.RAZORPAY_MOCK === '1')) {
        await S.reconcilePayments(store).catch(() => {});
        await reconcileRefunds(store).catch(() => {});
        await require('./rentalCourierService').syncDue(store).catch(() => {});
      }
    }
    await M.Job.updateMany({ status: 'SENDING', leaseUntil: { $lte: new Date() } }, { $set: { status: 'UNCERTAIN', reason: 'Sending was interrupted. Check the provider before retrying.' } });
    const jobs = await M.Job.find({ status: 'PENDING', nextAttemptAt: { $lte: new Date() } }).sort('nextAttemptAt').limit(100).lean();
    for (const candidate of jobs) {
      const leaseToken = crypto.randomUUID();
      const job = await M.Job.findOneAndUpdate({ _id: candidate._id, status: 'PENDING' }, { $set: { status: 'SENDING', leaseToken, leaseUntil: new Date(Date.now() + 120000) }, $inc: { attempts: 1 } }, { new: true }).lean();
      if (!job) continue;
      try {
        const result = await deliver(job);
        await M.Job.updateOne({ _id: job._id, leaseToken }, { $set: { status: result.skipped ? 'SKIPPED' : 'ACCEPTED', reason: result.skipped || 'Accepted; external device/inbox delivery is not guaranteed.', providerId: result.messageId || '' }, $unset: { leaseToken: 1, leaseUntil: 1 } });
      } catch (e) {
        const retry = e.retryable && job.attempts < 5;
        await M.Job.updateOne({ _id: job._id, leaseToken }, { $set: { status: retry ? 'PENDING' : e.uncertain ? 'UNCERTAIN' : 'FAILED', reason: String(e.message || 'Rental notification failed.').slice(0, 300), ...(retry ? { nextAttemptAt: new Date(Date.now() + 60000 * 2 ** job.attempts) } : {}) }, $unset: { leaseToken: 1, leaseUntil: 1 } });
      }
    }
  } finally { running = false; }
}
async function retry(storeId, jobId, confirmUncertain) {
  const job = await M.Job.findOne({ _id: A.id(jobId), storeId, status: { $in: ['FAILED', 'UNCERTAIN'] } }).lean();
  if (!job) throw new Error('Retryable rental notification not found.');
  if (job.status === 'UNCERTAIN' && confirmUncertain !== true) throw new Error('Check the provider and confirm before retrying an uncertain send.');
  await M.Job.updateOne({ _id: job._id, status: job.status }, { $set: { status: 'PENDING', nextAttemptAt: new Date(), attempts: 0 } });
  return { success: true };
}
function startWorker() { if (timer || process.env.NODE_ENV === 'test') return stopWorker; tick().catch(() => console.warn('Rental worker unavailable; pending work remains durable.')); timer = setInterval(() => tick().catch(() => console.warn('Rental worker unavailable; pending work remains durable.')), 60000); timer.unref(); return stopWorker; }
function stopWorker() { if (timer) clearInterval(timer); timer = undefined; }
module.exports = { startWorker, stopWorker, tick, reminders, deliver, retry, reconcileRefunds };
