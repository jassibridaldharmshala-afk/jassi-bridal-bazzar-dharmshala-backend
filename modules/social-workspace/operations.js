const { Connection, Message, Thread, Post } = require('./models');
const { decryptSecret } = require('../../utils/secretBox');
const { notifyLater } = require('../../services/notificationService');
const meta = require('./meta');

let running = false;
let timer;

function retentionDays() {
  const value = Number(process.env.SOCIAL_MESSAGE_RETENTION_DAYS || 365);
  return Math.max(30, Math.min(3650, Number.isFinite(value) ? value : 365));
}
async function inspectAccount(account) {
  const now = new Date(), host = account.apiHost || 'graph.facebook.com';
  if (account.expiresAt && new Date(account.expiresAt) <= now) {
    const shouldNotify = !account.reconnectNotifiedAt || Date.now() - new Date(account.reconnectNotifiedAt).getTime() > 86400000;
    await Connection.updateOne({ _id: account._id }, { $set: { status: 'expired', lastError: 'The Meta access token has expired. Reconnect this account.', lastErrorAt: now, lastHealthCheckAt: now, nextHealthCheckAt: new Date(Date.now() + 24 * 3600000), ...(shouldNotify ? { reconnectNotifiedAt: now } : {}) } });
    if (shouldNotify) notifyLater({ event: 'SOCIAL_CONNECTION_EXPIRED', adminEvent: 'SOCIAL_CONNECTION_EXPIRED', channels: ['IN_APP'], storeId: account.storeId, metadata: { socialAccountId: account._id } });
    return;
  }
  try {
    const token = decryptSecret(account.token);
    await meta.request(account.authMethod === 'instagram' ? 'me' : account.accountId, { host, token, params: { fields: account.authMethod === 'instagram' ? 'user_id,username' : 'id,name' } });
    const update = { status: 'connected', lastError: '', lastErrorAt: null, lastHealthCheckAt: now, nextHealthCheckAt: new Date(Date.now() + 6 * 3600000) };
    if (account.provider === 'instagram' && meta.capabilities(account).publish) {
      const usage = await meta.request(`${account.accountId}/content_publishing_limit`, { host, token, params: { fields: 'quota_usage,config' } }).catch(() => null);
      const item = usage?.data?.[0] || usage;
      if (Number.isFinite(Number(item?.quota_usage))) update.publishingUsage = { quotaUsage: Number(item.quota_usage), config: Number(item.config || 100), checkedAt: now };
    }
    await Connection.updateOne({ _id: account._id }, { $set: update });
    if (meta.capabilities(account).inbox && (!account.lastSyncedAt || Date.now() - new Date(account.lastSyncedAt).getTime() > 10 * 60000)) {
      const leased = await Connection.findOneAndUpdate({ _id: account._id, $or: [{ syncLease: null }, { syncLease: { $lt: now } }] }, { $set: { syncLease: new Date(Date.now() + 120000) } }, { new: true }).select('+token');
      if (leased) try { await require('./inbox').syncConnection(leased); } finally { await Connection.updateOne({ _id: leased._id }, { $unset: { syncLease: 1 } }); }
    }
  } catch (error) {
    const expired = [190, 102].includes(error.metaCode) || (account.expiresAt && account.expiresAt <= now);
    await Connection.updateOne({ _id: account._id }, { $set: { status: expired ? 'expired' : 'degraded', lastError: error.message, lastErrorAt: now, lastHealthCheckAt: now, nextHealthCheckAt: new Date(Date.now() + (expired ? 24 : 1) * 3600000), ...(expired ? { reconnectNotifiedAt: now } : {}) } });
    if (expired && (!account.reconnectNotifiedAt || Date.now() - new Date(account.reconnectNotifiedAt).getTime() > 86400000)) notifyLater({ event: 'SOCIAL_CONNECTION_EXPIRED', adminEvent: 'SOCIAL_CONNECTION_EXPIRED', channels: ['IN_APP'], storeId: account.storeId, metadata: { socialAccountId: account._id } });
  }
}
async function alertExpiring() {
  const threshold = new Date(Date.now() + 7 * 86400000);
  const accounts = await Connection.find({ status: { $in: ['connected', 'degraded'] }, expiresAt: { $gt: new Date(), $lte: threshold }, $or: [{ reconnectNotifiedAt: null }, { reconnectNotifiedAt: { $lt: new Date(Date.now() - 86400000) } }] }).limit(25);
  for (const account of accounts) {
    notifyLater({ event: 'SOCIAL_CONNECTION_EXPIRING', adminEvent: 'SOCIAL_CONNECTION_EXPIRING', channels: ['IN_APP'], storeId: account.storeId, metadata: { socialAccountId: account._id } });
    account.reconnectNotifiedAt = new Date(); await account.save();
  }
}
async function cleanupRetention() {
  const cutoff = new Date(Date.now() - retentionDays() * 86400000);
  await Message.deleteMany({ sentAt: { $lt: cutoff } });
  const stale = await Thread.find({ resolved: true, updatedAt: { $lt: cutoff } }).select('_id').limit(500).lean();
  for (const row of stale) if (!await Message.exists({ threadId: row._id })) await Thread.deleteOne({ _id: row._id });
  const configuredPostDays = Number(process.env.SOCIAL_POST_HISTORY_RETENTION_DAYS || 730);
  const postCutoff = new Date(Date.now() - Math.max(90, Number.isFinite(configuredPostDays) ? configuredPostDays : 730) * 86400000);
  const configuredAssetDays = Number(process.env.SOCIAL_PUBLISHED_ASSET_RETENTION_DAYS || 30);
  const assetCutoff = new Date(Date.now() - Math.max(7, Number.isFinite(configuredAssetDays) ? configuredAssetDays : 30) * 86400000);
  const assets = await Post.find({ status: { $in: ['published', 'failed', 'partial', 'review'] }, assetsPurgedAt: null, updatedAt: { $lt: assetCutoff } }).select('preparedImages videoUrl generationAssets').limit(100);
  for (const post of assets) { await require('./media').removeAssets(require('./media').generatedAssets(post)); post.preparedImages = []; post.videoUrl = ''; post.generationAssets = {}; post.assetsPurgedAt = new Date(); await post.save(); }
  const staleDrafts = await Post.find({ status: 'draft', updatedAt: { $lt: postCutoff } }).select('preparedImages videoUrl generationAssets').limit(100);
  for (const post of staleDrafts) { await require('./media').removeAssets(require('./media').generatedAssets(post)); await Post.deleteOne({ _id: post._id, status: 'draft' }); await require('../../services/recordCreationService').invalidateRecordCreation(post._id); }
}
async function tick() {
  if (running) return;
  running = true;
  try {
    const now = new Date();
    const account = await Connection.findOne({ status: { $in: ['connected', 'degraded'] }, $or: [{ nextHealthCheckAt: null }, { nextHealthCheckAt: { $lte: now } }] }).sort({ nextHealthCheckAt: 1 }).select('+token');
    if (account) await inspectAccount(account);
    await alertExpiring();
    if (new Date().getUTCHours() === 2) await cleanupRetention();
  } finally { running = false; }
}
function kick() { setImmediate(() => tick().catch(error => console.error(`Social operations unavailable: ${error.message}`))); }
function startWorker() { if (!timer) { timer = setInterval(kick, 10 * 60000); timer.unref(); kick(); } }
function stopWorker() { if (timer) clearInterval(timer); timer = null; }
module.exports = { tick, inspectAccount, cleanupRetention, startWorker, stopWorker };
