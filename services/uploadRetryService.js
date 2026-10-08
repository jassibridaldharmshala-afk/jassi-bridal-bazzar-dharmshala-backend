const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const Operation = require('../models/UploadOperation');
const { ApiError } = require('../utils/apiError');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const leaseMs = 90 * 1000;
const activeUploads = new Set();
const { log } = require('../utils/logger');

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
async function fileDigest(file) {
  const digest = crypto.createHash('sha256');
  if (file.buffer) digest.update(file.buffer);
  else for await (const chunk of createReadStream(file.path)) digest.update(chunk);
  return digest.digest('hex');
}
function conflict(message, code = 'UPLOAD_RETRY_CONFLICT') {
  return new ApiError(code, message, { statusCode: 409 });
}

function storageFingerprint() {
  return hash(JSON.stringify([process.env.R2_ACCOUNT_ID, process.env.R2_BUCKET_NAME, process.env.R2_PUBLIC_URL, process.env.R2_FOLDER,
    process.env.CLOUDINARY_CLOUD_NAME, process.env.CLOUDINARY_FOLDER]));
}
function uploadIdentity(req, requestPath) {
  const key = req.get?.('Idempotency-Key') || req.headers?.['idempotency-key'];
  if (!key || !/^[a-zA-Z0-9_-]{16,100}$/.test(key)) throw new ApiError('VALIDATION_ERROR', 'A valid upload retry key is required.');
  if (!req.user?._id) throw new ApiError('UNAUTHORIZED', 'Sign in before checking uploads.');
  return hash(JSON.stringify([String(req.store?._id || req.socialStore?._id || ''), String(req.user._id),
    requestPath || req.originalUrl?.split('?')[0] || req.baseUrl + req.path, key]));
}
function running(receipt) { return receipt.status === 'RUNNING' && receipt.leaseUntil && new Date(receipt.leaseUntil).getTime() > Date.now(); }
function uploadStatus(receipt) {
  const status = running(receipt) ? 'RUNNING' : receipt.status === 'RUNNING' ? 'PENDING' : receipt.status;
  return { success: true, data: { upload: { status, fileCount: receipt.fileCount,
    completedFiles: receipt.files.filter(Boolean).length, phase: status === 'PENDING' ? 'retry' : receipt.progress?.phase || 'queued',
    photoIndex: receipt.progress?.photoIndex, message: status === 'PENDING'
      ? receipt.failure?.message || 'Processing was interrupted. Retry with the same selected photos to continue safely.' : undefined } } };
}
async function getUploadStatus(req, { requestPath, replay } = {}) {
  const receipt = await Operation.findById(uploadIdentity(req, requestPath)).lean();
  if (!receipt) throw new ApiError('NOT_FOUND', 'No upload was found for this selection.');
  if (receipt.status === 'REMOVED') throw conflict('These uploaded files or drafts were removed. Start a new upload.');
  if (receipt.status === 'COMPLETE') return replay ? replay(receipt.result) : receipt.result;
  return uploadStatus(receipt);
}
async function waitForActiveUploads() { await Promise.allSettled([...activeUploads]); }

