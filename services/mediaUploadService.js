const fs = require('node:fs/promises');
const r2 = require('./r2Upload');
const cloud = require('./cloudinaryUpload');
const { persistLocal, runUploadRequest } = require('./uploadRetryService');
const crypto = require('node:crypto');
const { preparePhotoFile, responsivePhotoVariants } = require('./photoCompressionService');

// Bound encoded photo buffers and provider writes across concurrent requests,
// while Sharp's separate global queue bounds decoded raster memory.
let activeStores = 0;
const waitingStores = [];
async function withStorageSlot(work) {
  if (activeStores < 2) activeStores++;
  else await new Promise(resolve => waitingStores.push(resolve));
  try { return await work(); }
  finally {
    const next = waitingStores.shift();
    if (next) next();
    else activeStores--;
  }
}

async function storeFiles(req, context, { folder = req.query?.folder || 'products', fileUpload = false } = {}) {
  const incoming = req.files || [];
  const provider = r2.isR2Configured() ? 'r2' : cloud.isCloudinaryConfigured() ? 'cloudinary' : 'local';
  const result = [];
  // CPU decoding remains globally serial; overlap at most two storage writes.
  // Settle every started write before staging-file cleanup on a partial failure.
  for (let start = 0; start < incoming.length; start += 2) {
    const chunk = await Promise.allSettled(incoming.slice(start, start + 2).map((file, offset) => context.upload(file, start + offset, options => withStorageSlot(async () => {
      const photoIndex = start + offset + 1;
      await context.progress?.({ phase: 'optimizing', photoIndex });
      file = await preparePhotoFile(file);
      const video = String(file.mimetype).startsWith('video/');
      await context.progress?.({ phase: 'storing-original', photoIndex });
      const saved = provider === 'r2'
        ? await (video || fileUpload ? r2.uploadFileToR2 : r2.uploadImageToR2)(file, { ...options, folder })
        : provider === 'cloudinary'
          ? await (video ? cloud.uploadVideo : cloud.uploadImage)(file, { ...options, folder })
          : await persistLocal(file, options);
      const metadata = { ...saved, provider, mimeType: file.mimetype, sizeBytes: file.size, ...(file.photo ? { width: file.photo.width, height: file.photo.height } : {}) };
      if (String(file.mimetype).startsWith('image/')) {
        metadata.variants = [];
        await context.progress?.({ phase: 'creating-displays', photoIndex });
        const variants = await responsivePhotoVariants(file);
        await context.progress?.({ phase: 'storing-displays', photoIndex });
        for (const variant of variants) {
          const derivativeId = crypto.createHash('sha256').update(`${options.uploadId || saved.publicId}:display-v1:${variant.width}`).digest('hex');
          const derivativeOptions = { ...options, folder, uploadId: derivativeId };
          const display = provider === 'r2' ? await r2.uploadImageToR2(variant, derivativeOptions)
            : provider === 'cloudinary' ? await cloud.uploadImage(variant, derivativeOptions) : await persistLocal(variant, derivativeOptions);
          metadata.variants.push({ ...display, provider, width: variant.width, height: variant.height, mimeType: variant.mimetype, sizeBytes: variant.size });
        }
      }
      return metadata;
    }))));
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
