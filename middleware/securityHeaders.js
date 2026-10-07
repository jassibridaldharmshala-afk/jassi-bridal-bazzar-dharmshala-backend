const PRIVATE_API_PREFIXES = [
  '/api/auth', '/api/admin', '/api/seller', '/api/cart', '/api/user', '/api/wishlist',
  '/api/orders', '/api/payments', '/api/create-order', '/api/verify-payment', '/api/returns',
  '/api/notifications', '/api/social', '/api/master',
];

function isHttps(req) {
  return req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Content-Security-Policy', "default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), usb=()');
  if (process.env.NODE_ENV === 'production' && isHttps(req)) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  const privateRequest = Boolean(req.headers.authorization)
    || PRIVATE_API_PREFIXES.some((prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`));
  if (privateRequest) {
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
}

module.exports = { securityHeaders };
