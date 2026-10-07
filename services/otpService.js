const crypto = require('crypto');
const mongoose = require('mongoose');
const Otp = require('../models/Otp');
const { normalizePhone, requireValidPhone } = require('../utils/phoneUtils');
const { getDemoOtp, getJwtSecret, isDemoOtpMode } = require('../config/env');
const { getOwnerDemoProvider } = require('../config/localOwnerDemo');

const memoryOtps = new Map();

function getMaxAttempts() {
  return Number(process.env.OTP_MAX_ATTEMPTS || 5);
}

function getExpiryMinutes() {
  return Number(process.env.OTP_EXPIRY_MINUTES || 5);
}

function generateOtp() {
  if (isDemoOtpMode()) return getDemoOtp();
  return String(crypto.randomInt(100000, 1000000));
}

function hashOtp(phoneOrOtp, maybeOtp) {
  const phone = maybeOtp === undefined ? '' : phoneOrOtp;
  const otp = maybeOtp === undefined ? phoneOrOtp : maybeOtp;
  return crypto
    .createHmac('sha256', getJwtSecret())
    .update(`${phone}:${otp}`)
    .digest('hex');
}

function compareOtp(phone, otp, otpHash) {
  const expected = Buffer.from(hashOtp(phone, otp));
  const actual = Buffer.from(String(otpHash || ''));
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

function verifyOtpHash(phone, otp, otpHash) {
  return compareOtp(phone, otp, otpHash);
}

function buildMemoryKey(targetType, target, contextId = '') {
  return `${targetType}:${target}:${String(contextId || '')}`;
}

function normalizeEmail(email = '') {
  const normalized = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return '';
  return normalized;
}

function requireValidEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    const error = new Error('Enter a valid email address');
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

function normalizeTarget(target, targetType) {
  return targetType === 'email' ? requireValidEmail(target) : requireValidPhone(target);
}

async function canResendOtp(phone) {
  const normalizedPhone = requireValidPhone(phone);
  return canResendTargetOtp(normalizedPhone, 'phone');
}

async function canResendTargetOtp(target, targetType = 'phone', { purpose, contextId } = {}) {
  const normalizedTarget = normalizeTarget(target, targetType);
  if (useMemoryOtpStore()) {
    const latest = memoryOtps.get(buildMemoryKey(targetType, normalizedTarget, contextId));
    const cooldownSeconds = Number(process.env.OTP_RESEND_COOLDOWN_SECONDS || 60);
    if (!latest || latest.isUsed) return { allowed: true, latest: null, retryAfter: 0 };
    const elapsedSeconds = Math.floor((Date.now() - latest.createdAt.getTime()) / 1000);
    return {
      allowed: elapsedSeconds >= cooldownSeconds,
      latest,
      retryAfter: Math.max(0, cooldownSeconds - elapsedSeconds),
    };
  }
  const latest = await Otp.findOne({ target: normalizedTarget, targetType, isUsed: false, ...(purpose ? { purpose } : {}), ...(contextId ? { contextId: String(contextId) } : {}) }).sort('-createdAt');
  const cooldownSeconds = Number(process.env.OTP_RESEND_COOLDOWN_SECONDS || 60);
  if (!latest) return { allowed: true, latest: null, retryAfter: 0 };
  const elapsedSeconds = Math.floor((Date.now() - latest.createdAt.getTime()) / 1000);
  return {
    allowed: elapsedSeconds >= cooldownSeconds,
    latest,
    retryAfter: Math.max(0, cooldownSeconds - elapsedSeconds),
  };
}

async function createOtp(phone, purpose = 'login', req) {
  return createTargetOtp(phone, { purpose, req, targetType: 'phone' });
}

async function createEmailOtp(email, purpose = 'profile_email_change', req) {
  return createTargetOtp(email, { purpose, req, targetType: 'email' });
}

async function createTargetOtp(target, { purpose = 'login', req, targetType = 'phone', contextId } = {}) {
  const demoProvider = purpose === 'master_demo_login' ? getOwnerDemoProvider(req) : '';
  if (purpose === 'master_demo_login' && !demoProvider) {
    const error = new Error('Owner demo login is not enabled for this request. Please request a new OTP.');
    error.statusCode = 403;
    throw error;
  }
  const normalizedTarget = normalizeTarget(target, targetType);
  const normalizedContext = String(contextId || '').trim();
  const resend = await canResendTargetOtp(normalizedTarget, targetType, { purpose, contextId: normalizedContext });
  if (!resend.allowed) {
    const error = new Error(`Please wait ${resend.retryAfter}s before requesting another OTP`);
    error.statusCode = 429;
    throw error;
  }

  const otp = purpose === 'master_login' ? String(crypto.randomInt(100000, 1000000)) : generateOtp();
  if (useMemoryOtpStore()) {
    const record = {
      phone: targetType === 'phone' ? normalizedTarget : undefined,
      email: targetType === 'email' ? normalizedTarget : undefined,
      target: normalizedTarget,
      targetType,
      otpHash: hashOtp(normalizedTarget, otp),
      purpose,
      contextId: normalizedContext || undefined,
      provider: process.env.SMS_PROVIDER || 'mock',
      expiresAt: new Date(Date.now() + getExpiryMinutes() * 60 * 1000),
      attempts: 0,
      maxAttempts: getMaxAttempts(),
      resendCount: resend.latest ? resend.latest.resendCount + 1 : 0,
      isUsed: false,
      ipAddress: req?.ip,
      userAgent: req?.headers?.['user-agent'],
      createdAt: new Date(),
      async save() {
        memoryOtps.set(buildMemoryKey(targetType, normalizedTarget, normalizedContext), this);
        return this;
      },
    };
    memoryOtps.set(buildMemoryKey(targetType, normalizedTarget, normalizedContext), record);
    return { record, otp, target: normalizedTarget, [targetType]: normalizedTarget };
  }

  await Otp.updateMany({ target: normalizedTarget, targetType, isUsed: false, ...(normalizedContext ? { contextId: normalizedContext, purpose } : {}) }, { isUsed: true });
  const record = await Otp.create({
    phone: targetType === 'phone' ? normalizedTarget : undefined,
    email: targetType === 'email' ? normalizedTarget : undefined,
    target: normalizedTarget,
    targetType,
    otpHash: hashOtp(normalizedTarget, otp),
    purpose,
    contextId: normalizedContext || undefined,
    provider: demoProvider || process.env.SMS_PROVIDER || 'mock',
    expiresAt: new Date(Date.now() + getExpiryMinutes() * 60 * 1000),
    maxAttempts: getMaxAttempts(),
    resendCount: resend.latest ? resend.latest.resendCount + 1 : 0,
    ipAddress: req?.ip,
    userAgent: req?.headers?.['user-agent'],
  });

  return { record, otp, target: normalizedTarget, [targetType]: normalizedTarget };
}

async function verifyOtp(phone, otp, req) {
  return verifyTargetOtp(phone, otp, { targetType: 'phone', req });
}

async function verifyEmailOtp(email, otp) {
  return verifyTargetOtp(email, otp, { targetType: 'email' });
}

async function verifyTargetOtp(target, otp, { targetType = 'phone', req, purpose, contextId } = {}) {
  const normalizedTarget = normalizeTarget(target, targetType);
  const code = String(otp || '');
  if (!/^\d{6}$/.test(code)) {
    const error = new Error(`Valid ${targetType === 'email' ? 'email' : 'mobile number'} and OTP are required`);
    error.statusCode = 400;
    throw error;
  }

  const normalizedContext = String(contextId || '').trim();
  const record = useMemoryOtpStore()
    ? getMemoryOtp(normalizedTarget, targetType, normalizedContext)
    : await Otp.findOne({ target: normalizedTarget, targetType, isUsed: false, ...(purpose ? { purpose } : {}), ...(normalizedContext ? { contextId: normalizedContext } : {}) }).sort('-createdAt');
  if (!record) {
    const error = new Error('OTP not found or expired');
    error.statusCode = 400;
    throw error;
  }
  const ownerDemo = record.purpose === 'master_demo_login';
  if (ownerDemo && (!getOwnerDemoProvider(req) || record.provider !== getOwnerDemoProvider(req))) {
    const error = new Error('Owner demo login is not enabled for this request. Please request a new OTP.');
    error.statusCode = 403;
    throw error;
  }
  if (record.expiresAt < new Date()) {
    record.isUsed = true;
    await record.save();
    const error = new Error('OTP expired');
    error.statusCode = 400;
    throw error;
  }
  if (record.attempts >= record.maxAttempts) {
    const error = new Error('Maximum OTP attempts exceeded');
    error.statusCode = 429;
    throw error;
  }
  const matches = compareOtp(normalizedTarget, code, record.otpHash);

  if (!matches) {
    if ((record.purpose === 'master_login' || ownerDemo || normalizedContext) && !useMemoryOtpStore()) {
      await Otp.updateOne({ _id: record._id, isUsed: false, attempts: { $lt: record.maxAttempts } }, { $inc: { attempts: 1 } });
    } else {
      record.attempts += 1;
      await record.save();
    }
    const error = new Error('Invalid OTP');
    error.statusCode = 400;
    throw error;
  }

  if ((record.purpose === 'master_login' || ownerDemo || normalizedContext) && !useMemoryOtpStore()) {
    // Atomically redeem scoped and owner OTPs once; parallel requests cannot reuse them.
    const redeemed = await Otp.findOneAndUpdate({
      _id: record._id, isUsed: false, purpose: record.purpose, otpHash: record.otpHash,
      ...((record.purpose === 'master_login' || ownerDemo) ? { trustedDelivery: !ownerDemo } : {}),
      ...(ownerDemo ? { provider: record.provider } : {}),
      ...(normalizedContext ? { contextId: normalizedContext } : {}),
      attempts: { $lt: record.maxAttempts }, expiresAt: { $gt: new Date() },
    }, { $set: { isUsed: true } }, { new: true });
    if (!redeemed) {
      const error = new Error('OTP is no longer available. Request a new OTP.');
      error.statusCode = 400;
      throw error;
    }
  } else {
    record.isUsed = true;
    await record.save();
  }
  return { target: normalizedTarget, targetType, [targetType]: normalizedTarget, record };
}

async function markOtpUsed(record) {
  record.isUsed = true;
  return record.save();
}

async function invalidateOtp(record) {
  if (!record) return null;
  record.isUsed = true;
  return record.save();
}

function useMemoryOtpStore() {
  return process.env.NODE_ENV !== 'production' && mongoose.connection.readyState !== 1;
}

function getMemoryOtp(target, targetType = 'phone', contextId = '') {
  const record = memoryOtps.get(buildMemoryKey(targetType, target, contextId));
  if (!record || record.isUsed) return null;
  return record;
}

module.exports = {
  normalizePhone,
  normalizeEmail,
  generateOtp,
  hashOtp,
  compareOtp,
  verifyOtpHash,
  createOtp,
  createEmailOtp,
  verifyOtp,
  verifyEmailOtp,
  createTargetOtp,
  verifyTargetOtp,
  markOtpUsed,
  invalidateOtp,
  canResendOtp,
  canResendTargetOtp,
  requireValidEmail,
  getExpiryMinutes,
};
