const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const { getReelImportConfig } = require('../../config/reelImport');
const { protect } = require('../../middleware/authMiddleware');
const { adminOnly } = require('../../middleware/adminMiddleware');
const controller = require('./reelImport.controller');
const { ALLOWED_MIME_TYPES } = require('./reelImport.validation');

const router = express.Router();
const config = getReelImportConfig();
const tempDir = path.join(os.tmpdir(), 'samira-reel-imports');
fs.mkdirSync(tempDir, { recursive: true, mode: 0o700 });

const upload = multer({
  storage: multer.diskStorage({
    destination(req, file, callback) {
      callback(null, tempDir);
    },
    filename(req, file, callback) {
      const extension = path.extname(String(file.originalname || '')).toLowerCase().replace(/[^a-z0-9.]/g, '');
      callback(null, `${crypto.randomUUID()}${extension}`);
    },
  }),
  limits: { files: 1, fileSize: config.maxFileSizeMb * 1024 * 1024 },
  fileFilter(req, file, callback) {
    if (!ALLOWED_MIME_TYPES.has(String(file.mimetype || '').toLowerCase())) {
      const error = new Error('Only MP4, MOV, and WebM videos are supported.');
      error.code = 'UNSUPPORTED_VIDEO_FORMAT';
      return callback(error);
    }
    return callback(null, true);
  },
});

const standardLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, message: 'Too many reel import requests. Please wait and try again.' },
});
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, message: 'Too many reel uploads. Please wait before uploading again.' },
});

router.use(protect, adminOnly, standardLimiter);
router.get('/capabilities', controller.getUploadCapabilities);
router.post('/upload-url', controller.getUploadCapabilities);
router.post('/', uploadLimiter, upload.single('video'), controller.createImport);
router.get('/', controller.listImports);
router.get('/:jobId', controller.getImport);
router.get('/:jobId/candidates', controller.listCandidates);
router.post('/:jobId/retry', controller.retryImport);
router.post('/:jobId/cancel', controller.cancelImport);
router.delete('/:jobId', controller.deleteImport);
router.patch('/:jobId/candidates/:candidateId', controller.updateCandidate);
router.post('/:jobId/candidates/:candidateId/analyze', controller.analyzeCandidate);
router.post('/:jobId/candidates/merge', controller.mergeCandidates);
router.post('/:jobId/candidates/:candidateId/split', controller.splitCandidate);
router.post('/:jobId/candidates/:candidateId/move-frame', controller.moveFrame);
router.post('/:jobId/create-drafts', controller.createDrafts);

module.exports = router;