async function runUploadRequest(req, work, { replay, resume = false, recordOnly = false, respondAsync = false, onSettled } = {}) {
  const key = req.get?.('Idempotency-Key') || req.headers?.['idempotency-key'];
  if (!key) {
    if (resume || respondAsync) throw new ApiError('VALIDATION_ERROR', 'An upload retry key is required.');
    return work({ managed: false, upload: (file, index, save) => save({}) });
  }
  const id = uploadIdentity(req);
  const digests = resume ? [] : await Promise.all((req.files || []).map(fileDigest));
  // Transport preference is not a new upload intent. Older synchronous-client
  // receipts must still match after the frontend begins requesting async work.
  const { asyncUpload: _asyncUpload, ...uploadFields } = req.body || {};
  let fingerprint = resume ? '' : hash(JSON.stringify(stable({
    query: req.query, fields: uploadFields,
    files: (req.files || []).map((file, index) => [digests[index], file.mimetype, file.originalname]),
    ...(!recordOnly ? { storage: storageFingerprint() } : {}),
  })));
  if (!resume) {
    try {
      await Operation.updateOne({ _id: id }, { $setOnInsert: { fingerprint, status: 'PENDING', files: [], fileCount: req.files?.length || 0,
        fields: recordOnly ? {} : uploadFields, query: req.query || {}, storage: recordOnly ? '' : storageFingerprint() } }, { upsert: true });
    } catch (error) { if (error.code !== 11000) throw error; }
  }
  const receipt = await Operation.findById(id).lean();
  if (!receipt) throw new ApiError('NOT_FOUND', 'No previous upload was found for this selection.');
  if (resume) {
    if (receipt.storage !== storageFingerprint() || JSON.stringify(stable(receipt.query || {})) !== JSON.stringify(stable(req.query || {}))) throw conflict('Upload storage/settings changed. Start a new upload.');
    // A live partial upload must be observed, never reposted or started twice.
    if (running(receipt)) {
      if (respondAsync) { await onSettled?.(); return uploadStatus(receipt); }
      throw conflict('This upload is still being processed. Wait a moment and retry.', 'UPLOAD_IN_PROGRESS');
    }
    if (!receipt.fileCount || receipt.files.filter(Boolean).length !== receipt.fileCount) throw conflict('Some photos were not uploaded yet. Continue with the selected files.', 'UPLOAD_INCOMPLETE');
    fingerprint = receipt.fingerprint;
  }
  if (receipt.fingerprint !== fingerprint) throw conflict('The selected files or upload settings changed. Start a new upload.');
  if (receipt.status === 'REMOVED') throw conflict('These uploaded files were removed. Select the files again to start a new upload.');
  for (const file of receipt.files.filter(Boolean).flatMap(file => [file, ...(file.variants || [])])) {
    if (file.provider === 'local' && !await fs.access(path.join(__dirname, '..', 'uploads', path.basename(file.publicId))).then(() => true, () => false)) {
      await Operation.updateOne({ _id: id }, { $set: { status: 'REMOVED' } });
      throw conflict('These uploaded files were removed. Select the files again to start a new upload.');
    }
  }
  if (receipt.status === 'COMPLETE') return replay ? replay(receipt.result) : receipt.result;
  if (respondAsync && !running(receipt) && activeUploads.size >= 4) {
    throw new ApiError('UPLOAD_QUEUE_BUSY', 'The store is processing other photo batches. Your selected photos are kept; retry shortly.', { statusCode: 503 });
  }
  const owner = crypto.randomUUID();
  const claimed = await Operation.findOneAndUpdate({ _id: id, fingerprint, status: { $in: ['PENDING', 'RUNNING'] },
    $or: [{ leaseUntil: { $lte: new Date() } }, { leaseUntil: null }] },
  { $set: { status: 'RUNNING', owner, leaseUntil: new Date(Date.now() + leaseMs), progress: { phase: 'queued' } },
    $unset: { failure: '' }, $inc: { attempts: 1 } }, { new: true }).lean();
  if (!claimed) {
    if (respondAsync) {
      await onSettled?.();
      const latest = await Operation.findById(id).lean();
      if (!latest) throw new ApiError('NOT_FOUND', 'No previous upload was found for this selection.');
      if (latest.status === 'REMOVED') throw conflict('These uploaded files or drafts were removed. Start a new upload.');
      if (latest.status === 'COMPLETE') return replay ? replay(latest.result) : latest.result;
      return uploadStatus(latest);
    }
    throw conflict('This upload is still being processed. Wait a moment and retry; your photos will not be uploaded twice.', 'UPLOAD_IN_PROGRESS');
  }
  const owned = { _id: id, owner, status: 'RUNNING' };
  // Recheck after the database claim: concurrent requests may have passed the
  // earlier capacity check before any worker was registered in this process.
  if (respondAsync && activeUploads.size >= 4) {
    await Operation.updateOne(owned, { $set: { status: 'PENDING' }, $unset: { owner: '', leaseUntil: '' } });
    throw new ApiError('UPLOAD_QUEUE_BUSY', 'The store is processing other photo batches. Your selected photos are kept; retry shortly.', { statusCode: 503 });
  }
  const heartbeat = setInterval(() => { Operation.updateOne(owned, { $set: { leaseUntil: new Date(Date.now() + leaseMs) } }).catch(() => {}); }, 20000);
  heartbeat.unref?.();
  const fields = { requestId: req.requestId, userId: String(req.user._id), operationId: id, fileCount: claimed.fileCount };
  const execute = async () => {
    log('info', 'Photo upload processing started', fields);
    try {
      const result = await work({ managed: true, id, resume, storedFiles: claimed.files, fields: claimed.fields,
        progress: async progress => {
          const updated = await Operation.updateOne(owned, { $set: { progress } });
          if (!updated.matchedCount) throw conflict('Upload ownership changed. Please retry.');
          log('info', 'Photo upload progress', { ...fields, ...progress, completedFiles: claimed.files.filter(Boolean).length });
        },
        upload: async (file, index, save) => {
          if (claimed.files[index]) return claimed.files[index];
          const uploadId = hash(`${id}:${index}:${digests[index]}`);
          const saved = await save({ uploadId, recovering: claimed.attempts > 1 });
          if (!saved?.url && !saved?.fileUrl) throw new ApiError('SERVICE_UNAVAILABLE', 'Storage did not return an uploaded file. Please retry.');
          const updated = await Operation.updateOne(owned, { $set: { [`files.${index}`]: saved } });
          if (!updated.matchedCount) throw conflict('Upload ownership changed. Please retry.');
          claimed.files[index] = saved;
          return saved;
        },
      });
      const updated = await Operation.updateOne(owned, { $set: { status: 'COMPLETE', result, progress: { phase: 'complete' } }, $unset: { owner: '', leaseUntil: '' } });
      if (!updated.matchedCount) throw conflict('Upload ownership changed. Please retry.');
      log('info', 'Photo upload processing completed', fields);
      return result;
    } catch (error) {
      const failure = { message: error instanceof ApiError && error.statusCode < 500 ? error.message
        : 'Photo processing or storage could not complete. Retry with the same photos; completed uploads are retained.' };
      await Operation.updateOne(owned, { $set: { status: 'PENDING', failure }, $unset: { owner: '', leaseUntil: '' } }).catch(() => {});
      log('error', 'Photo upload processing failed', { ...fields, errorCode: error.errorCode || 'UPLOAD_FAILED' });
      throw error;
    } finally { clearInterval(heartbeat); await onSettled?.(); }
  };
  if (!respondAsync) return execute();
  // The multipart request is fully staged before acceptance. Durable receipts
  // make retries safe after response loss/restart; originals stay staged until
  // the worker settles, and the browser retains its selection on failure.
  const task = execute().catch(() => {}).finally(() => activeUploads.delete(task));
  activeUploads.add(task);
  return uploadStatus(claimed);
}

