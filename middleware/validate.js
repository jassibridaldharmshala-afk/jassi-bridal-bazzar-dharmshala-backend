const { ApiError } = require('../utils/apiError');
const { requireObjectId } = require('../utils/validators');

/**
 * Wraps an async handler so thrown ApiErrors reach the central error handler
 * instead of becoming unhandled rejections.
 */
function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

/**
 * Runs a validator against the request and stores the sanitised result on
 * `req.validated`. Validators throw ApiError on the first problem.
 */
function validate(validator) {
  return (req, res, next) => {
    try {
      req.validated = { ...(req.validated || {}), ...(validator(req) || {}) };
      next();
    } catch (error) {
      next(error instanceof ApiError ? error : new ApiError('VALIDATION_ERROR', error.message));
    }
  };
}

/** Rejects malformed ids before they reach Mongoose and produce a CastError. */
function validateObjectIdParam(paramName = 'id') {
  return (req, res, next) => {
    try {
      requireObjectId(req.params[paramName], paramName);
      next();
    } catch (error) {
      next(error);
    }
  };
}

module.exports = { asyncHandler, validate, validateObjectIdParam };
