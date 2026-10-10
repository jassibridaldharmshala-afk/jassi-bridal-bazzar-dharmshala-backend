/**
 * Typed application errors so controllers can fail with a stable machine
 * readable `code` while the error middleware owns the HTTP response shape.
 */

const ERROR_CODES = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  DUPLICATE_REQUEST: 409,
  CATEGORY_IN_USE: 409,
  OUT_OF_STOCK: 409,
  VARIANT_UNAVAILABLE: 409,
  ORDER_NOT_CANCELLABLE: 409,
  ORDER_TRANSITION_INVALID: 409,
  ORDER_CHANGED: 409,
  INVENTORY_CHANGED: 409,
  PURCHASE_ORDER_CHANGED: 409,
  INVALID_COUPON: 400,
  COUPON_EXPIRED: 400,
  PAYMENT_FAILED: 400,
  PAYMENT_SETUP_REJECTED: 400,
  RENTAL_QUOTE_CHANGED: 409,
  RENTAL_ALREADY_BOOKED: 409,
  PAYMENT_METHOD_UNAVAILABLE: 400,
  SUBSCRIPTION_REQUIRED: 402,
  PLAN_FEATURE_REQUIRED: 403,
  PLAN_LIMIT_REACHED: 409,
  CHECKOUT_RESTRICTED: 403,
  COD_RESTRICTED: 403,
  CUSTOMER_CHANGED: 409,
  STORE_REQUIRED: 400,
  RETURN_WINDOW_EXPIRED: 400,
  SERVICE_UNAVAILABLE: 503,
};

class ApiError extends Error {
  constructor(code, message, { statusCode, details } = {}) {
    super(message);
    this.name = 'ApiError';
    this.errorCode = code;
    this.statusCode = statusCode || ERROR_CODES[code] || 400;
    if (details) this.details = details;
  }
}

const badRequest = (message, code = 'VALIDATION_ERROR', details) => new ApiError(code, message, { details });
const forbidden = (message = 'Not allowed') => new ApiError('FORBIDDEN', message);
const notFound = (message = 'Resource not found') => new ApiError('NOT_FOUND', message);
const outOfStock = (message = 'Selected item is no longer available') => new ApiError('OUT_OF_STOCK', message);
const unauthorized = (message = 'Not authorized') => new ApiError('UNAUTHORIZED', message);

module.exports = {
  ApiError,
  ERROR_CODES,
  badRequest,
  forbidden,
  notFound,
  outOfStock,
  unauthorized,
};
