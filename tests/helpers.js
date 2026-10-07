/**
 * Shared test harness.
 *
 * Serves the real Express app on an ephemeral port so the middleware chain,
 * routing and auth guards are covered, not just the controllers.
 *
 * Database selection, in order of preference:
 *  1. TEST_MONGO_URI, explicitly configured for automated tests.
 *  2. An in-memory MongoDB replica set, when the binary is available locally.
 *
 * The application .env and MONGO_URI are never used. Every connection targets
 * TEST_DB_NAME, and destructive cleanup verifies that name independently.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const mongoose = require('mongoose');

// Tests may deliberately override these after importing the harness. Never
// inherit production delivery/storage credentials from the caller's shell.
for (const key of Object.keys(process.env)) {
  if (/^(MONGO_URI|JWT|OTP|SMS|TWILIO|MSG91|TWOFACTOR|FAST2SMS|BREVO|RAZORPAY|R2_|CLOUDINARY|REDIS|GEMINI|AI_|SOCIAL_|META_|INSTAGRAM|FACEBOOK|SHIPROCKET|SHIPPING_|WHATSAPP|PUSH_|PAYMENTS_|ADMIN_PHONE|MASTER_OWNER)/i.test(key)) delete process.env[key];
}
Object.assign(process.env, {
  NODE_ENV: 'test',
  JWT_SECRET: 'test_jwt_secret',
  JWT_REFRESH_SECRET: 'test_jwt_refresh_secret',
  OTP_MODE: 'demo', DEMO_OTP: '123456', OTP_RESEND_COOLDOWN_SECONDS: '0',
  SMS_PROVIDER: 'mock', EMAIL_OTP_PROVIDER: 'mock',
  RAZORPAY_MOCK: '1', SHIPPING_PROVIDER: 'disabled',
});
const cachedMongoBinary = path.join(__dirname, '../node_modules/.cache/mongodb-binaries/mongod-x64-win32-7.0.14.exe');
if (!process.env.MONGOMS_SYSTEM_BINARY && process.platform === 'win32' && fs.existsSync(cachedMongoBinary)) {
  process.env.MONGOMS_SYSTEM_BINARY = cachedMongoBinary;
  process.env.MONGOMS_VERSION = '7.0.14';
}
process.env.MONGOMS_RUNTIME_DOWNLOAD = process.env.MONGOMS_RUNTIME_DOWNLOAD || 'false';

const TEST_DB_NAME = 'samira_collection_automated_tests';

let replSet;
let server;
let baseUrl;

/**
 * Rewrites the database portion of a connection string so tests can share a
 * cluster with the application without sharing its data.
 */
function toTestUri(uri) {
  const [beforeQuery, query] = String(uri).split('?');
  const withoutTrailingSlash = beforeQuery.replace(/\/+$/, '');
  const lastSlash = withoutTrailingSlash.lastIndexOf('/');
  const schemeEnd = withoutTrailingSlash.indexOf('//') + 2;
  const base = lastSlash > schemeEnd ? withoutTrailingSlash.slice(0, lastSlash) : withoutTrailingSlash;
  return `${base}/${TEST_DB_NAME}${query ? `?${query}` : ''}`;
}

async function tryInMemoryMongo() {
  try {
    const { MongoMemoryReplSet } = require('mongodb-memory-server');
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    return replSet.getUri(TEST_DB_NAME);
  } catch {
    if (replSet) await replSet.stop().catch(() => null);
    replSet = undefined;
    return null;
  }
}

async function resolveTestUri() {
  if (process.env.TEST_MONGO_URI) return toTestUri(process.env.TEST_MONGO_URI);

  const inMemory = await tryInMemoryMongo();
  if (inMemory) return inMemory;

  throw new Error('No isolated test database available. Install a local MongoDB test binary or explicitly set TEST_MONGO_URI. Application MONGO_URI is never used.');
}

async function startTestEnvironment() {
  const uri = await resolveTestUri();
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });

  const connectedDb = mongoose.connection.name;
  if (connectedDb !== TEST_DB_NAME) {
    await mongoose.disconnect();
    throw new Error(`Refusing to run tests against database "${connectedDb}". Expected "${TEST_DB_NAME}".`);
  }

  process.env.MONGO_URI = uri;

  const app = require('../app');
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { baseUrl };
}

async function stopTestEnvironment() {
  if (server) await new Promise((resolve) => server.close(resolve));
  await resetDatabase().catch(() => null);
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
}

async function resetDatabase() {
  if (mongoose.connection.readyState !== 1) return;
  if (mongoose.connection.name !== TEST_DB_NAME) {
    throw new Error('Refusing test cleanup outside the dedicated automated-test database.');
  }
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((collection) => collection.deleteMany({})));
}

async function request(path, { method = 'GET', body, token, headers = {} } = {}) {
  const checkoutPath = method === 'POST' && (path === '/api/orders' || path === '/api/orders/cod' || path === '/api/payments/create-order');
  const requestBody = checkoutPath && body && !body.checkoutAttemptId
    ? { ...body, checkoutAttemptId: `test_${crypto.randomUUID()}` }
    : body;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: requestBody === undefined ? undefined : JSON.stringify(requestBody),
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status, data, headers: response.headers };
}

module.exports = {
  TEST_DB_NAME,
  request,
  resetDatabase,
  startTestEnvironment,
  stopTestEnvironment,
  toTestUri,
  getBaseUrl: () => baseUrl,
};
