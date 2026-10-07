const crypto = require('crypto');
const { isOwnerPhone, isOwnerAccount, attachMasterSession } = require('../config/masterOwner');
const User = require('../models/User');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { generateRefreshToken, generateToken } = require('../utils/generateToken');
const { normalizePhone, normalizeEmail, createOtp, createEmailOtp, verifyOtp: verifyOtpRecord, verifyEmailOtp: verifyEmailOtpRecord } = require('../services/otpService');
const { sendOtp, isRealSmsProvider } = require('../services/smsService');
const { sendOtpEmail } = require('../services/emailService');
const { getDemoOtp, getJwtRefreshSecret, getJwtSecret, getOtpMode, isDemoOtpMode } = require('../config/env');
const { ApiError } = require('../utils/apiError');
const { listMemberships } = require('../services/storeService');
const { normalizeIndianMobile } = require('../utils/phoneUtils');
const { getOwnerDemoProvider, allowsOwnerDemoSession } = require('../config/localOwnerDemo');
const { clearRefreshCookie, refreshTokenFromRequest, returnRefreshTokenInBody, setRefreshCookie } = require('../utils/authCookies');

const otpRateLimit = new Map();
const offlineProfiles = new Map();
const PROFILE_VERIFICATION_TOKEN_TTL = process.env.PROFILE_VERIFICATION_TOKEN_TTL || '15m';

// Kept as a compatibility endpoint for older clients. Password-based admin
// access is intentionally disabled; every account, including admins, must be
// verified through the shared mobile OTP flow.
exports.adminLogin = (_req, res) => res.status(410).json({
  success: false,
  code: 'OTP_REQUIRED',
  message: 'Admin access uses mobile number and OTP only.',
});

exports.profile = async (req, res) => res.json(sanitize(req.user));

exports.updateProfile = async (req, res) => {
  try {
    const { role, availableModes, activeMode, isBlocked, ...safeBody } = req.body || {};
    const nextName = normalizeTrimmed(safeBody.name);
    const nextEmail = normalizeProfileEmail(safeBody.email);
    const nextPhone = normalizeProfilePhone(safeBody.phone);
    const nextAlternatePhone = normalizeProfilePhone(safeBody.alternatePhone, { allowEmpty: true });
    const nextHintName = normalizeTrimmed(safeBody.hintName);
    const nextGender = normalizeGender(safeBody.gender);
    const nextBirthDate = normalizeBirthDate(safeBody.birthDate);

    if (nextEmail && req.user.offlineSession !== true) {
      const existingEmailUser = await User.findOne({ email: nextEmail, _id: { $ne: req.user._id } }).select('_id');
      if (existingEmailUser) return res.status(400).json({ message: 'Email is already in use' });
    }

    if (nextPhone && req.user.offlineSession !== true) {
      const existingPhoneUser = await User.findOne({ phone: nextPhone, _id: { $ne: req.user._id } }).select('_id');
      if (existingPhoneUser) return res.status(400).json({ message: 'Mobile number is already in use' });
    }

    const previousPhone = String(req.user.phone || '');
    const previousEmail = String(req.user.email || '').toLowerCase();
    const phoneChanged = nextPhone && nextPhone !== previousPhone;
    if (phoneChanged && (isOwnerPhone(nextPhone) || isOwnerPhone(previousPhone))) return res.status(403).json({ message: 'The owner identity cannot be reassigned from profile settings.' });
    const emailChanged = nextEmail !== previousEmail;
    const verifiedPhone = phoneChanged ? verifyProfileChangeToken(req.body.phoneVerificationToken, {
      userId: req.user._id || req.user.id,
      targetType: 'phone',
      target: nextPhone,
    }) : false;
    const verifiedEmail = nextEmail ? (
      emailChanged
        ? verifyProfileChangeToken(req.body.emailVerificationToken, {
          userId: req.user._id || req.user.id,
          targetType: 'email',
          target: nextEmail,
        })
        : Boolean(req.user.isEmailVerified)
    ) : false;

    if (phoneChanged && !verifiedPhone) {
      return res.status(400).json({ message: 'Please verify your new mobile number with OTP before saving' });
    }

    if (nextEmail && emailChanged && !verifiedEmail) {
      return res.status(400).json({ message: 'Please verify your email with OTP before saving' });
    }

    const nextProfile = {
      name: nextName || req.user.name || '',
      email: nextEmail || undefined,
      phone: nextPhone || previousPhone,
      gender: nextGender,
      birthDate: nextBirthDate,
      alternatePhone: nextAlternatePhone,
      hintName: nextHintName,
      isEmailVerified: nextEmail ? verifiedEmail : false,
    };

    if (req.user.offlineSession) {
      if (phoneChanged) removeOfflineProfile({ phone: previousPhone });
      Object.assign(req.user, nextProfile);
      if (phoneChanged) req.user.isPhoneVerified = true;
      storeOfflineProfile(req.user);
      return res.json(sanitize(req.user));
    }

    Object.assign(req.user, nextProfile);
    if (phoneChanged) req.user.isPhoneVerified = true;
    await req.user.save();
    res.json(sanitize(req.user));
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

exports.sendProfilePhoneChangeOtp = async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    if (!phone) return res.status(400).json({ message: 'Valid 10-digit Indian mobile number is required' });
    if (isOwnerPhone(phone) || isOwnerAccount(req.user)) return res.status(403).json({ message: 'The owner identity cannot be reassigned from profile settings.' });
    if (phone === String(req.user.phone || '')) return res.status(400).json({ message: 'This mobile number is already on your account' });

    const existingUser = req.user.offlineSession
      ? null
      : await User.findOne({ phone, _id: { $ne: req.user._id } }).select('_id');
    if (existingUser) return res.status(400).json({ message: 'Mobile number is already in use' });

    const { otp, record } = await createOtp(phone, 'profile_phone_change', req);
    const delivery = await deliverOtpWithFallback(phone, otp, record);
    return res.json({ success: true, message: 'OTP sent successfully', ...otpResponse(delivery) });
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, code: error.errorCode, message: error.message });
  }
};

