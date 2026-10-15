const fs = require('fs/promises');
const upload = require('../middleware/uploadMiddleware');
const { isR2Configured } = require('../services/r2Upload');
const { ApiError } = require('../utils/apiError');
const { uploadMedia } = require('../services/mediaUploadService');

async function cleanup(files = []) {
  await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => null)));
}

async function assertRealImages(files = []) {
  for (const file of files) {
    const header = await fs.readFile(file.path).then((value) => value.subarray(0, 16));
    const isJpeg = header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
    const isPng = header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const isWebp = header.length >= 12 && header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP';
    if (!isJpeg && !isPng && !isWebp) throw new ApiError('VALIDATION_ERROR', 'One or more files are not valid JPG, PNG, or WEBP images');
  }
}

exports.middleware = (req, res, next) => upload.array('images', 4)(req, res, next);

exports.uploadReviewPhotos = async function uploadReviewPhotos(req, res, next) {
  try {
    if (!req.files?.length && req.body?.resumeUpload !== true) throw new ApiError('VALIDATION_ERROR', 'Choose at least one review photo');
    await assertRealImages(req.files || []);
    if (!isR2Configured()) {
      await cleanup(req.files);
      throw new ApiError('PERSISTENT_UPLOAD_STORAGE_REQUIRED', 'Connect Cloudflare R2 before uploading review photos.', { statusCode: 503 });
    }
    const files = await uploadMedia(req, { folder: 'reviews' });
    res.status(201).json({ files: files.map((file) => ({ url: file.url, publicId: file.publicId, mimeType: file.mimeType, sizeBytes: file.sizeBytes, provider: 'r2' })) });
  } catch (error) {
    await cleanup(req.files || []);
    next(error);
  }
};
