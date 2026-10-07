const defaultOrigins = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3001',
  'http://localhost:3002',
  'http://127.0.0.1:3002',
  'http://localhost:3003',
  'http://127.0.0.1:3003',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'https://jassi-general-store.onrender.com',
];

function parseOrigins(value) {
  return String(value || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function getAllowedOrigins() {
  return [...new Set([...defaultOrigins, ...parseOrigins(process.env.CLIENT_ORIGINS), process.env.FRONTEND_URL].filter(Boolean))];
}

function isLocalhostOrigin(origin) {
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:') return false;
    const { hostname } = url;
    if (['localhost', '127.0.0.1'].includes(hostname)) return true;
    if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
    if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
    return false;
  } catch (error) {
    return false;
  }
}

function isRunningOnRender() {
  return Boolean(process.env.RENDER);
}

function corsOptions(req, callback) {
  const origin = req.header('Origin');
  const allowedOrigins = getAllowedOrigins();
  const allowLocalhost = !isRunningOnRender() && isLocalhostOrigin(origin);

  if (
    !origin
    || allowedOrigins.includes(origin)
    || allowLocalhost
  ) {
    return callback(null, {
      origin: true,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'x-session-id', 'x-store-slug', 'x-store-id', 'x-request-id', 'Idempotency-Key'],
      maxAge: 86400,
    });
  }

  return callback(null, { origin: false });
}

module.exports = { corsOptions, getAllowedOrigins };
