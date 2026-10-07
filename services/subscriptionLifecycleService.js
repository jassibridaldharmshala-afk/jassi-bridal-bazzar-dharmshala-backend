const Store = require('../models/Store');
const { notify } = require('./notificationService');

const DAY_MS = 24 * 60 * 60 * 1000;
let worker;

function endingBetween(from, to) {
  return {
    $or: [
      { 'license.status': 'TRIAL', 'license.trialEndsAt': { $gt: from, $lte: to } },
      { 'license.status': 'ACTIVE', 'license.billingCycle': { $in: ['MONTHLY', 'YEARLY', 'MANUAL'] }, 'license.endsAt': { $gt: from, $lte: to } },
    ],
  };
}

function expiredAtOrBefore(now) {
  return {
    $or: [
      { 'license.status': 'TRIAL', 'license.trialEndsAt': { $lte: now } },
      { 'license.status': 'ACTIVE', 'license.billingCycle': { $in: ['MONTHLY', 'YEARLY', 'MANUAL'] }, 'license.endsAt': { $lte: now } },
    ],
  };
}

function subscriptionEnd(store) {
  return store.license?.status === 'TRIAL' ? store.license?.trialEndsAt : store.license?.endsAt;
}

async function notifyOwner(store, event, title, message, end) {
  if (!store.owner) return;
  await notify({
    userId: store.owner,
    storeId: store._id,
    event,
    title,
    message,
    metadata: {
      storeId: String(store._id),
      subscriptionId: `${store._id}:${new Date(end).toISOString()}`,
      endsAt: end,
    },
  });
}

async function reconcileSubscriptionLifecycles({ now = new Date(), reminderDays = 7, limit = 250 } = {}) {
  const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 250));
  const reminderEnd = new Date(now.getTime() + Math.max(1, Number(reminderDays) || 7) * DAY_MS);
  const [expired, expiring] = await Promise.all([
    Store.find(expiredAtOrBefore(now)).select('_id owner name license').limit(safeLimit),
    Store.find(endingBetween(now, reminderEnd)).select('_id owner name license').limit(safeLimit),
  ]);

  let expiredCount = 0;
  let reminderCount = 0;
  for (const store of expired) {
    const end = subscriptionEnd(store);
    const updated = await Store.updateOne({ _id: store._id, ...expiredAtOrBefore(now) }, { $set: { 'license.status': 'EXPIRED' } });
    if (!updated.modifiedCount) continue;
    expiredCount += 1;
    await notifyOwner(store, 'SUBSCRIPTION_EXPIRED', 'Store access period ended', `${store.name}'s access period has ended. Your store data remains safe; renew to resume protected actions.`, end);
  }
  for (const store of expiring) {
    const end = subscriptionEnd(store);
    const days = Math.max(1, Math.ceil((new Date(end).getTime() - now.getTime()) / DAY_MS));
    await notifyOwner(store, 'SUBSCRIPTION_EXPIRING', 'Store access expires soon', `${store.name}'s access period ends in ${days} day${days === 1 ? '' : 's'}. Renew before expiry to avoid an interruption.`, end);
    reminderCount += 1;
  }
  return { scanned: expired.length + expiring.length, expired: expiredCount, reminders: reminderCount };
}

function startSubscriptionLifecycleWorker() {
  if (worker || process.env.NODE_ENV === 'test') return stopSubscriptionLifecycleWorker;
  const configured = Number(process.env.SUBSCRIPTION_LIFECYCLE_INTERVAL_MS || 6 * 60 * 60 * 1000);
  const interval = Number.isFinite(configured) ? Math.max(15 * 60 * 1000, configured) : 6 * 60 * 60 * 1000;
  const tick = () => reconcileSubscriptionLifecycles().catch((error) => {
    console.error(JSON.stringify({ event: 'subscription_lifecycle_failed', message: error.message }));
  });
  tick();
  worker = setInterval(tick, interval);
  worker.unref();
  return stopSubscriptionLifecycleWorker;
}

function stopSubscriptionLifecycleWorker() {
  if (worker) clearInterval(worker);
  worker = null;
}

module.exports = {
  reconcileSubscriptionLifecycles,
  startSubscriptionLifecycleWorker,
  stopSubscriptionLifecycleWorker,
};