exports.verifyProfilePhoneChangeOtp = async (req, res) => {
  try {
    const { phone } = await verifyOtpRecord(req.body.phone, req.body.otp);
    const verificationToken = createProfileChangeToken({
      userId: req.user._id || req.user.id,
      targetType: 'phone',
      target: phone,
    });
    res.json({ success: true, verified: true, verificationToken });
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
};

exports.sendProfileEmailChangeOtp = async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    if (!email) return res.status(400).json({ message: 'Please enter a valid email address' });
    if (email === String(req.user.email || '').toLowerCase()) return res.status(400).json({ message: 'This email is already on your account' });

    const existingUser = req.user.offlineSession
      ? null
      : await User.findOne({ email, _id: { $ne: req.user._id } }).select('_id');
    if (existingUser) return res.status(400).json({ message: 'Email is already in use' });

    const { otp } = await createEmailOtp(email, 'profile_email_change', req);
    const delivery = await sendOtpEmail(email, otp);
    const exposeDemoOtp = isDemoOtpMode() && delivery?.devOtp;
    return res.json({
      success: true,
      message: 'OTP sent successfully',
      otpMode: getOtpMode(),
      ...(exposeDemoOtp ? { demoOtp: delivery.devOtp, devOtp: delivery.devOtp } : {}),
    });
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, code: error.errorCode, message: error.message });
  }
};

