const { attachMasterSession } = require('../config/masterOwner');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');
const { getJwtSecret } = require('../config/env');
const { allowsOwnerDemoSession } = require('../config/localOwnerDemo');

async function protect(req, res, next) {
  if (req.user) return next();
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.split(' ')[1] : null;
  if (!token) return res.status(401).json({ success: false, code: 'UNAUTHORIZED', message: 'Not authorized' });

  try {
    const decoded = jwt.verify(token, getJwtSecret());
    if (decoded.tokenType && decoded.tokenType !== 'access') return res.status(401).json({ success: false, code: 'UNAUTHORIZED', message: 'Access token required' });
    if (!allowsOwnerDemoSession(decoded, req)) return res.status(401).json({ success: false, code: 'UNAUTHORIZED', message: 'This demo session is not enabled on this server. Please log in again.' });
    if (canUseOfflineSession(decoded)) {
      req.user = buildOfflineUser(decoded);
      return next();
    }
    req.user = await User.findById(decoded.id).select('-password +masterSessionVersion +authSessionVersion');
    if (!req.user || req.user.isBlocked) return res.status(401).json({ success: false, code: 'UNAUTHORIZED', message: 'Account unavailable' });
    if (Number(decoded.authSessionVersion || 0) !== Number(req.user.authSessionVersion || 0)) {
      return res.status(401).json({ success: false, code: 'UNAUTHORIZED', message: 'This session has ended. Please login again.' });
    }
    attachMasterSession(req.user, decoded);
    next();
  } catch (error) {
    if (['JsonWebTokenError', 'TokenExpiredError', 'NotBeforeError'].includes(error.name)) {
      return res.status(401).json({ success: false, code: 'UNAUTHORIZED', message: 'Token failed' });
    }
    return res.status(503).json({ success: false, code: 'SERVICE_UNAVAILABLE', message: 'Your account could not be loaded right now. Please retry shortly.' });
  }
}

function canUseOfflineSession(decoded) {
  return process.env.NODE_ENV !== 'production'
    && mongoose.connection.readyState !== 1
    && decoded?.offlineSession
    && String(decoded.userId || decoded.id || '').startsWith('offline-');
}

function buildOfflineUser(decoded) {
  const user = {
    _id: decoded.userId || decoded.id,
    id: decoded.userId || decoded.id,
    name: decoded.name || `Jassi User ${String(decoded.phone || '').slice(-4)}`,
    phone: decoded.phone,
    isPhoneVerified: true,
    role: decoded.role || 'customer',
    availableModes: decoded.role === 'admin' ? ['customer', 'admin'] : ['customer'],
    activeMode: decoded.activeMode || 'customer',
    isBlocked: false,
    offlineSession: true,
  };
  user.toObject = () => ({ ...user });
  return user;
}

/**
 * Attaches req.user when a valid token is present, but never fails the
 * request. Used by preview endpoints such as coupon apply so a logged-in
 * customer's first-order / per-customer limits can be checked without
 * blocking guests.
 */
async function optionalProtect(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.split(' ')[1] : null;
  if (!token) return next();

  try {
    const decoded = jwt.verify(token, getJwtSecret());
    if (decoded.tokenType && decoded.tokenType !== 'access') throw new Error('Access token required');
    if (!allowsOwnerDemoSession(decoded, req)) return next();
    if (canUseOfflineSession(decoded)) {
      req.user = buildOfflineUser(decoded);
      return next();
    }
    const user = await User.findById(decoded.id).select('-password +masterSessionVersion +authSessionVersion');
    if (user && !user.isBlocked && Number(decoded.authSessionVersion || 0) === Number(user.authSessionVersion || 0)) req.user = attachMasterSession(user, decoded);
  } catch {
    // Invalid tokens are ignored here; the caller is still anonymous.
  }
  return next();
}

module.exports = { optionalProtect, protect };
