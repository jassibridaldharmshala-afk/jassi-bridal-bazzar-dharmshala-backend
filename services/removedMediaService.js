const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const Removed = require('../models/RemovedMedia');
const { imageAsset } = require('./imageAssetService');
const sources = new Set(['product', 'draft', 'category', 'banner', 'campaign', 'settings', 'design', 'content', 'social', 'review']);
function entries(value, collected = new Map(), depth = 0) {
  if (depth > 20 || !value || value instanceof Date || Buffer.isBuffer(value)) return [...collected.values()];
  if (typeof value === 'string') {
    if (/^(?:https?:\/\/|\/uploads\/)/i.test(value)) collected.set(value, { url: value });
  } else if (Array.isArray(value)) value.forEach(item => entries(item, collected, depth + 1));
  else if (typeof value === 'object') {
    if (typeof value.url === 'string') collected.set(value.url, { url: value.url, publicId: value.publicId || value.storageKey, provider: value.provider, resourceType: value.resourceType || (String(value.mimeType || '').startsWith('video/') ? 'video' : 'image') });
    for (const [key, item] of Object.entries(value)) if (key !== 'url' && key !== '_id') entries(item, collected, depth + 1);
  }
  return [...collected.values()];
}
function providerFor(entry) {
  if (require('./r2Upload').resolveObjectKey(entry)) return 'r2';
  let pathname = String(entry.url || '');
  if (entry.provider === 'local' && /^https?:\/\//.test(pathname)) { try { pathname = new URL(pathname).pathname; } catch { return ''; } }
  if (/^\/uploads\/[^?#]+$/.test(pathname) && !pathname.includes('..')) return 'local';
  if (entry.provider === 'cloudinary' && entry.publicId && /^https:\/\/res\.cloudinary\.com\//.test(pathname)) return 'cloudinary';
  return '';
}
async function queueRemovedMedia(before, after, context) {
  if (!sources.has(context?.source) || !context.sourceId) throw new Error('Image cleanup requires the specific edited record.');
  const retained = new Set(entries(after).map(entry => entry.url)), seen = new Set();
  for (const entry of entries(before)) {
    if (retained.has(entry.url)) continue;
    const family = await imageAsset(entry.url, context.session);
    if (family?.storeId && context.storeId && String(family.storeId) !== String(context.storeId)) continue;
    const assets = entries(family || entry).filter(providerFor);
    if (!assets.length || assets.some(asset => retained.has(asset.url))) continue;
    const id = crypto.createHash('sha256').update(JSON.stringify([context.source, String(context.sourceId), String(context.storeId || ''), assets.map(asset => asset.url).sort()])).digest('hex');
    if (seen.has(id)) continue; seen.add(id);
    await Removed.updateOne({ _id: id }, { $set: { source: context.source, sourceId: String(context.sourceId), storeId: context.storeId, assets, status: 'PENDING', nextAttemptAt: new Date() }, $unset: { leaseUntil: 1, lastError: 1 }, $setOnInsert: { attempts: 0 } }, { upsert: true, session: context.session || null });
  }
}
async function deleteExactAsset(entry) {
  const provider = providerFor(entry);
  if (provider === 'r2') {
    if (!await require('./r2Upload').deleteImageFromR2(entry)) throw new Error('Cloudflare storage is unavailable for this removed image.');
  } else if (provider === 'cloudinary') {
    if (!await require('./cloudinaryUpload').deleteFile(entry, entry.resourceType)) throw new Error('Cloudinary storage is unavailable for this removed image.');
  } else if (provider === 'local') {
    const root = path.resolve(__dirname, '../uploads'), pathname = entry.url.startsWith('/') ? entry.url : new URL(entry.url).pathname;
    const target = path.resolve(root, pathname.slice('/uploads/'.length));
    if (!target.startsWith(root + path.sep)) throw new Error('Invalid local media path.');
    await fs.unlink(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await require('./uploadRetryService').invalidateStoredUpload('local', entry.publicId || path.basename(target));
  } else throw new Error('This image does not belong to the configured storage.');
}
let running;
function processRemovedMedia({ limit = 5 } = {}) {
  if (running) return running;
  running = (async () => {
    for (let count = 0; count < limit; count++) {
      const now = new Date();
      const job = await Removed.findOneAndUpdate({ status: 'PENDING', nextAttemptAt: { $lte: now }, $or: [{ leaseUntil: null }, { leaseUntil: { $lt: now } }] }, { $set: { leaseUntil: new Date(+now + 120000) }, $inc: { attempts: 1 } }, { new: true, sort: { nextAttemptAt: 1 } }).lean();
      if (!job) break;
      try {
        if (await require('./mediaReferenceService').referencedFamily(job.assets)) {
          await Removed.updateOne({ _id: job._id }, { $set: { status: 'SHARED' }, $unset: { leaseUntil: 1, lastError: 1 } });
          continue;
        }
        for (const asset of job.assets) await deleteExactAsset(asset);
        await Removed.updateOne({ _id: job._id }, { $set: { status: 'DONE' }, $unset: { leaseUntil: 1, lastError: 1 } });
        await require('../models/MediaAsset').deleteMany({ url: { $in: job.assets.map(asset => asset.url) } });
      } catch (error) {
        await Removed.updateOne({ _id: job._id }, { $set: { nextAttemptAt: new Date(Date.now() + Math.min(3600000, 30000 * 2 ** Math.min(job.attempts, 7))), lastError: String(error.message).slice(0, 500) }, $unset: { leaseUntil: 1 } });
      }
    }
  })().finally(() => { running = null; });
  return running;
}
function startRemovedMediaWorker() {
  const run = () => processRemovedMedia().catch(error => console.error('Removed image cleanup:', error.message));
  run(); const timer = setInterval(run, 30000); timer.unref();
  return () => clearInterval(timer);
}
module.exports = { entries, providerFor, queueRemovedMedia, processRemovedMedia, startRemovedMediaWorker };
