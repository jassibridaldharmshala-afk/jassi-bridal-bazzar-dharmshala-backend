const path = require('path');

const ALLOWED_MIME_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm']);
const ALLOWED_EXTENSIONS = new Set(['.mp4', '.mov', '.webm']);

function validateVideoFile(file) {
  if (!file || !file.size) return validationError('EMPTY_VIDEO', 'Please select a non-empty video file.');
  const extension = path.extname(String(file.originalname || '')).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension) || !ALLOWED_MIME_TYPES.has(String(file.mimetype || '').toLowerCase())) {
    return validationError('UNSUPPORTED_VIDEO_FORMAT', 'Only MP4, MOV, and WebM videos are supported.');
  }
  return null;
}

function safeOriginalFilename(value) {
  const basename = path.basename(String(value || 'product-reel'))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*]/g, '-')
    .trim();
  return (basename || 'product-reel').slice(0, 255);
}

function parsePagination(query = {}) {
  const page = Math.max(1, Math.min(100000, Number(query.page) || 1));
  const limit = Math.max(1, Math.min(50, Number(query.limit) || 12));
  return { page, limit, skip: (page - 1) * limit };
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function validationError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 400;
  return error;
}

module.exports = {
  ALLOWED_MIME_TYPES,
  escapeRegExp,
  parsePagination,
  safeOriginalFilename,
  validateVideoFile,
  validationError,
};
