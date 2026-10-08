const router = require('express').Router();
const fs = require('fs/promises');
const path = require('path');
const multer = require('multer');
const upload = require('../middleware/uploadMiddleware');
const { protect } = require('../middleware/authMiddleware');
const { adminOnly } = require('../middleware/adminMiddleware');
const { isR2Configured, uploadFileToR2, uploadImageToR2 } = require('../services/r2Upload');
const { isCloudinaryConfigured, uploadImage, uploadVideo } = require('../services/cloudinaryUpload');
const { isLocalRequest } = require('../utils/imageUtils');
const { badRequest } = require('../utils/apiError');
const background = require('../services/imageBackgroundService');
const { uploadMedia } = require('../services/mediaUploadService');
const { rateLimit } = require('express-rate-limit');
const backgroundUpload = require('../middleware/photoUploadMiddleware').createPhotoUpload({ files: 1, fields: 0 });
const backgroundLimit = rateLimit({ windowMs: 60000, limit: 10, standardHeaders: true, legacyHeaders: false });

const uploadDir = path.join(__dirname, '..', 'uploads');
const videoUpload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      cb(null, uploadDir);
    },
    filename(req, file, cb) {
      const safeName = file.originalname.replace(/[^a-z0-9.]+/gi, '-').toLowerCase();
      cb(null, `${require('crypto').randomUUID()}-${safeName}`);
    },
  }),
  fileFilter(req, file, cb) {
    const allowedTypes = ['video/mp4', 'video/webm', 'video/quicktime'];
    if (!allowedTypes.includes(file.mimetype)) return cb(badRequest('Only mp4, webm and mov videos are allowed'));
    cb(null, true);
  },
  limits: { fileSize: 250 * 1024 * 1024, files: 2 },
});

function adminOnlyUpload(req, res, next) {
  if (req.storeMember) return next();
  return adminOnly(req, res, next);
}

function requiresPersistentStorage(req) {
  return process.env.NODE_ENV === 'production' && !isLocalRequest(req);
}

function getActiveUploadProvider() {
  if (isR2Configured()) return 'r2';
  if (isCloudinaryConfigured()) return 'cloudinary';
  return 'local';
}

function isReelImportFolder(folder = '') {
  return String(folder || '').toLowerCase().startsWith('reel-imports');
}

function storageUnavailable(res, kind) {
  return res.status(503).json({
    message: kind === 'reel'
      ? 'Reel Product Import needs Cloudflare R2 or Cloudinary. Local disk storage is not enough for video processing.'
      : `Product ${kind} uploads must use Cloudflare R2 or Cloudinary in this environment. Please configure storage before uploading.`,
    code: 'PERSISTENT_UPLOAD_STORAGE_REQUIRED',
  });
}

async function persistUploads(req, { folder, toR2, toCloudinary }) {
  return uploadMedia(req, { folder: folder || req.query.folder, fileUpload: toR2 === uploadFileToR2 });
}

router.get('/background', protect, adminOnlyUpload, (req, res) => res.set('Cache-Control', 'no-store').json({ available: background.isConfigured() }));
router.post('/background/stored', protect, adminOnlyUpload, backgroundLimit, async (req, res, next) => {
  try {
    if (typeof req.body.url !== 'string' || req.body.url.length > 4096) throw badRequest('Choose a valid product photo.');
    res.set('Cache-Control', 'no-store');
    res.json(await background.removeStoredBackground(req.body.url));
  } catch (error) { next(error); }
});
router.post('/background', protect, adminOnlyUpload, backgroundLimit, backgroundUpload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) throw badRequest('Choose a product image.');
    res.set('Cache-Control', 'no-store');
    res.json(await background.removeBackground(await fs.readFile(req.file.path)));
  } catch (error) { next(error); }
  finally { if (req.file?.path) await fs.unlink(req.file.path).catch(() => {}); }
});

router.post('/', protect, adminOnlyUpload, (req, res, next) => {
  upload.array('images', 8)(req, res, async (error) => {
    if (error) return next(error);

    try {
      if (!req.files?.length && req.body?.resumeUpload !== true) {
        return res.status(400).json({ message: 'No images were uploaded. Please select at least one image file.' });
      }
      if (!isR2Configured() && !isCloudinaryConfigured() && requiresPersistentStorage(req)) {
        await cleanupTempFiles(req.files);
        return storageUnavailable(res, 'image');
      }
      const files = await persistUploads(req, { toR2: uploadImageToR2, toCloudinary: uploadImage });
      if (!files.length) return res.status(400).json({ message: 'No image was uploaded. Please try again.' });
      return res.status(201).json({ files, provider: getActiveUploadProvider() });
    } catch (uploadError) {
      await cleanupTempFiles(req.files);
      return next(uploadError);
    }
  });
});

router.post('/videos', protect, adminOnlyUpload, (req, res, next) => {
  videoUpload.array('videos', 2)(req, res, async (error) => {
    if (error) return next(error);

    try {
      if (!req.files?.length && req.body?.resumeUpload !== true) {
        return res.status(400).json({ message: 'No videos were uploaded. Please select at least one video file.' });
      }
      const folder = req.query.folder || 'product-videos';
      const reelFolder = isReelImportFolder(folder);
      if (!isR2Configured() && !isCloudinaryConfigured() && (requiresPersistentStorage(req) || reelFolder)) {
        await cleanupTempFiles(req.files);
        return storageUnavailable(res, reelFolder ? 'reel' : 'video');
      }
      const files = await persistUploads(req, {
        folder,
        toR2: uploadFileToR2,
        toCloudinary: uploadVideo,
      });
      if (!files.length) return res.status(400).json({ message: 'No video was uploaded. Please try again.' });
      return res.status(201).json({ files, provider: getActiveUploadProvider() });
    } catch (uploadError) {
      await cleanupTempFiles(req.files);
      return next(uploadError);
    }
  });
});

async function cleanupTempFiles(files = []) {
  await Promise.all((files || []).map((file) => fs.unlink(file.path).catch(() => null)));
}

module.exports = router;
