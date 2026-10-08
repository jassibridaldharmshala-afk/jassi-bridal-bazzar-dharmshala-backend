const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Transform, pipeline } = require('node:stream');
const multer = require('multer');
const { ApiError } = require('../utils/apiError');
const { PHOTO_SOURCE_MAX_BYTES, PHOTO_BATCH_MAX_BYTES } = require('../services/photoCompressionService');
const uploadDir = path.join(__dirname, '../uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const totalBytes = Symbol('photoUploadBytes');
const abortHandlers = Symbol('photoUploadAbortHandlers');
const allowed = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);

function onUploadAbort(req, handler) {
  if (!req[abortHandlers]) {
    const handlers = new Set();
    const abort = () => handlers.forEach(callback => callback());
    req[abortHandlers] = { handlers, abort };
    req.once('aborted', abort);
  }
  const state = req[abortHandlers];
  state.handlers.add(handler);
  if (req.aborted) handler();
  return () => {
    state.handlers.delete(handler);
    if (!state.handlers.size) { req.removeListener('aborted', state.abort); delete req[abortHandlers]; }
  };
}

// Stage originals on disk, with a streaming aggregate limit. Allowing a 20 MB
// photo must not turn a 30-photo request into a 600 MB in-memory upload.
function createPhotoUpload({ files = 8, fields = 20, maxFileBytes = PHOTO_SOURCE_MAX_BYTES, privateEvidence = false, allowVideo = false } = {}) {
  const directory = privateEvidence ? path.join(require('node:os').tmpdir(), 'jassi-private-evidence') : uploadDir;
  fs.mkdirSync(directory, { recursive: true });
  const storage = {
    _handleFile(req, file, cb) {
      const filename = `${randomUUID()}-${file.originalname.replace(/[^a-z0-9.]+/gi, '-').toLowerCase()}`;
      const target = path.join(directory, filename);
      let size = 0;
      const meter = new Transform({ transform(chunk, _encoding, next) {
        req[totalBytes] = (req[totalBytes] || 0) + chunk.length;
        size += chunk.length;
        if (req[totalBytes] > PHOTO_BATCH_MAX_BYTES) return next(new ApiError('UPLOAD_PHOTO_BATCH_TOO_LARGE', 'Choose up to 60 MB of photos per upload. Upload the remaining photos in another batch.', { statusCode: 400 }));
        next(null, chunk);
      } });
      // Pipeline only the metered output: validation failure must not destroy
      // the multipart input before Multer can drain it and remove earlier files.
      const output = fs.createWriteStream(target, { flags: 'wx' });
      let inputFailed = false;
      const inputError = error => { inputFailed = true; meter.destroy(error); };
      file.stream.once('error', inputError);
      const stopWatchingAbort = onUploadAbort(req, () => meter.destroy(new Error('Photo upload interrupted.')));
      pipeline(meter, output, error => {
        stopWatchingAbort();
        file.stream.removeListener('error', inputError);
        file.stream.unpipe(meter);
        if (error) {
          file.stream.resume();
          // Multer already accounts for an input-stream error itself.
          fs.unlink(target, () => { if (!inputFailed) cb(error); });
        } else cb(null, { destination: directory, filename, path: target, size });
      });
      file.stream.pipe(meter);
    },
    _removeFile(_req, file, cb) { fs.unlink(file.path, error => cb(error?.code === 'ENOENT' ? null : error)); },
  };
  // Busboy emits its limit at equality; the extra byte makes the advertised
  // maximum inclusive while any larger file is still rejected by Multer.
  return multer({ storage, fileFilter(_req, file, cb) {
    if (!allowed.has(file.mimetype) && !(allowVideo && ['video/mp4', 'video/webm', 'video/quicktime'].includes(file.mimetype))) return cb(new ApiError('UPLOAD_IMAGE_INVALID', 'Only JPG, JPEG, PNG and WebP photos are allowed.', { statusCode: 400 }));
    cb(null, true);
  }, limits: { fileSize: maxFileBytes + 1, files, fields, fieldSize: 64 * 1024 } });
}

module.exports = { createPhotoUpload };