async function persistLocal(file, options = {}) {
  file = await require('./photoCompressionService').preparePhotoFile(file);
  const extension = file.mimetype === 'image/webp' ? '.webp' : file.mimetype === 'image/png' ? '.png' : ['image/jpeg', 'image/jpg'].includes(file.mimetype) ? '.jpg' : path.extname(file.originalname || '').replace(/[^.a-z0-9]/gi, '').slice(0, 12) || '.bin';
  const base = path.basename(file.filename || file.originalname || 'media').replace(/[^a-z0-9._-]/gi, '-').replace(/\.[^.]+$/, '');
  const name = options.uploadId ? `retry-${options.uploadId}${extension.toLowerCase()}` : `${crypto.randomUUID()}-${base}${extension.toLowerCase()}`;
  const target = path.join(__dirname, '..', 'uploads', name);
  const size = Number(file.size || 0) || (await fs.stat(file.path)).size;
  const existing = options.recovering ? await fs.stat(target).catch(() => null) : null;
  if (!existing || existing.size !== size) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const staging = `${target}-${crypto.randomUUID()}.part`;
    try { if (file.buffer) await fs.writeFile(staging, file.buffer); else await fs.copyFile(file.path, staging); await fs.rename(staging, target); }
    finally { await fs.unlink(staging).catch(() => {}); }
  }
  return { url: `/uploads/${name}`, publicId: name, originalName: file.originalname, mimeType: file.mimetype, sizeBytes: file.size, provider: 'local' };
}
async function invalidateStoredUpload(provider, publicId) {
  if (Operation.db.readyState !== 1) return;
  await Operation.updateMany({ $or: [{ files: { $elemMatch: { provider, publicId } } }, { 'files.variants': { $elemMatch: { provider, publicId } } }] }, { $set: { status: 'REMOVED' } });
}
module.exports = { runUploadRequest, getUploadStatus, waitForActiveUploads, persistLocal, invalidateStoredUpload, fileDigest, storageFingerprint };
