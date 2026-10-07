const RuntimeLicense = require('../models/RuntimeLicense');
const { ApiError } = require('../utils/apiError');
const { verifyEnvelope } = require('./licenseSignatureService');

// The project generator changes this constant only inside managed client packages.
// A managed build must fail closed if deployment credentials are removed.
const MANAGED_CLIENT_BUILD = true;

let memoryEnvelope;
let refreshPromise;

async function runtimeTelemetry() {
  try {
    const mongoose = require('mongoose');
    const Product = require('../models/Product');
    const pingStartedAt = Date.now();
    if (mongoose.connection.readyState === 1) await mongoose.connection.db.admin().ping();
    const [products, ordersPerMonth] = await Promise.all([
      Product.countDocuments({ isArchived: { $ne: true } }),
      require('./commerceUsageService').monthlyUsage({ allStores: true }),
    ]);
    return {
      products, ...ordersPerMonth, databaseStatus: mongoose.connection.readyState === 1 ? 'CONNECTED' : 'DISCONNECTED', serviceStatus: 'HEALTHY',
      databaseLatencyMs: Date.now() - pingStartedAt, uptimeSeconds: Math.floor(process.uptime()),
      memoryRssMb: Math.round(process.memoryUsage().rss / 1048576), nodeVersion: process.version,
      paymentReady: Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET),
      mediaStorageReady: Boolean((process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY) || (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET)),
      shippingProvider: String(process.env.SHIPPING_PROVIDER || 'disabled').slice(0, 60),
    };
  } catch (error) {
    return { databaseStatus: 'DISCONNECTED', serviceStatus: 'DEGRADED', lastError: String(error.message || 'Telemetry unavailable').slice(0, 300) };
  }
}

function configuration() {
  const controlPlaneUrl = String(process.env.CONTROL_PLANE_URL || '').trim().replace(/\/+$/, '');
  const installationId = String(process.env.CLIENT_INSTALLATION_ID || '').trim();
  const licenseKey = String(process.env.CLIENT_LICENSE_KEY || '').trim();
  const signingPublicKey = String(process.env.LICENSE_SIGNING_PUBLIC_KEY || '').trim();
  return {
    managed: MANAGED_CLIENT_BUILD || Boolean(controlPlaneUrl && installationId), controlPlaneUrl, installationId, licenseKey, signingPublicKey,
    appVersion: String(process.env.APP_VERSION || '1.0.0').trim(),
  };
}

function parseAndVerify(envelope, config) {
  const payload = verifyEnvelope(envelope, config.signingPublicKey);
  if (!payload || payload.installationId !== config.installationId) throw new ApiError('UNAUTHORIZED', 'The platform licence response could not be verified');
  return payload;
}

async function saveEnvelope(envelope, config) {
  memoryEnvelope = envelope;
  await RuntimeLicense.findOneAndUpdate(
    { key: 'active' },
    { $set: { installationId: config.installationId, payload: envelope.payload, signature: envelope.signature, algorithm: envelope.algorithm, checkedAt: new Date() }, $setOnInsert: { key: 'active' } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).catch(() => null);
}

async function cachedEnvelope() {
  if (memoryEnvelope) return memoryEnvelope;
  const cached = await RuntimeLicense.findOne({ key: 'active' }).lean().catch(() => null);
  if (!cached) return null;
  memoryEnvelope = { payload: cached.payload, signature: cached.signature, algorithm: cached.algorithm };
  return memoryEnvelope;
}

function applyLocalExpiry(status) {
  if (['ACTIVE', 'TRIAL'].includes(status.status) && status.endsAt && new Date(status.endsAt).getTime() <= Date.now()) return { ...status, status: 'EXPIRED' };
  return status;
}

async function remote(path, body = {}) {
  const config = configuration();
  if (!config.managed) throw new ApiError('SERVICE_UNAVAILABLE', 'This project is not connected to a control plane');
  if (!config.controlPlaneUrl || !config.installationId || !config.licenseKey || !config.signingPublicKey) throw new ApiError('SERVICE_UNAVAILABLE', 'Managed licence credentials are incomplete');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(process.env.CONTROL_PLANE_TIMEOUT_MS || 5000)));
  try {
    const response = await fetch(`${config.controlPlaneUrl}/api/platform${path}`, {
      method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-installation-id': config.installationId, 'x-license-key': config.licenseKey },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(data.code || 'SERVICE_UNAVAILABLE', data.message || 'The platform service is unavailable');
    return data;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('SERVICE_UNAVAILABLE', 'The platform service is temporarily unavailable');
  } finally { clearTimeout(timer); }
}

async function licenseStatus({ force = false } = {}) {
  const config = configuration();
  if (!config.managed) return { managed: false, source: 'unmanaged', status: 'ACTIVE', plan: 'SELF_HOSTED', features: [], limits: {}, appVersion: config.appVersion };
  const cached = await cachedEnvelope();
  if (cached && !force) {
    const payload = parseAndVerify(cached, config);
    if (new Date(payload.validUntil).getTime() > Date.now()) return applyLocalExpiry({ managed: true, source: 'cache', ...payload });
  }
  try {
    if (!refreshPromise) refreshPromise = (async () => {
      const envelope = await remote('/validate', { appVersion: config.appVersion, protocolVersion: 1, telemetry: await runtimeTelemetry() });
      const payload = parseAndVerify(envelope, config);
      await saveEnvelope(envelope, config);
      return payload;
    })().finally(() => { refreshPromise = null; });
    const payload = await refreshPromise;
    return applyLocalExpiry({ managed: true, source: 'platform', ...payload });
  } catch (error) {
    if (cached) {
      const payload = parseAndVerify(cached, config);
      if (new Date(payload.graceUntil).getTime() > Date.now()) return applyLocalExpiry({ managed: true, source: 'offline-cache', platformReachable: false, ...payload });
    }
    throw error;
  }
}

async function subscriptionCheckout(input) { return remote('/subscription/checkout', input); }
async function subscriptionVerify(input) { return remote('/subscription/verify', input); }

function publicStatus(status) {
  const config = configuration();
  return {
    managed: Boolean(status.managed), installationId: status.managed ? config.installationId : null,
    source: status.source, platformReachable: status.platformReachable !== false,
    companyName: status.companyName || null, industry: status.industry || null,
    status: status.status, plan: status.plan, billingCycle: status.billingCycle || null,
    endsAt: status.endsAt || null, renewalMessage: status.renewalMessage || '', features: status.features || [], limits: status.limits || {},
    appVersion: status.appVersion || config.appVersion, targetVersion: status.targetVersion || status.appVersion || config.appVersion,
    latestVersion: status.latestVersion || status.targetVersion || status.appVersion || config.appVersion,
    updateAvailable: Boolean(status.updateAvailable), updateChannel: status.updateChannel || 'stable',
    release: status.release || null, issuedAt: status.issuedAt || null, validUntil: status.validUntil || null, graceUntil: status.graceUntil || null,
    checkoutConfigured: Boolean(status.checkoutConfigured),
    pricing: status.pricing && typeof status.pricing === 'object' ? status.pricing : null,
    plans: Array.isArray(status.plans) ? status.plans : [],
  };
}

module.exports = { configuration, licenseStatus, publicStatus, subscriptionCheckout, subscriptionVerify };
