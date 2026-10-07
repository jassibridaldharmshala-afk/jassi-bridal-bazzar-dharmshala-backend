const M = require('../models/Rental');
const A = require('./rentalAlgorithms');
const X = require('./rentalStudioAlgorithms');
const S = () => require('./rentalService');
async function entityJob(store, entity, event, audiences, token, fields) {
  for (const audience of audiences) for (const channel of ['IN_APP', 'EMAIL', 'WHATSAPP']) {
    const dedupeKey = String(entity._id) + ':' + event + ':' + token + ':' + audience + ':' + channel;
    await M.Job.updateOne({ dedupeKey }, { $setOnInsert: { storeId: store._id, dedupeKey, event, audience, channel, ...fields } }, { upsert: true });
  }
}
async function reminders(store) {
  const config = await S().readConfiguration(store), now = new Date(), day = A.localKey(now, config.policy.timezone);
  for await (const b of M.Booking.find({ storeId: store._id, status: { $in: ['HELD', 'CONFIRMED', 'PREPARING'] }, 'trial.at': { $gt: now }, 'trial.status': { $exists: false } }).lean().cursor()) {
    if (!b.trial.status) {
      await S().transaction(store, async session => {
        const current = await S().getBooking(store, b._id, session);
        if (current.trial?.status) return;
        try { await require('./rentalStudioService').scheduleTrial(store, current, { at: new Date(current.trial.at).toISOString(), note: current.trial.notes || '', measurements: current.trial.measurements || '', operationId: 'legacy_trial_' + current._id }, session); }
        catch (error) { if (!['OUT_OF_STOCK', 'VALIDATION_ERROR'].includes(error.errorCode || error.code)) throw error; current.trial.status = 'REVIEW'; }
        await S().event(current, current.trial.status === 'REVIEW' ? 'TRIAL_REVIEW' : 'TRIAL_RESERVED', { operationId: 'legacy_trial_' + current._id, note: 'Existing trial availability rechecked.' }, undefined, session);
      });
    }
  }
  for await (const fresh of M.Booking.find({ storeId: store._id, status: { $in: ['HELD', 'CONFIRMED', 'PREPARING', 'READY'] }, 'trial.status': 'SCHEDULED', 'trial.at': { $gt: now, $lte: new Date(+now + config.policy.trialReminderHours * A.HOUR) } }).lean().cursor()) {
    if (fresh.status !== 'HELD' || +fresh.expiresAt > +now) await S().enqueue(fresh, 'TRIAL_DUE', undefined, String(+new Date(fresh.trial.at)));
  }
  // Rotation lets older jobs get a daily alert without starving later work.
  for (const task of await M.Task.find({ storeId: store._id, status: { $in: require('./rentalStudioService').openTasks }, dueAt: { $lt: now }, $or: [{ lastAlertAt: null }, { lastAlertAt: { $lt: new Date(+now - A.DAY) } }] }).sort('dueAt').limit(100).lean()) {
    await entityJob(store, task, 'TASK_OVERDUE', ['OWNER'], day, { taskId: task._id });
    await M.Task.updateOne({ storeId: store._id, _id: task._id }, { $set: { lastAlertAt: now } });
  }
  if (config.policy.refundDashboardEnabled) {
    for await (const row of M.Booking.find({ storeId: store._id, status: { $in: ['RETURNED', 'CANCELLED', 'EXPIRED', 'CLOSED'] }, 'ledger.kind': 'COLLECTION' }).lean().cursor()) {
      if (!row.refundEligibleAt) await S().transaction(store, async session => { const b = await S().getBooking(store, row._id, session); await require('./rentalStudioService').refreshRefundClock(b); await b.save({ session }); });
      const b = await M.Booking.findOne({ storeId: store._id, _id: row._id }).lean();
      if (X.refundPosition(b).overdue) await S().enqueue(b, 'REFUND_OVERDUE', undefined, day + ':' + +new Date(b.refundDueAt), { audiences: ['OWNER'] });
    }
  }
  await M.Waitlist.updateMany({ storeId: store._id, status: { $in: ['WAITING', 'NOTIFIED'] }, 'schedule.pickupAt': { $lte: new Date(+now + config.policy.minimumLeadHours * A.HOUR) } }, { $set: { status: 'EXPIRED' }, $inc: { revision: 1 } });
  if (!config.policy.waitlistEnabled || config.mode === 'SALE_ONLY') return;
  for (const row of await M.Waitlist.find({ storeId: store._id, status: { $in: ['WAITING', 'NOTIFIED'] }, nextCheckAt: { $lte: now } }).sort('nextCheckAt').limit(30).lean()) {
    const candidates = await M.Booking.find({ storeId: store._id, userId: row.userId, confirmedAt: { $gte: row.createdAt }, $or: [{ status: { $in: ['CONFIRMED', 'PREPARING', 'READY', 'OUT', 'RETURNED'] } }, { status: 'CLOSED', closedFromStatus: 'RETURNED' }],
      'schedule.pickupAt': new Date(row.schedule.pickupAt), 'schedule.returnDueAt': new Date(row.schedule.returnDueAt) }).select('quote.items').lean();
    const wanted = X.fingerprint(row.items.map(i => [String(i.listingId), i.quantity]).sort());
    if (candidates.some(b => X.fingerprint(b.quote.items.map(i => [String(i.listingId), i.quantity]).sort()) === wanted)) { await M.Waitlist.updateOne({ _id: row._id, storeId: store._id }, { $set: { status: 'FULFILLED' }, $inc: { revision: 1 } }); continue; }
    if (row.status === 'WAITING') {
      try {
        await S().publicQuote(store, { pickupAt: new Date(row.schedule.pickupAt).toISOString(), returnDueAt: new Date(row.schedule.returnDueAt).toISOString(), items: row.items, deliveryMode: row.deliveryMode });
        // Only availability changes; never reserve a piece or collect money.
        const cycle = (row.notificationCycle || 0) + 1;
        const updated = await M.Waitlist.updateOne({ _id: row._id, storeId: store._id, status: 'WAITING', revision: row.revision }, { $set: { status: 'NOTIFIED', notifiedAt: now }, $inc: { revision: 1, notificationCycle: 1 } });
        if (updated.modifiedCount) await entityJob(store, row, 'WAITLIST_AVAILABLE', ['CUSTOMER'], 'available_' + cycle, { waitlistId: row._id, waitlistCycle: cycle });
      } catch (error) { if (!['OUT_OF_STOCK', 'NOT_FOUND', 'CHECKOUT_RESTRICTED', 'SUBSCRIPTION_REQUIRED', 'VALIDATION_ERROR'].includes(error.errorCode || error.code)) throw error; }
    }
    await M.Waitlist.updateOne({ _id: row._id, storeId: store._id }, { $set: { nextCheckAt: new Date(+now + 5 * 60000) } });
  }
}
async function context(job, store) {
  const config = await S().readConfiguration(store);
  if (job.taskId) {
    const task = await M.Task.findOne({ storeId: store._id, _id: job.taskId, status: { $in: require('./rentalStudioService').openTasks }, dueAt: { $lt: new Date() } }).lean();
    if (!task) return null;
    const asset = await M.Asset.findOne({ storeId: store._id, _id: task.assetId }).select('code label').lean();
    return { _id: task._id, storeId: store._id, number: 'WORK-' + String(task._id).slice(-8), policy: config.policy, customer: {}, quote: { totalPaise: 0, items: [] },
      schedule: { pickupAt: task.dueAt, returnDueAt: task.dueAt }, studioMessage: (asset?.code || 'Piece') + ': ' + task.type.toLowerCase() + ' assigned to ' + task.assignee + ' is overdue. Review the work before promising availability.',
      studioSearch: '?tab=studio', notificationMetadata: { rentalTaskId: String(task._id) } };
  }
  if (job.waitlistId) {
    if (!config.policy.waitlistEnabled || config.mode === 'SALE_ONLY') return null;
    const row = await M.Waitlist.findOne({ storeId: store._id, _id: job.waitlistId, status: 'NOTIFIED' }).lean();
    if (!row || row.notificationCycle !== job.waitlistCycle) return null;
    try { await S().publicQuote(store, { pickupAt: new Date(row.schedule.pickupAt).toISOString(), returnDueAt: new Date(row.schedule.returnDueAt).toISOString(), items: row.items, deliveryMode: row.deliveryMode }); }
    catch (error) {
      if (['OUT_OF_STOCK', 'NOT_FOUND', 'VALIDATION_ERROR', 'CHECKOUT_RESTRICTED', 'SUBSCRIPTION_REQUIRED'].includes(error.errorCode || error.code)) {
        await M.Waitlist.updateOne({ _id: row._id, storeId: store._id, status: 'NOTIFIED', revision: row.revision }, { $set: { status: 'WAITING', nextCheckAt: new Date(Date.now() + 15 * 60000) }, $inc: { revision: 1 } });
        return null;
      }
      throw error;
    }
    const search = new URLSearchParams({ waitlist: String(row._id), pickup: new Date(row.schedule.pickupAt).toISOString(), return: new Date(row.schedule.returnDueAt).toISOString() });
    if (row.items.length === 1) search.set('listing', String(row.items[0].listingId));
    return { _id: row._id, storeId: store._id, userId: row.userId, number: 'WAIT-' + String(row._id).slice(-8), policy: config.policy, customer: row.customer,
      quote: { totalPaise: 0, items: row.items }, schedule: row.schedule, studioMessage: 'Your requested rental items are available for the selected dates right now. This is not a booking or hold. Review the latest quote and pay the compulsory advance to confirm.',
      studioPath: store.isDefault ? '/rental-book' : '/store/' + encodeURIComponent(store.slug) + '/rental-book', studioSearch: '?' + search.toString(), notificationMetadata: { rentalWaitlistId: String(row._id), ...(!store.isDefault ? { storeSlug: store.slug } : {}) } };
  }
  return null;
}
module.exports = { reminders, context };
