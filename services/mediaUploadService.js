const fs = require('node:fs/promises');
const r2 = require('./r2Upload');
const cloud = require('./cloudinaryUpload');
const { persistLocal, runUploadRequest } = require('./uploadRetryService');
const crypto = require('node:crypto');
const { preparePhotoFile, responsivePhotoVariants } = require('./photoCompressionService');

async function storeFiles(req, context, { folder = req.query?.folder || 'products', fileUpload = false } = {}) {
  const incoming = req.files || [];
  const provider = r2.isR2Configured() ? 'r2' : cloud.isCloudinaryConfigured() ? 'cloudinary' : 'local';
  const result = [];
  // Bounded parallelism; settle every started write before staging-file cleanup.
  for (let start = 0; start < incoming.length; start += 1) {
    const chunk = await Promise.allSettled(incoming.slice(start, start + 1).map((file, offset) => context.upload(file, start + offset, async options => {
      file = await preparePhotoFile(file);
      const video = String(file.mimetype).startsWith('video/');
      const saved = provider === 'r2'
        ? await (video || fileUpload ? r2.uploadFileToR2 : r2.uploadImageToR2)(file, { ...options, folder })
        : provider === 'cloudinary'
          ? await (video ? cloud.uploadVideo : cloud.uploadImage)(file, { ...options, folder })
          : await persistLocal(file, options);
      const metadata = { ...saved, provider, mimeType: file.mimetype, sizeBytes: file.size, ...(file.photo ? { width: file.photo.width, height: file.photo.height } : {}) };
      if (String(file.mimetype).startsWith('image/')) {
        metadata.variants = [];
        for (const variant of await responsivePhotoVariants(file)) {
          const derivativeId = crypto.createHash('sha256').update(`${options.uploadId || saved.publicId}:display-v1:${variant.width}`).digest('hex');
          const derivativeOptions = { ...options, folder, uploadId: derivativeId };
          const display = provider === 'r2' ? await r2.uploadImageToR2(variant, derivativeOptions)
            : provider === 'cloudinary' ? await cloud.uploadImage(variant, derivativeOptions) : await persistLocal(variant, derivativeOptions);
          metadata.variants.push({ ...display, provider, width: variant.width, height: variant.height, mimeType: variant.mimetype, sizeBytes: variant.size });
        }
      }
      return metadata;
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
    // Local images are now saved atomically to a separate destination, too.
    await cleanupStaging(req.files);
  }
}
module.exports = { storeFiles, uploadMedia, cleanupStaging };