exports.verifyProfileEmailChangeOtp = async (req, res) => {
  try {
    const { email } = await verifyEmailOtpRecord(req.body.email, req.body.otp);
    const verificationToken = createProfileChangeToken({
      userId: req.user._id || req.user.id,
      targetType: 'email',
      target: email,
    });
    res.json({ success: true, verified: true, verificationToken });
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
};

exports.deleteProfile = async (req, res) => {
  try {
    if (isOwnerAccount(req.user)) return res.status(403).json({ message: 'The deployment owner account cannot be deleted here.' });
    if (req.user.offlineSession) {
      removeOfflineProfile(req.user);
      return res.json({ success: true, message: 'Account deleted successfully' });
    }

    await User.findByIdAndDelete(req.user._id);
    res.json({ success: true, message: 'Account deleted successfully' });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

exports.sendOtp = async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    if (!phone) return res.status(400).json({ message: 'Valid 10-digit Indian mobile number is required' });
    if (!allowOtpRequest(phone, req.ip)) {
      return res.status(429).json({ message: 'Too many OTP requests. Please try again shortly.' });
    }

    if (isOwnerPhone(phone) && (mongoose.connection.readyState !== 1 || !process.env.JWT_SECRET || !process.env.JWT_REFRESH_SECRET)) {
      return res.status(503).json({ message: 'Owner login requires a connected database and configured session secrets.' });
    }
    const purpose = isOwnerPhone(phone)
      ? (getOwnerDemoProvider(req) ? 'master_demo_login' : 'master_login') : 'login';
    const { otp, record } = await createOtp(phone, purpose, req);
    const delivery = await deliverOtpWithFallback(phone, otp, record, req);
    res.json({ success: true, message: 'OTP sent successfully', ...otpResponse(delivery) });
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, code: error.errorCode, message: error.message });
  }
};

exports.resendOtp = exports.sendOtp;

