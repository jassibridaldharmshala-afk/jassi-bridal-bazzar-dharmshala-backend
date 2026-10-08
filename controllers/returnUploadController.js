const fs = require('fs/promises');
const upload = require('../middleware/uploadMiddleware');
const { isR2Configured } = require('../services/r2Upload');
const { isCloudinaryConfigured } = require('../services/cloudinaryUpload');
const { isLocalRequest } = require('../utils/imageUtils');
const { ApiError } = require('../utils/apiError');
const { uploadMedia } = require('../services/mediaUploadService');

async function cleanup(files = []) {
  await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => null)));
}

async function assertRealImages(files = []) {
  for (const file of files) {
    const header = await fs.readFile(file.path).then((value) => value.subarray(0, 16));
    const jpeg = header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
    const png = header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const webp = header.length >= 12 && header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP';
    if (!jpeg && !png && !webp) throw new ApiError('VALIDATION_ERROR', 'One or more files are not valid JPG, PNG, or WEBP images.');
  }
}

exports.middleware = (req, res, next) => upload.array('images', 5)(req, res, next);

exports.uploadReturnEvidence = async function uploadReturnEvidence(req, res, next) {
  try {
    if (!req.files?.length && req.body?.resumeUpload !== true) throw new ApiError('VALIDATION_ERROR', 'Choose at least one return photo.');
    await assertRealImages(req.files || []);
    if (!isR2Configured() && !isCloudinaryConfigured() && process.env.NODE_ENV === 'production' && !isLocalRequest(req)) {
      throw new ApiError('PERSISTENT_UPLOAD_STORAGE_REQUIRED', 'Return evidence needs Cloudflare R2 or Cloudinary in production.', { statusCode: 503 });
    }
    const files = await uploadMedia(req, { folder: 'returns' });
    res.status(201).json({ files: files.map((file) => ({ url: file.url, publicId: file.publicId, mimeType: file.mimeType, sizeBytes: file.sizeBytes, provider: file.provider || (isR2Configured() ? 'r2' : isCloudinaryConfigured() ? 'cloudinary' : 'local') })) });
  } catch (error) {
    await cleanup(req.files || []);
    next(error);
  }
};
