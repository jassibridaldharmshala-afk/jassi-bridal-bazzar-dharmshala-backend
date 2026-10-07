const mongoose = require('mongoose');
const { ApiError } = require('./apiError');
const { normalizeIndianMobile } = require('./phoneUtils');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INDIAN_MOBILE_PATTERN = /^[6-9]\d{9}$/;
const PINCODE_PATTERN = /^\d{6}$/;
const COUPON_CODE_PATTERN = /^[A-Z0-9_-]{3,32}$/;

function fail(message, field) {
  throw new ApiError('VALIDATION_ERROR', message, { details: field ? { field } : undefined });
}

function requireObjectId(value, field = 'id') {
  const id = String(value || '').trim();
  if (!mongoose.Types.ObjectId.isValid(id)) fail(`A valid ${field} is required`, field);
  return id;
}

function optionalObjectId(value, field = 'id') {
  if (value === undefined || value === null || value === '') return '';
  return requireObjectId(value, field);
}

function requireString(value, field, { min = 1, max = 500 } = {}) {
  const text = String(value ?? '').trim();
  if (text.length < min) fail(`${field} is required`, field);
  if (text.length > max) fail(`${field} must be ${max} characters or fewer`, field);
  return text;
}

function optionalString(value, field, { max = 500 } = {}) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (text.length > max) fail(`${field} must be ${max} characters or fewer`, field);
  return text;
}

function requireEmail(value, field = 'email') {
  const email = String(value || '').trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email)) fail('Please enter a valid email address', field);
  return email;
}

function optionalEmail(value, field = 'email') {
  if (!String(value || '').trim()) return '';
  return requireEmail(value, field);
}

function requireIndianMobile(value, field = 'phone') {
  const local = normalizeIndianMobile(value);
  if (!INDIAN_MOBILE_PATTERN.test(local)) fail('Please enter a valid 10-digit mobile number', field);
  return local;
}

function optionalIndianMobile(value, field = 'phone') {
  if (!String(value || '').replace(/\D/g, '')) return '';
  return requireIndianMobile(value, field);
}

function requirePincode(value, field = 'pincode') {
  const pincode = String(value || '').replace(/\D/g, '');
  if (!PINCODE_PATTERN.test(pincode)) fail('Please enter a valid 6-digit pincode', field);
  return pincode;
}

function requireQuantity(value, field = 'quantity', { min = 1, max = 20 } = {}) {
  const quantity = Number(value);
  if (!Number.isInteger(quantity) || quantity < min || quantity > max) {
    fail(`${field} must be a whole number between ${min} and ${max}`, field);
  }
  return quantity;
}

function requirePositiveAmount(value, field = 'amount', { max = 10000000 } = {}) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || amount > max) fail(`${field} is invalid`, field);
  return amount;
}

function requireCouponCode(value, field = 'code') {
  const code = String(value || '').trim().toUpperCase();
  if (!COUPON_CODE_PATTERN.test(code)) fail('Please enter a valid coupon code', field);
  return code;
}

function optionalCouponCode(value, field = 'code') {
  if (!String(value || '').trim()) return '';
  return requireCouponCode(value, field);
}

function requireRating(value, field = 'rating') {
  const rating = Number(value);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) fail('Rating must be between 1 and 5', field);
  return rating;
}

function requireEnum(value, allowed, field) {
  const item = String(value ?? '').trim();
  if (!allowed.includes(item)) fail(`${field} must be one of: ${allowed.join(', ')}`, field);
  return item;
}

function requireBoolean(value, field) {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fail(`${field} must be true or false`, field);
}

function requireArray(value, field, { min = 1, max = 100 } = {}) {
  if (!Array.isArray(value) || value.length < min) fail(`${field} is required`, field);
  if (value.length > max) fail(`${field} cannot contain more than ${max} entries`, field);
  return value;
}

function wantsPagination(query = {}) {
  return query.page !== undefined && query.page !== null && String(query.page).trim() !== '';
}

function readPagination(query = {}, { defaultLimit = 24, maxLimit = 100 } = {}) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const requestedLimit = Number.parseInt(query.limit, 10) || defaultLimit;
  const limit = Math.min(Math.max(1, requestedLimit), maxLimit);
  return { page, limit, skip: (page - 1) * limit };
}

function buildPaginatedResponse(items, { page, limit, total }) {
  return {
    items,
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}

module.exports = {
  COUPON_CODE_PATTERN,
  EMAIL_PATTERN,
  INDIAN_MOBILE_PATTERN,
  buildPaginatedResponse,
  fail,
  optionalCouponCode,
  optionalEmail,
  optionalIndianMobile,
  optionalObjectId,
  optionalString,
  readPagination,
  wantsPagination,
  requireArray,
  requireBoolean,
  requireCouponCode,
  requireEmail,
  requireEnum,
  requireIndianMobile,
  requireObjectId,
  requirePincode,
  requirePositiveAmount,
  requireQuantity,
  requireRating,
  requireString,
};