exports.verifyOtp = async (req, res) => {
  try {
    const { phone, record } = await verifyOtpRecord(req.body.phone, req.body.otp, req);
    const demoOwner = record.purpose === 'master_demo_login' && record.provider === getOwnerDemoProvider(req);
    const ownerDemoProvider = demoOwner ? record.provider : '';
    if (isOwnerPhone(phone) && (mongoose.connection.readyState !== 1 || (!demoOwner && (record.purpose !== 'master_login' || !record.trustedDelivery)))) {
      return res.status(403).json({ message: 'Please request and verify a new owner OTP delivered by SMS.' });
    }
    const user = mongoose.connection.readyState === 1
      ? await upsertPhoneLoginUser(phone, { activeMode: 'customer', masterVerified: isOwnerPhone(phone), ownerDemoProvider })
      : buildOfflineLoginUser(phone, { activeMode: 'customer' });
    res.json({ success: true, ...issueAuthSession(req, res, user) });
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
};

exports.me = async (req, res) => {
  const data = sanitize(req.user);
  if (!req.user.offlineSession) {
    const memberships = await listMemberships(req.user._id);
    data.stores = memberships.map((item) => ({
      id: String(item.store?._id || ''),
      name: item.store?.name,
      slug: item.store?.slug,
      role: item.role,
      permissions: item.role === 'OWNER' ? ['*'] : (require('../models/StoreMember').PERMISSIONS_BY_ROLE[item.role] || []),
      status: item.store?.status,
      platform: require('../config/storePlans').planSummary(item.store),
    }));
  }
  res.json(data);
};

exports.logout = async (req, res) => {
  clearRefreshCookie(res, req);
  if (!req.user.offlineSession && req.user._id) {
    await User.updateOne({ _id: req.user._id }, { $inc: { authSessionVersion: 1 } });
  }
  res.json({ success: true, message: 'Logged out successfully' });
};

exports.refresh = async (req, res) => {
  const token = refreshTokenFromRequest(req)
    || (typeof res?.cookie !== 'function' ? String(req.body?.refreshToken || '') : '');
  if (!token) return res.status(401).json({ message: 'Refresh token required' });

  try {
    const decoded = jwt.verify(token, getJwtRefreshSecret());
    if (decoded.tokenType !== 'refresh') return res.status(401).json({ message: 'Invalid refresh token' });
    if (!allowsOwnerDemoSession(decoded, req)) return res.status(401).json({ message: 'This demo session is not enabled on this server. Please log in again.' });

    let user;
    if (canRefreshOfflineSession(decoded)) {
      user = buildOfflineLoginUser(decoded.phone, { activeMode: decoded.activeMode || 'customer' });
    } else {
      user = await User.findById(decoded.id).select('-password +masterSessionVersion +authSessionVersion');
      if (!user || user.isBlocked) return res.status(401).json({ message: 'Account unavailable' });
      if (Number(decoded.authSessionVersion || 0) !== Number(user.authSessionVersion || 0)) {
        clearRefreshCookie(res, req);
        return res.status(401).json({ message: 'This session has ended. Please login again.' });
      }
      attachMasterSession(user, decoded);
    }

    res.json({ success: true, ...issueAuthSession(req, res, user) });
  } catch (error) {
    if (['JsonWebTokenError', 'TokenExpiredError', 'NotBeforeError'].includes(error.name)) {
      return res.status(401).json({ message: 'Refresh token expired. Please login again.' });
    }
    return res.status(503).json({ code: 'SERVICE_UNAVAILABLE', message: 'Unable to restore your session right now. Please retry shortly.' });
  }
};

exports.switchMode = async (req, res) => {
  let mode = String(req.body.mode || req.body.activeMode || req.query.mode || '').trim();
  if (!['customer', 'admin', 'seller'].includes(mode)) {
    if (req.user.role === 'admin' && req.user.availableModes?.includes('admin') && req.user.activeMode !== 'admin') {
      mode = 'admin';
    } else if (req.user.availableModes?.includes('seller') && req.user.activeMode !== 'seller') {
      mode = 'seller';
    } else if (req.user.role === 'admin' && req.user.availableModes?.includes('customer') && req.user.activeMode === 'admin') {
      mode = 'customer';
    }
  }
  if (!['customer', 'admin', 'seller'].includes(mode)) return res.status(400).json({ message: 'Invalid mode' });
  if (mode === 'admin' && (req.user.role !== 'admin' || !req.user.availableModes?.includes('admin'))) {
    return res.status(403).json({ message: 'Admin mode is not allowed' });
  }
  if (mode === 'seller' && !req.user.availableModes?.includes('seller')) {
    return res.status(403).json({ message: 'Seller mode is not allowed' });
  }
  if (req.user.offlineSession) {
    req.user.activeMode = mode;
    return res.json({ success: true, ...issueAuthSession(req, res, req.user) });
  }
  req.user.activeMode = mode;
  await req.user.save();
  res.json({ success: true, ...issueAuthSession(req, res, req.user) });
};

function sanitize(user) {
  const data = typeof user.toObject === 'function' ? user.toObject() : { ...user };
  delete data.password;
  delete data.masterSessionVersion;
  delete data.authSessionVersion;
  data.systemRole = user.$locals?.masterAuthenticated && isOwnerAccount(user) && !user.offlineSession ? 'MASTER_OWNER' : 'USER';
  data.id = String(data._id || data.id);
  return data;
}

function issueAuthSession(req, res, user) {
  const refreshToken = generateRefreshToken(user);
  setRefreshCookie(res, refreshToken, req);
  return {
    user: sanitize(user),
    token: generateToken(user),
    ...(returnRefreshTokenInBody() || typeof res?.cookie !== 'function' ? { refreshToken } : {}),
  };
}

function getAdminPhones() {
  return String(process.env.ADMIN_PHONE_NUMBERS || '').split(',').map((item) => normalizePhone(item)).filter(Boolean);
}

async function upsertPhoneLoginUser(phone, { activeMode = 'customer', masterVerified = false, ownerDemoProvider = '' } = {}) {
  const isAdminPhone = getAdminPhones().includes(phone) || masterVerified;
  const ownerVersion = masterVerified ? `${ownerDemoProvider ? `${ownerDemoProvider}:` : ''}${crypto.randomUUID()}` : undefined;
  const ownerClaims = {
    masterSessionVersion: ownerVersion,
    localOwnerDemo: ownerDemoProvider === 'local-demo',
    hostedOwnerDemo: ownerDemoProvider === 'hosted-demo',
  };
  let user = await User.findOne({ phone });
  if (!user) {
    user = await User.create({
      name: `Jassi User ${phone.slice(-4)}`,
      phone,
      email: `phone+${phone}@samira.local`,
      isPhoneVerified: true,
      role: isAdminPhone ? 'admin' : 'customer',
      availableModes: isAdminPhone ? ['customer', 'admin'] : ['customer'],
      activeMode,
      ...(masterVerified ? { systemRole: 'MASTER_OWNER', masterSessionVersion: ownerVersion } : {}),
    });
    if (masterVerified) attachMasterSession(user, ownerClaims);
    return user;
  }

  if (user.isBlocked) {
    const error = new Error('Account is blocked');
    error.statusCode = 403;
    throw error;
  }

  user.isPhoneVerified = true;
  if (isAdminPhone || user.role === 'admin') {
    user.role = 'admin';
    user.availableModes = ['customer', 'admin'];
  } else {
    user.role = 'customer';
    const modes = new Set(['customer']);
    if (user.availableModes?.includes('seller')) modes.add('seller');
    user.availableModes = [...modes];
  }
  user.activeMode = activeMode;
  if (masterVerified) { user.systemRole = 'MASTER_OWNER'; user.masterSessionVersion = ownerVersion; }
  await user.save();
  if (masterVerified) attachMasterSession(user, ownerClaims);
  return user;
}

function buildOfflineLoginUser(phone, { activeMode = 'customer' } = {}) {
  if (process.env.NODE_ENV === 'production') {
    const error = new Error('Database is unavailable');
    error.statusCode = 503;
    throw error;
  }
  const isAdminPhone = getAdminPhones().includes(phone);
  const savedProfile = offlineProfiles.get(phone) || {};
  const user = {
    _id: `offline-${phone}`,
    id: `offline-${phone}`,
    name: savedProfile.name || `Jassi User ${phone.slice(-4)}`,
    email: savedProfile.email,
    phone,
    gender: savedProfile.gender || '',
    birthDate: savedProfile.birthDate,
    alternatePhone: savedProfile.alternatePhone || '',
    hintName: savedProfile.hintName || '',
    isPhoneVerified: savedProfile.isPhoneVerified ?? true,
    isEmailVerified: savedProfile.isEmailVerified ?? false,
    role: isAdminPhone ? 'admin' : 'customer',
    availableModes: isAdminPhone ? ['customer', 'admin'] : ['customer'],
    activeMode,
    isBlocked: false,
    offlineSession: true,
  };
  user.toObject = () => ({ ...user });
  return user;
}

function canRefreshOfflineSession(decoded) {
  return process.env.NODE_ENV !== 'production'
    && mongoose.connection.readyState !== 1
    && decoded?.offlineSession
    && String(decoded.userId || decoded.id || '').startsWith('offline-');
}

/**
 * Demo mode: if the SMS provider is unavailable the fixed demo code stays
 * usable and is returned to the client so the product can be demonstrated.
 * Production mode: a delivery failure is a real failure — the code is never
 * downgraded to a guessable value and never leaves the server.
 */
async function deliverOtpWithFallback(phone, otp, record, req) {
  const owner = isOwnerPhone(phone);
  if (owner && record?.purpose === 'master_demo_login' && record.provider === getOwnerDemoProvider(req)) {
    return { success: true, provider: record.provider, demoOtp: getDemoOtp() };
  }

  // Customer demo accounts always use the displayed fixed code. Do not call
  // Twilio (or another paid provider) for non-owner numbers in demo mode.
  if (!owner && isDemoOtpMode()) {
    if (record) {
      record.provider = 'demo';
      await record.save();
    }
    return { success: true, provider: 'demo', demoOtp: getDemoOtp() };
  }

  const delivery = await sendOtp(phone, otp, { requireReal: owner });
  if (owner) {
    if (!delivery?.success || !isRealSmsProvider(delivery.provider)) {
      if (record) { record.isUsed = true; await record.save(); }
      throw otpDeliveryError(delivery);
    }
    record.trustedDelivery = true; record.provider = delivery.provider; await record.save();
    return { success: true, owner: true, provider: delivery.provider };
  }

  if (delivery?.success) {
    if (record) { record.provider = delivery.provider; await record.save(); }
    return { success: true, provider: delivery.provider };
  }
  if (record) { record.isUsed = true; await record.save(); }
  throw otpDeliveryError(delivery);
}

function otpDeliveryError(delivery) {
  const messages = {
    OTP_PROVIDER_AUTH_FAILED: 'SMS login is unavailable because the SMS provider rejected the store credentials. Please contact support.',
    OTP_PROVIDER_NOT_CONFIGURED: 'SMS login has not been configured for this account. Please contact support.',
    OTP_DELIVERY_UNAVAILABLE: 'We could not send your OTP. Please try again shortly or contact support if this continues.',
  };
  const code = Object.hasOwn(messages, delivery?.code) ? delivery.code : 'OTP_DELIVERY_UNAVAILABLE';
  return new ApiError(code, messages[code], { statusCode: 503 });
}

function otpResponse(delivery) {
  if (delivery?.owner) return { otpMode: 'production' };
  if (!isDemoOtpMode() || !delivery?.demoOtp) return { otpMode: getOtpMode() };
  return { otpMode: 'demo', demoOtp: delivery.demoOtp, devOtp: delivery.demoOtp };
}

function allowOtpRequest(phone, ip) {
  const key = `${phone}:${ip || 'unknown'}`;
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const limit = 8;
  const hits = (otpRateLimit.get(key) || []).filter((time) => now - time < windowMs);
  hits.push(now);
  otpRateLimit.set(key, hits);
  return hits.length <= limit;
}

function storeOfflineProfile(user) {
  const phone = String(user.phone || '');
  if (!phone) return;
  offlineProfiles.set(phone, {
    name: user.name || '',
    email: user.email || '',
    isEmailVerified: Boolean(user.isEmailVerified),
    gender: user.gender || '',
    birthDate: user.birthDate || undefined,
    alternatePhone: user.alternatePhone || '',
    hintName: user.hintName || '',
    isPhoneVerified: Boolean(user.isPhoneVerified),
  });
}

function removeOfflineProfile(user) {
  const phone = String(user.phone || '');
  if (!phone) return;
  offlineProfiles.delete(phone);
}

function normalizeTrimmed(value) {
  return String(value || '').trim();
}

function normalizeProfileEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!email) return '';
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!validEmail.test(email)) throw new Error('Please enter a valid email address');
  return email;
}

