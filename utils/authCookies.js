const COOKIE_NAME = 'samira_refresh_token';

function booleanEnv(name, fallback = false) {
  const value = String(process.env[name] || '').trim().toLowerCase();
  if (!value) return fallback;
  return value === 'true' || value === '1';
}

function cookieMaxAge() {
  const value = String(process.env.JWT_REFRESH_EXPIRES_IN || '30d').trim().toLowerCase();
  const match = value.match(/^(\d+)(ms|s|m|h|d)$/);
  if (!match) return 30 * 24 * 60 * 60 * 1000;
  const units = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return Number(match[1]) * units[match[2]];
}

function isLoopbackRequest(req) {
  const host = String(req?.headers?.host || '').split(':')[0].toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

function cookieOptions(req) {
  const production = process.env.NODE_ENV === 'production';
  const loopback = isLoopbackRequest(req);
  const configuredSameSite = String(process.env.AUTH_COOKIE_SAME_SITE || '').trim().toLowerCase();
  const sameSite = ['lax', 'strict', 'none'].includes(configuredSameSite)
    ? configuredSameSite
    : (production && !loopback ? 'none' : 'lax');
  const options = {
    httpOnly: true,
    secure: booleanEnv('AUTH_COOKIE_SECURE', (production && !loopback) || sameSite === 'none'),
    sameSite,
    path: '/api/auth',
    maxAge: cookieMaxAge(),
  };
  const domain = String(process.env.AUTH_COOKIE_DOMAIN || '').trim();
  if (domain) options.domain = domain;
  return options;
}

function readCookie(req, name = COOKIE_NAME) {
  const header = String(req?.headers?.cookie || '');
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(separator + 1).trim()); } catch { return ''; }
  }
  return '';
}

function allowRefreshTokenBody() {
  return process.env.NODE_ENV === 'test' || booleanEnv('ALLOW_REFRESH_TOKEN_BODY', false);
}

function returnRefreshTokenInBody() {
  return process.env.NODE_ENV === 'test' || booleanEnv('RETURN_REFRESH_TOKEN_IN_BODY', false);
}

function refreshTokenFromRequest(req) {
  return readCookie(req) || (allowRefreshTokenBody() ? String(req?.body?.refreshToken || '') : '');
}

function setRefreshCookie(res, token, req) {
  if (typeof res?.cookie === 'function') res.cookie(COOKIE_NAME, token, cookieOptions(req));
}

function clearRefreshCookie(res, req) {
  if (typeof res?.clearCookie !== 'function') return;
  const { maxAge: _maxAge, ...options } = cookieOptions(req);
  res.clearCookie(COOKIE_NAME, options);
}

module.exports = {
  COOKIE_NAME,
  allowRefreshTokenBody,
  clearRefreshCookie,
  cookieOptions,
  refreshTokenFromRequest,
  returnRefreshTokenInBody,
  setRefreshCookie,
};
