const crypto = require('node:crypto');
const { Configuration, Digest } = require('../models/TrafficAnalytics');
const ProviderConfiguration = require('../models/OrderAlertConfiguration');
const Store = require('../models/Store');
const User = require('../models/User');
const StoreMember = require('../models/StoreMember');
const { roleAllows } = require('../models/StoreMember');
const { isMasterOwner } = require('../config/masterOwner');
const { hasStoreFeature } = require('../config/storePlans');
const { trafficReport } = require('./trafficReportingService');
const providers = require('./orderAlertProviders');
const { dateKey, midnight, shiftDate, DAY } = require('./trafficAlgorithms');
const { ApiError } = require('../utils/apiError');
let running = false; let timer;

function nextDigestDate(frequency, timezone, from = new Date()) {
  const today = dateKey(from, timezone);
  let days = 1;
  if (frequency === 'WEEKLY') { const weekday = new Date(`${today}T12:00:00Z`).getUTCDay(); days = (8 - weekday) % 7 || 7; }
  const key = shiftDate(today, days);
  // Resolve 09:00 local rather than adding nine hours across a DST transition.
  let result = +midnight(key, timezone) + 9 * 3600000;
  for (let i = 0; i < 3; i += 1) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(result)).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
    const target = Date.parse(`${key}T09:00:00Z`); result += target - Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  }
  return new Date(result);
}
async function readiness(storeId) {
  const provider = await ProviderConfiguration.findOne({ storeId }).select('+whatsapp.accessToken').lean();
  return { ready: Boolean(provider?.whatsapp?.accessToken && provider.whatsapp.phoneNumberId && provider.storefrontUrl), recipient: provider?.whatsapp?.recipient || '', note: 'Uses this store’s encrypted Meta credentials from Order alerts. A separate approved five-variable traffic-summary template is required.' };
}
async function assertAccess(config, store) {
  const actor = await User.findById(config.whatsappDigest.actorId).select('+systemRole role activeMode phone isPhoneVerified isBlocked').lean();
  if (!actor || actor.isBlocked || !actor.isPhoneVerified) throw new Error('The digest owner no longer has active access.');
  if (actor.role === 'admin' && actor.activeMode === 'admin' && (store.isDefault || isMasterOwner(actor))) return;
  const member = await StoreMember.findOne({ store: store._id, user: actor._id, status: 'ACTIVE' }).lean();
  if (!member || !roleAllows(member.role, 'settings.write') || !roleAllows(member.role, 'reports.manage') || !roleAllows(member.role, 'reports.export')) throw new Error('Digest management/export permission is no longer active.');
  if (!hasStoreFeature(store, 'analytics') || store.catalogStructure?.clientPermissions?.reports === false) throw new Error('Analytics is not active for this store.');
}
async function deliverDigest(job, config) {
  const store = await Store.findById(job.storeId).lean();
  if (!store || !config.whatsappDigest?.enabled || !config.enabled) throw new Error('Traffic digests are disabled.');
  await assertAccess(config, store);
  const provider = await ProviderConfiguration.findOne({ storeId: job.storeId }).select('+whatsapp.accessToken').lean();
  if (!provider?.whatsapp?.accessToken || !provider.whatsapp.phoneNumberId || !provider.storefrontUrl) throw new Error('Configure this store’s Meta credentials and storefront URL in Order alerts.');
  const digest = config.whatsappDigest;
  if (!digest.consent || !digest.recipient || !digest.templateName) throw new Error('The digest recipient consent/template is incomplete.');
  const url = new URL(provider.storefrontUrl); if (url.protocol !== 'https:') throw new Error('Use a secure storefront URL for traffic digest links.');
  url.pathname = '/admin/reports'; url.search = ''; url.hash = '';
  const stats = await trafficReport({ store, tenantFilter: { storeId: store._id }, query: { from: job.periodFrom, to: job.periodTo }, timezone: config.timezone });
  return providers.deliver('WHATSAPP', { ...provider, whatsapp: { ...provider.whatsapp, templateName: digest.templateName, language: digest.language } }, digest.recipient, {
    storeName: store.name, number: `${job.periodFrom} to ${job.periodTo} (${config.timezone})`, amount: `${stats.metrics.visitors.value} measured visitors`, payment: `${stats.commerce.ordersPlaced} verified orders`, link: url.toString(),
  });
}
async function tick() {
  if (running) return; running = true;
  try {
    const now = new Date();
    // A provider may have accepted a send before the API process stopped.
    // Expired sends become uncertain, never automatically duplicated.
    await Digest.updateMany({ status: 'SENDING', leaseUntil: { $lte: now } }, { $set: { status: 'UNCERTAIN', reason: 'Sending was interrupted. Check Meta before a manual retry.' } });
    const due = await Configuration.find({ enabled: true, 'whatsappDigest.enabled': true, 'whatsappDigest.nextRunAt': { $lte: now } }).limit(20).lean();
    for (const config of due) {
      const digest = config.whatsappDigest;
      const key = dateKey(digest.nextRunAt, config.timezone);
      const periodTo = shiftDate(key, -1); const periodFrom = shiftDate(key, digest.frequency === 'WEEKLY' ? -7 : -1);
      await Digest.updateOne({ storeId: config.storeId, periodTo, frequency: digest.frequency }, { $setOnInsert: { storeId: config.storeId, periodFrom, periodTo, frequency: digest.frequency, actorId: digest.actorId, nextAttemptAt: now, expiresAt: new Date(+now + 90 * DAY) } }, { upsert: true }).catch(error => { if (error.code !== 11000) throw error; });
      await Configuration.updateOne({ _id: config._id, 'whatsappDigest.nextRunAt': digest.nextRunAt }, { $set: { 'whatsappDigest.nextRunAt': nextDigestDate(digest.frequency, config.timezone, now) } });
    }
    const jobs = await Digest.find({ status: 'PENDING', nextAttemptAt: { $lte: now } }).limit(10).lean();
    for (const candidate of jobs) {
      const leaseToken = crypto.randomUUID();
      const job = await Digest.findOneAndUpdate({ _id: candidate._id, status: 'PENDING' }, { $set: { status: 'SENDING', leaseToken, leaseUntil: new Date(Date.now() + 120000) }, $inc: { attempts: 1 } }, { new: true }).lean();
      if (!job) continue;
      try {
        const config = await Configuration.findOne({ storeId: job.storeId }).lean();
        if (!config?.whatsappDigest?.enabled || !config.enabled || String(config.whatsappDigest.actorId) !== String(job.actorId)) { await Digest.updateOne({ _id: job._id, leaseToken }, { $set: { status: 'SKIPPED', reason: 'Digest settings/owner changed or collection is disabled.' } }); continue; }
        await deliverDigest(job, config);
        await Digest.updateOne({ _id: job._id, leaseToken }, { $set: { status: 'ACCEPTED', acceptedAt: new Date(), reason: 'Meta accepted the template. Device delivery is not guaranteed.' }, $unset: { leaseToken: 1, leaseUntil: 1 } });
      } catch (error) {
        const retry = error.retryable && job.attempts < 5;
        await Digest.updateOne({ _id: job._id, leaseToken }, { $set: { status: retry ? 'PENDING' : error.uncertain ? 'UNCERTAIN' : 'FAILED', reason: String(error.message || 'Traffic digest failed.').slice(0, 300), ...(retry ? { nextAttemptAt: new Date(Date.now() + 60000 * 2 ** job.attempts) } : {}) }, $unset: { leaseToken: 1, leaseUntil: 1 } });
      }
    }
  } finally { running = false; }
}
async function retry(storeId, id, confirmed) {
  const job = await Digest.findOne({ _id: id, storeId, status: { $in: ['FAILED', 'UNCERTAIN'] } }).lean();
  if (!job) throw new ApiError('NOT_FOUND', 'Retryable traffic digest not found.');
  if (job.status === 'UNCERTAIN' && confirmed !== true) throw new ApiError('VALIDATION_ERROR', 'Confirm you checked Meta; retrying an uncertain send can duplicate it.');
  await Digest.updateOne({ _id: id, storeId, status: job.status }, { $set: { status: 'PENDING', attempts: 0, nextAttemptAt: new Date(), reason: 'Manually queued for retry.' } });
}
function startWorker() { if (timer || process.env.NODE_ENV === 'test') return stopWorker; tick().catch(() => {}); timer = setInterval(() => tick().catch(() => {}), 60000); timer.unref(); return stopWorker; }
function stopWorker() { if (timer) clearInterval(timer); timer = null; }
module.exports = { nextDigestDate, readiness, assertAccess, deliverDigest, tick, retry, startWorker, stopWorker };
