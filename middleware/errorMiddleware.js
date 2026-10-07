const { ApiError } = require('../utils/apiError');
const { log } = require('../utils/logger');

function notFound(req, res, next) {
  const error = new ApiError('NOT_FOUND', `Not found - ${req.originalUrl}`);
  next(error);
}

function send(res, statusCode, code, message, extra = {}) {
  return res.status(statusCode).json({
    success: false,
    code,
    message,
    ...extra,
  });
}

function errorHandler(error, req, res, next) { // eslint-disable-line no-unused-vars
  if (error instanceof ApiError) {
    return send(res, error.statusCode, error.errorCode, error.message, error.details ? { details: error.details } : {});
  }
  if (error.code === 11000) {
    if ((error.keyPattern?.active && error.keyPattern?.orderItemId) || String(error.message || '').includes('one_active_return_per_order_item')) {
      return send(res, 409, 'DUPLICATE_REQUEST', 'An active return or exchange already exists for this order item.');
    }
    const field = Object.keys(error.keyValue || {})[0] || 'field';
    return send(res, 400, 'DUPLICATE_KEY', `${field} already exists`);
  }
  if (error.name === 'ValidationError') {
    return send(res, 400, 'VALIDATION_ERROR', Object.values(error.errors).map((item) => item.message).join(', '));
  }
  if (error.name === 'CastError') {
    return send(res, 400, 'VALIDATION_ERROR', `Invalid ${error.path}`);
  }
  if (error.type === 'entity.too.large' || error.statusCode === 413) {
    return send(res, 413, 'PAYLOAD_TOO_LARGE', 'The submitted data is too large. Upload media through the image or video uploader.');
  }
  if (error instanceof SyntaxError && error.type === 'entity.parse.failed') {
    return send(res, 400, 'INVALID_JSON', 'The request contains invalid JSON.');
  }
  if (/only .*evidence files are allowed/i.test(error.message || '') || /only jpg/i.test(error.message || '')) {
    return send(res, 400, 'VALIDATION_ERROR', error.message);
  }
  if (error.code === 'LIMIT_FILE_SIZE') {
    return send(res, 400, 'VALIDATION_ERROR', 'Uploaded file is too large.');
  }
  if (error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE') {
    const video = String(req.originalUrl || '').includes('/videos');
    return send(res, 400, 'VALIDATION_ERROR', video ? 'Too many videos uploaded. Maximum 2 videos are allowed.' : 'Too many images uploaded. Maximum 8 images are allowed.');
  }
  if (error.message?.includes('R2')) {
    return send(res, 502, 'STORAGE_ERROR', error.message);
  }

  const statusCode = error.statusCode || (res.statusCode === 200 ? 500 : res.statusCode);
  const isServerError = statusCode >= 500;
  const safeMessage = isServerError && process.env.NODE_ENV === 'production'
    ? 'The request could not be completed. Please try again.'
    : error.message;

  if (isServerError) {
    log('error', error.message, {
      requestId: req.requestId,
      userId: req.user?._id,
      storeId: req.store?._id,
      method: req.method,
      path: req.originalUrl,
    });
  }

  return send(res, statusCode, error.errorCode || error.code || (isServerError ? 'INTERNAL_ERROR' : 'REQUEST_FAILED'), safeMessage, {
    stack: process.env.NODE_ENV === 'production' ? undefined : error.stack,
  });
}

module.exports = { notFound, errorHandler };
