const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const mongoose = require('mongoose');
const File = require('../models/PrivateEvidenceFile');
const Store = require('../models/Store');
const StoreMember = require('../models/StoreMember');
const { isMasterOwner } = require('../config/masterOwner');
const { andFilter } = require('./storeService');
const { runUploadRequest } = require('./uploadRetryService');
const { preparePhotoFile, PHOTO_PRIVATE_MAX_BYTES } = require('./photoCompressionService');
const { ApiError } = require('../utils/apiError');
const bucket = () => new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'verificationMedia' });
const fileUrl = id => `/api/evidence/${id}`;
function fileId(url) { const match = /^\/api\/evidence\/([a-f0-9]{24})$/i.exec(String(url || '')); return match?.[1]; }
async function save(file, req, options = {}) {
  const photo = String(file.mimetype).startsWith('image/');
  if (photo && file.size > PHOTO_PRIVATE_MAX_BYTES) throw new ApiError('UPLOAD_IMAGE_TOO_LARGE', 'Private evidence photos must be 8 MB or smaller.');
  if (photo) file = await preparePhotoFile(file);
  if (photo && file.size > PHOTO_PRIVATE_MAX_BYTES) throw new ApiError('UPLOAD_IMAGE_TOO_LARGE', 'This private evidence photo exceeds the 8 MB storage allowance.');
  if (!photo && (!String(file.mimetype).startsWith('video/') || file.size > 50 * 1024 * 1024)) throw new ApiError('VALIDATION_ERROR', 'Private evidence videos must be 50 MB or smaller.');
  const id = new mongoose.Types.ObjectId(options.uploadId ? options.uploadId.slice(0, 24) : undefined);
  let stored = await File.findById(id).lean();
  if (!stored) {
    const digest = crypto.createHash('sha256');
    if (file.buffer) digest.update(file.buffer); else for await (const chunk of createReadStream(file.path)) digest.update(chunk);
    const metadata = { uploadedBy: req.user._id, storeId: req.store?._id || null,
      audience: req.storeMember || (req.user.role === 'admin' && req.user.activeMode === 'admin') ? 'STAFF' : 'CUSTOMER',
      mimeType: file.mimetype, sizeBytes: file.size, digest: digest.digest('hex') };
    const existing = await bucket().find({ _id: id }).next();
    if (existing) {
      if (existing.length !== file.size || existing.metadata?.digest !== metadata.digest) throw new ApiError('UPLOAD_RETRY_CONFLICT', 'The uploaded evidence changed. Start a new upload.', { statusCode: 409 });
    } else {
      // A terminated process may have left chunks without a completed GridFS file.
      await mongoose.connection.db.collection('verificationMedia.chunks').deleteMany({ files_id: id });
      const upload = bucket().openUploadStreamWithId(id, 'private-evidence', { metadata, contentType: file.mimetype });
      try { await pipeline(file.buffer ? Readable.from(file.buffer) : createReadStream(file.path), upload); }
      catch (error) { await upload.abort().catch(() => {}); throw error; }
    }
    stored = await File.findOneAndUpdate({ _id: id }, { $setOnInsert: metadata }, { upsert: true, new: true, runValidators: true }).lean();
  }
  if (String(stored.uploadedBy) !== String(req.user._id)) throw new ApiError('NOT_FOUND', 'Evidence not found.');
  return { url: fileUrl(id), fileUrl: fileUrl(id), privateFileId: String(id), publicId: String(id), provider: 'private',
    mimeType: stored.mimeType, sizeBytes: stored.sizeBytes, kind: stored.mimeType.startsWith('video/') ? 'VIDEO' : 'IMAGE' };
}
async function upload(req) {
  try {
    return await runUploadRequest(req, async context => {
      if (context.resume) return context.storedFiles;
      const results = [];
      for (let index = 0; index < (req.files || []).length; index++) results.push(await context.upload(req.files[index], index, options => save(req.files[index], req, options)));
      return results;
    }, { resume: req.body?.resumeUpload === true, replay: async rows => {
      for (const row of rows || []) if (row.provider !== 'private' || !await File.exists({ _id: fileId(row.fileUrl) })) throw new ApiError('UPLOAD_RETRY_CONFLICT', 'This old evidence upload must be uploaded privately again.', { statusCode: 409 });
      return rows;
    } });
  } finally { await Promise.all((req.files || []).map(file => file.path ? fs.unlink(file.path).catch(() => {}) : Promise.resolve())); }
}
async function attachments(req, value = [], types, photos = []) {
  if (!Array.isArray(value) || value.length > 12) throw new ApiError('VALIDATION_ERROR', 'Choose up to 12 private evidence files.');
  const rows = value.map(row => ({ type: String(row?.type || '').toUpperCase(), fileUrl: row?.fileUrl }));
  for (const url of photos) if (!rows.some(row => row.fileUrl === url)) rows.push({ type: 'CUSTOMER_PHOTO', fileUrl: url });
  const result = [];
  for (const row of rows) {
    const id = fileId(row.fileUrl);
    if (!id || !types.includes(row.type)) throw new ApiError('VALIDATION_ERROR', 'Upload evidence privately before attaching it. Public evidence URLs are not accepted.');
    const stored = await File.findOne(andFilter({ _id: id, uploadedBy: req.user._id }, req.tenantFilter)).lean();
    if (!stored) throw new ApiError('NOT_FOUND', 'This evidence does not belong to the active account and store.');
    const video = stored.mimeType.startsWith('video/');
    if (video !== /VIDEO$/.test(row.type)) throw new ApiError('VALIDATION_ERROR', 'The evidence type does not match the uploaded file.');
    if (result.some(item => item.fileUrl === row.fileUrl)) continue;
    result.push({ type: row.type, fileUrl: fileUrl(id), privateFileId: id, provider: 'private', mimeType: stored.mimeType, sizeBytes: stored.sizeBytes });
  }
  return result;
}
async function authorize(req, id) {
  if (!mongoose.isValidObjectId(id)) throw new ApiError('NOT_FOUND', 'Evidence not found.');
  const stored = await File.findById(id).lean();
  if (!stored) throw new ApiError('NOT_FOUND', 'Evidence not found.');
  if (stored.audience === 'CUSTOMER' && String(stored.uploadedBy) === String(req.user._id)) return stored;
  if (isMasterOwner(req.user)) return stored;
  const store = stored.storeId ? await Store.findById(stored.storeId).lean() : await Store.findOne({ isDefault: true }).lean();
  if (req.user.role === 'admin' && req.user.activeMode === 'admin' && store?.isDefault) return stored;
  const membership = store && await StoreMember.findOne({ store: store._id, user: req.user._id, status: 'ACTIVE' }).lean();
  if (membership && ['orders.read', 'returns.read'].some(permission => StoreMember.roleAllows(membership.role, permission)
    && store.catalogStructure?.clientPermissions?.[permission.split('.')[0]] !== false)) return stored;
  throw new ApiError('NOT_FOUND', 'Evidence not found.');
}
async function retrieve(req, res, next) {
  try {
    const stored = await authorize(req, req.params.id);
    res.set({ 'Content-Type': stored.mimeType, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline', 'Content-Length': String(stored.sizeBytes) });
    const stream = bucket().openDownloadStream(stored._id);
    req.on('aborted', () => stream.destroy());
    res.on('close', () => stream.destroy());
    stream.on('error', error => { if (!res.headersSent) next(error); else res.destroy(); });
    stream.pipe(res);
  } catch (error) { next(error); }
}
function presentEvidence(rows) { return rows.map(row => fileId(row.fileUrl) ? row : { ...row, fileUrl: '', migrationRequired: true }); }
async function bindToStore(rows, storeId, session) {
  for (const row of rows) {
    const stored = await File.findById(row.privateFileId).session(session || null);
    if (!stored) throw new ApiError('NOT_FOUND', 'Private evidence not found.');
    if (stored.storeId && String(stored.storeId) !== String(storeId || '')) throw new ApiError('NOT_FOUND', 'Evidence belongs to a different store.');
    if (!stored.storeId && storeId) { stored.storeId = storeId; await stored.save(session ? { session } : {}); }
  }
}
module.exports = { bindToStore, presentEvidence, upload, attachments, retrieve, save, fileId, fileUrl, authorize, bucket };

