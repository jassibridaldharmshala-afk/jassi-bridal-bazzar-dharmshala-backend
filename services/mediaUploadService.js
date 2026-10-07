const fs = require('node:fs/promises');
const r2 = require('./r2Upload');
const cloud = require('./cloudinaryUpload');
const { persistLocal, runUploadRequest } = require('./uploadRetryService');

async function storeFiles(req, context, { folder = req.query?.folder || 'products', fileUpload = false } = {}) {
  const incoming = req.files || [];
  const provider = r2.isR2Configured() ? 'r2' : cloud.isCloudinaryConfigured() ? 'cloudinary' : 'local';
  const result = [];
  // Bounded parallelism; settle every started write before staging-file cleanup.
  for (let start = 0; start < incoming.length; start += 3) {
    const chunk = await Promise.allSettled(incoming.slice(start, start + 3).map((file, offset) => context.upload(file, start + offset, async options => {
      const video = String(file.mimetype).startsWith('video/');
      const saved = provider === 'r2'
        ? await (video || fileUpload ? r2.uploadFileToR2 : r2.uploadImageToR2)(file, { ...options, folder })
        : provider === 'cloudinary'
          ? await (video ? cloud.uploadVideo : cloud.uploadImage)(file, { ...options, folder })
          : await persistLocal(file, options);
      return { ...saved, provider, mimeType: file.mimetype, sizeBytes: file.size };
    })));
    const failure = chunk.find(item => item.status === 'rejected');
    if (failure) throw failure.reason;
    result.push(...chunk.map(item => item.value));
  }
  return result;
}
async function cleanupStaging(files = []) {
  await Promise.all(files.map(file => file.path ? fs.unlink(file.path).catch(() => {}) : null));
}
async function uploadMedia(req, options = {}) {
  const resume = req.body?.resumeUpload === true && !req.files?.length;
  try { return await runUploadRequest(req, context => context.resume ? context.storedFiles : storeFiles(req, context, options), { resume }); }
  finally {
    if (r2.isR2Configured() || cloud.isCloudinaryConfigured() || req.get?.('Idempotency-Key')) await cleanupStaging(req.files);
  }
}
module.exports = { storeFiles, uploadMedia, cleanupStaging };
