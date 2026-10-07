/**
 * Central place for secrets and mode flags.
 *
 * Production must supply real secrets. Development keeps working without a
 * .env file so local demos and offline sessions are unaffected.
 */

const DEV_JWT_SECRET = 'samira_dev_only_access_secret_not_for_production';
const DEV_JWT_REFRESH_SECRET = 'samira_dev_only_refresh_secret_not_for_production';
const DEFAULT_DEMO_OTP = '123456';

const REQUIRED_PRODUCTION_SECRETS = ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'MONGO_URI'];

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

function missingProductionSecrets() {
  if (!isProduction()) return [];
  return REQUIRED_PRODUCTION_SECRETS.filter((key) => !String(process.env[key] || '').trim());
}

function assertProductionSecrets() {
  const missing = missingProductionSecrets();
  if (missing.length) {
    throw new Error(`Missing required production environment variables: ${missing.join(', ')}`);
  }
  if (process.env.RENDER || process.env.STRICT_PRODUCTION_CONFIG === 'true') {
    const problems = productionConfigurationIssues();
    if (problems.length) throw new Error(`Unsafe production configuration: ${problems.join('; ')}`);
  }
}

function present(name) { return Boolean(String(process.env[name] || '').trim()); }
function complete(names) { return names.every(present); }

function productionConfigurationIssues() {
  if (!isProduction()) return [];
  const issues = [];
  const access = String(process.env.JWT_SECRET || '');
  const refresh = String(process.env.JWT_REFRESH_SECRET || '');
  if (access.length < 32 || /change.before.production|dev.only|replace.with/i.test(access)) issues.push('JWT_SECRET must be a strong deployment secret');
  if (refresh.length < 32 || /change.before.production|dev.only|replace.with/i.test(refresh)) issues.push('JWT_REFRESH_SECRET must be a strong deployment secret');
  if (access && refresh && access === refresh) issues.push('access and refresh token secrets must be different');
  if (process.env.REQUIRE_MEDIA_STORAGE === 'true' && !(
    complete(['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME', 'R2_PUBLIC_URL'])
    || complete(['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'])
  )) issues.push('persistent media storage is required but incomplete');
  if (process.env.REQUIRE_REDIS === 'true' && !present('REDIS_URL')) issues.push('REDIS_URL is required');
  if (process.env.PAYMENTS_ENABLED === 'true' && !complete(['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'])) {
    issues.push('live payments require Razorpay key, secret and webhook secret');
  }
  return issues;
}

function getJwtSecret() {
  const secret = String(process.env.JWT_SECRET || '').trim();
  if (secret) return secret;
  if (isProduction()) throw new Error('JWT_SECRET is required in production');
  return DEV_JWT_SECRET;
}

function getJwtRefreshSecret() {
  const secret = String(process.env.JWT_REFRESH_SECRET || '').trim();
  if (secret) return secret;
  if (isProduction()) throw new Error('JWT_REFRESH_SECRET is required in production');
  return String(process.env.JWT_SECRET || '').trim() || DEV_JWT_REFRESH_SECRET;
}

/**
 * OTP_MODE controls whether the fixed demo code is accepted.
 *
 * demo       - fixed DEMO_OTP is issued and surfaced to the client so the
 *              product can be demonstrated without an SMS provider.
 * production - a random code is issued, never returned to the client, and a
 *              delivery failure fails the request instead of silently
 *              falling back to a guessable code.
 *
 * Defaults to demo so the existing demo deployment keeps working. Switch to
 * production once a real SMS provider is connected.
 */
function getOtpMode() {
  const mode = String(process.env.OTP_MODE || '').trim().toLowerCase();
  if (mode === 'production' || mode === 'demo') return mode;
  return 'demo';
}

function isDemoOtpMode() {
  return getOtpMode() === 'demo';
}

function getDemoOtp() {
  const code = String(process.env.DEMO_OTP || process.env.OTP_DEV_CODE || '').trim();
  return /^\d{6}$/.test(code) ? code : DEFAULT_DEMO_OTP;
}

module.exports = {
  DEV_JWT_SECRET,
  DEV_JWT_REFRESH_SECRET,
  REQUIRED_PRODUCTION_SECRETS,
  assertProductionSecrets,
  getDemoOtp,
  getJwtRefreshSecret,
  getJwtSecret,
  getOtpMode,
  isDemoOtpMode,
  isProduction,
  missingProductionSecrets,
  productionConfigurationIssues,
};