function normalizeProfilePhone(value, { allowEmpty = false } = {}) {
  const raw = String(value || '').replace(/\D/g, '');
  if (!raw) {
    if (allowEmpty) return '';
    return '';
  }

  const local = normalizeIndianMobile(raw);
  if (!/^[6-9]\d{9}$/.test(local)) throw new Error('Please enter a valid 10-digit mobile number');
  return local;
}

function normalizeGender(value) {
  const gender = String(value || '').trim().toLowerCase();
  if (!gender) return '';
  if (!['male', 'female', 'other'].includes(gender)) throw new Error('Please select a valid gender');
  return gender;
}

function normalizeBirthDate(value) {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Please enter a valid birth date');
  return date;
}

function createProfileChangeToken({ userId, targetType, target }) {
  return jwt.sign(
    {
      tokenType: 'profile_verification',
      userId: String(userId),
      targetType,
      target,
    },
    getJwtSecret(),
    { expiresIn: PROFILE_VERIFICATION_TOKEN_TTL },
  );
}

function verifyProfileChangeToken(token, { userId, targetType, target }) {
  if (!token) return false;
  try {
    const decoded = jwt.verify(token, getJwtSecret());
    return decoded?.tokenType === 'profile_verification'
      && String(decoded.userId) === String(userId)
      && decoded.targetType === targetType
      && String(decoded.target) === String(target);
  } catch {
    return false;
  }
}
