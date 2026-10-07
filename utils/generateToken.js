const jwt = require('jsonwebtoken');
const { getJwtRefreshSecret, getJwtSecret } = require('../config/env');

function tokenPayload(user) {
  const id = user._id || user.id || user;
  return {
    id,
    userId: id,
    phone: user.phone,
    name: user.name,
    role: user.role,
    activeMode: user.activeMode,
    authSessionVersion: Number(user.authSessionVersion || 0),
    offlineSession: !!user.offlineSession,
    ...(user.$locals?.masterAuthenticated && user.masterSessionVersion ? { masterSessionVersion: user.masterSessionVersion } : {}),
    ...(user.$locals?.localOwnerDemo ? { localOwnerDemo: true } : {}),
    ...(user.$locals?.hostedOwnerDemo ? { hostedOwnerDemo: true } : {}),
  };
}

function generateToken(user) {
  // Use the server-owned account role, not the selected UI mode. An admin
  // visiting the storefront must keep the same full working-day session.
  const expiresIn = user.role === 'admin'
    ? (String(process.env.JWT_ADMIN_EXPIRES_IN || '').trim() || '24h')
    : (process.env.JWT_EXPIRES_IN || '15m');
  return jwt.sign(tokenPayload(user), getJwtSecret(), {
    expiresIn,
  });
}

function generateRefreshToken(user) {
  return jwt.sign(
    { ...tokenPayload(user), tokenType: 'refresh' },
    getJwtRefreshSecret(),
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d' },
  );
}

module.exports = { generateRefreshToken, generateToken };
