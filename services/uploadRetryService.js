const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const Operation = require('../models/UploadOperation');
const { ApiError } = require('../utils/apiError');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const leaseMs = 15 * 60 * 1000;

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
async function runUploadRequest(req, work, { replay, resume = false, recordOnly = false } = {}) {
  const key = req.get?.('Idempotency-Key') || req.headers?.['idempotency-key'];
  if (!key) {
    if (resume) throw new ApiError('VALIDATION_ERROR', 'An upload retry key is required.');
    return work({ managed: false, upload: (file, index, save) => save({}) });
  }
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(key)) throw new ApiError('VALIDATION_ERROR', 'Invalid upload retry key.');
  if (!req.user?._id) throw new ApiError('UNAUTHORIZED', 'Sign in before uploading files.');
  const id = hash(JSON.stringify([String(req.store?._id || req.socialStore?._id || ''), String(req.user._id), req.originalUrl?.split('?')[0] || req.baseUrl + req.path, key]));
  const digests = resume ? [] : await Promise.all((req.files || []).map(fileDigest));
  let fingerprint = resume ? '' : hash(JSON.stringify(stable({
    query: req.query, fields: req.body,
    files: (req.files || []).map((file, index) => [digests[index], file.mimetype, file.originalname]),
    ...(!recordOnly ? { storage: storageFingerprint() } : {}),
  })));
  if (!resume) {
    try {
      await Operation.updateOne({ _id: id }, { $setOnInsert: { fingerprint, status: 'PENDING', files: [], fileCount: req.files?.length || 0,
        fields: recordOnly ? {} : req.body || {}, query: req.query || {}, storage: recordOnly ? '' : storageFingerprint() } }, { upsert: true });
    } catch (error) { if (error.code !== 11000) throw error; }
  }
  const receipt = await Operation.findById(id).lean();
  if (!receipt) throw new ApiError('NOT_FOUND', 'No previous upload was found for this selection.');
  if (resume) {
    if (receipt.storage !== storageFingerprint() || JSON.stringify(stable(receipt.query || {})) !== JSON.stringify(stable(req.query || {}))) throw conflict('Upload storage/settings changed. Start a new upload.');
    if (!receipt.fileCount || receipt.files.filter(Boolean).length !== receipt.fileCount) throw conflict('Some photos were not uploaded yet. Continue with the selected files.', 'UPLOAD_INCOMPLETE');
    fingerprint = receipt.fingerprint;
  }
  if (receipt.fingerprint !== fingerprint) throw conflict('The selected files or upload settings changed. Start a new upload.');
  if (receipt.status === 'REMOVED') throw conflict('These uploaded files were removed. Select the files again to start a new upload.');
  // Local images can also be removed by reference-aware product/draft cleanup.
  for (const file of receipt.files.filter(Boolean)) {
    if (file.provider === 'local' && !await fs.access(path.join(__dirname, '..', 'uploads', path.basename(file.publicId))).then(() => true, () => false)) {
      await Operation.updateOne({ _id: id }, { $set: { status: 'REMOVED' } });
      throw conflict('These uploaded files were removed. Select the files again to start a new upload.');
    }
  }
  if (receipt.status === 'COMPLETE') return replay ? replay(receipt.result) : receipt.result;
  const owner = crypto.randomUUID();
  const claimed = await Operation.findOneAndUpdate({ _id: id, fingerprint, status: { $in: ['PENDING', 'RUNNING'] },
    $or: [{ leaseUntil: { $lte: new Date() } }, { leaseUntil: null }] },
  { $set: { status: 'RUNNING', owner, leaseUntil: new Date(Date.now() + leaseMs) }, $inc: { attempts: 1 } }, { new: true }).lean();
  if (!claimed) throw conflict('This upload is still being processed. Wait a moment and retry; your photos will not be uploaded twice.', 'UPLOAD_IN_PROGRESS');
  const owned = { _id: id, owner, status: 'RUNNING' };
  const heartbeat = setInterval(() => { Operation.updateOne(owned, { $set: { leaseUntil: new Date(Date.now() + leaseMs) } }).catch(() => {}); }, 30000);
  heartbeat.unref?.();
  try {
    const result = await work({ managed: true, id, resume, storedFiles: claimed.files, fields: claimed.fields,
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
    const updated = await Operation.updateOne(owned, { $set: { status: 'COMPLETE', result }, $unset: { owner: '', leaseUntil: '' } });
    if (!updated.matchedCount) throw conflict('Upload ownership changed. Please retry.');
    return result;
  } catch (error) {
    await Operation.updateOne(owned, { $set: { status: 'PENDING' }, $unset: { owner: '', leaseUntil: '' } }).catch(() => {});
    throw error;
  } finally { clearInterval(heartbeat); }
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
  await Operation.updateMany({ files: { $elemMatch: { provider, publicId } } }, { $set: { status: 'REMOVED' } });
}
module.exports = { runUploadRequest, persistLocal, invalidateStoredUpload, fileDigest, storageFingerprint };
