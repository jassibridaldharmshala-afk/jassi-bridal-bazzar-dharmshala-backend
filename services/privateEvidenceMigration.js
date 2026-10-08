const fs = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');
const dns = require('node:dns/promises');
const crypto = require('node:crypto');
const { publicAddress } = require('../modules/social-product-import/socialImport.network');
const { mediaLocation } = require('./productSmartFillMedia');
const P = require('./privateEvidenceService');
const File = require('../models/PrivateEvidenceFile');
const Evidence = require('../models/VerificationEvidence');
const Returns = require('../models/ReturnExchange');
const { runInTransaction } = require('../utils/transaction');
const MAX_BYTES = 50 * 1024 * 1024;
async function source(url) {
  let location;
  try { location = mediaLocation(url); } catch (error) {
    const parsed = new URL(url), cloud = process.env.CLOUDINARY_CLOUD_NAME;
    if (!cloud || parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.hostname !== 'res.cloudinary.com' || !parsed.pathname.startsWith('/' + encodeURIComponent(cloud) + '/video/upload/')) throw error;
    location = { url: parsed };
  }
  let buffer;
  if (location.file) {
    const root = await fs.realpath(path.join(__dirname, '../uploads')), target = await fs.realpath(location.file);
    if (path.dirname(target).toLowerCase() !== root.toLowerCase() || (await fs.stat(target)).size > MAX_BYTES) throw new Error('UNSAFE_LOCAL_EVIDENCE');
    buffer = await fs.readFile(target);
  } else {
    const records = await dns.lookup(location.url.hostname, { all: true, family: 4 });
    if (!records.length || records.some(row => !publicAddress(row.address))) throw new Error('UNSAFE_EVIDENCE_ORIGIN');
    const chosen = records[0];
    const response = await new Promise((resolve, reject) => { const req = https.get(location.url, { signal: AbortSignal.timeout(30000), headers: { 'Accept-Encoding': 'identity' },
      lookup: (_name, options, cb) => options.all ? cb(null, [chosen]) : cb(null, chosen.address, chosen.family) }, resolve); req.on('error', reject); });
    if (response.statusCode !== 200 || Number(response.headers['content-length']) > MAX_BYTES) { response.destroy(); throw new Error('EVIDENCE_DOWNLOAD_UNAVAILABLE'); }
    const chunks = []; let count = 0;
    for await (const chunk of response) { count += chunk.length; if (count > MAX_BYTES) { response.destroy(); throw new Error('EVIDENCE_TOO_LARGE'); } chunks.push(chunk); }
    buffer = Buffer.concat(chunks);
  }
  const mimeType = buffer[0] === 255 && buffer[1] === 216 ? 'image/jpeg'
    : buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
    : buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp'
    : buffer.subarray(0, 4).equals(Buffer.from([26,69,223,163])) ? 'video/webm'
    : buffer.toString('ascii', 4, 8) === 'ftyp' ? 'video/mp4' : '';
  if (!mimeType) throw new Error('EVIDENCE_FORMAT_INVALID');
  return { buffer, mimetype: mimeType, size: buffer.length, location };
}
async function purge(file, report) {
  const url = file.legacySource;
  const pendingReferences = await Evidence.exists({ fileUrl: url }) || await Returns.exists({ $or: [{ photos: url }, { 'customerEvidence.fileUrl': url }] });
  if (pendingReferences) { report.pendingPurge++; return; }
  const publicReference = await require('./mediaReferenceService').referenced({ url })
    || await require('../models/Review').exists({ photos: url });
  if (publicReference) { await File.updateOne({ _id: file._id }, { purgeStatus: 'BLOCKED' }); report.sharedPublicReferences++; return; }
  try {
    const location = await sourceLocation(url);
    if (location.file) {
      const root = await fs.realpath(path.join(__dirname, '../uploads'));
      const real = await fs.realpath(location.file).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (real && path.dirname(real).toLowerCase() !== root.toLowerCase()) throw new Error('UNSAFE_LOCAL_EVIDENCE');
      if (real) await fs.unlink(real);
    } else if (process.env.R2_PUBLIC_URL && location.url.href.startsWith(process.env.R2_PUBLIC_URL.replace(/\/$/, '') + '/')) {
      if (!await require('./r2Upload').deleteImageFromR2(url)) throw new Error('PUBLIC_PURGE_FAILED');
    } else {
      if (!await require('./cloudinaryUpload').deleteFile(url, file.mimeType.startsWith('video/') ? 'video' : 'image')) throw new Error('PUBLIC_PURGE_FAILED');
    }
    await File.updateOne({ _id: file._id }, { purgeStatus: 'PURGED', $unset: { legacySource: '' } }); report.purged++;
  } catch (error) { await File.updateOne({ _id: file._id }, { purgeStatus: 'FAILED' }); report.errors.push({ id: String(file._id), code: error.code || 'PUBLIC_PURGE_FAILED' }); }
}
async function sourceLocation(url) {
  try { return mediaLocation(url); } catch (error) {
    const parsed = new URL(url), cloud = process.env.CLOUDINARY_CLOUD_NAME;
    if (!cloud || parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.hostname !== 'res.cloudinary.com' || !parsed.pathname.startsWith('/' + encodeURIComponent(cloud) + '/video/upload/')) throw error;
    return { url: parsed };
  }
}
async function migrate({ apply = false, deletePublic = false, storeId, limit = 100 } = {}) {
  const scope = storeId ? { storeId } : {};
  const report = { mode: apply ? 'apply' : 'dry-run', found: 0, migrated: 0, purged: 0, pendingPurge: 0, sharedPublicReferences: 0, errors: [] };
  const rows = await Evidence.find({ ...scope, fileUrl: { $not: /^\/api\/evidence\// } }).sort('_id').limit(limit).lean();
  const histories = await Returns.find({ ...scope, $or: [{ photos: { $elemMatch: { $not: /^\/api\/evidence\// } } }, { 'customerEvidence.fileUrl': { $not: /^\/api\/evidence\// }, 'customerEvidence.0': { $exists: true } }] }).sort('_id').limit(limit).lean();
  const orderIds = [...new Set([...rows, ...histories].map(row => String(row.order)).filter(require('mongoose').isValidObjectId))];
  const defaultStore = await require('../models/Store').findOne({ isDefault: true }).select('_id').lean();
  const orders = await require('../models/Order').find({ _id: { $in: orderIds } }).select('storeId').lean();
  const orderStores = new Map(orders.map(order => [String(order._id), order.storeId || defaultStore?._id]));
  const entries = [...rows.map(row => ({ kind: 'evidence', id: row._id, url: row.fileUrl, user: row.uploadedBy, store: row.storeId || orderStores.get(String(row.order)), audience: row.phase === 'RETURN_REQUEST' ? 'CUSTOMER' : 'STAFF' })),
    ...histories.flatMap(row => [...new Set([...(row.photos || []), ...(row.customerEvidence || []).map(e => e.fileUrl)])].filter(url => !P.fileId(url)).map(url => ({ kind: 'return', id: row._id, url, user: row.user, store: row.storeId || orderStores.get(String(row.order)), audience: 'CUSTOMER' })))];
  const grouped = new Map();
  for (const row of entries) {
    const key = [row.url, String(row.user), String(row.store), row.audience].join(':');
    const group = grouped.get(key) || { ...row, evidenceIds: [], returnIds: [] };
    group[row.kind === 'evidence' ? 'evidenceIds' : 'returnIds'].push(row.id); grouped.set(key, group);
  }
  const unique = [...grouped.values()];
  report.found = unique.length;
  for (const row of unique) if (!row.store || !row.user) report.errors.push({ id: String(row.id), code: 'EVIDENCE_SCOPE_UNKNOWN' });
  if (!apply) return report;
  for (const row of unique) {
    if (!row.store || !row.user) continue;
    try {
      const photo = await source(row.url);
      const uploadId = crypto.createHash('sha256').update([row.url, String(row.user), String(row.store), row.audience].join(':')).digest('hex');
      const saved = await P.save(photo, { user: { _id: row.user, role: row.audience === 'STAFF' ? 'admin' : 'customer', activeMode: row.audience === 'STAFF' ? 'admin' : 'customer' }, store: { _id: row.store } }, { uploadId });
      await File.updateOne({ _id: saved.privateFileId }, { legacySource: row.url, purgeStatus: 'PENDING' });
      await runInTransaction(async session => {
        await Evidence.updateMany({ _id: { $in: row.evidenceIds }, fileUrl: row.url, uploadedBy: row.user }, { fileUrl: saved.fileUrl, privateFileId: saved.privateFileId, provider: 'private', mimeType: saved.mimeType, sizeBytes: saved.sizeBytes }, { session });
        for (const record of await Returns.find({ _id: { $in: row.returnIds }, user: row.user, $or: [{ photos: row.url }, { 'customerEvidence.fileUrl': row.url }] }).session(session)) {
          record.photos = (record.photos || []).map(url => url === row.url ? saved.fileUrl : url);
          record.customerEvidence = (record.customerEvidence || []).map(e => e.fileUrl === row.url ? { ...(e.toObject ? e.toObject() : e), fileUrl: saved.fileUrl, provider: 'private', mimeType: saved.mimeType, sizeBytes: saved.sizeBytes } : e);
          await record.save({ session });
        }
      });
      report.migrated++;
    } catch (error) { report.errors.push({ id: String(row.id), code: error.errorCode || error.code || 'MIGRATION_FAILED' }); }
  }
  if (deletePublic) for (const file of await File.find({ ...scope, purgeStatus: { $in: ['PENDING', 'FAILED', 'BLOCKED'] } }).select('+legacySource').limit(limit).lean()) await purge(file, report);
  else report.pendingPurge = await File.countDocuments({ ...scope, purgeStatus: { $in: ['PENDING', 'FAILED', 'BLOCKED'] } });
  return report;
}
module.exports = { migrate, source, purge };

