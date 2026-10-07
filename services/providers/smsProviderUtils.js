const { requireValidPhone } = require('../../utils/phoneUtils');

// Provider-specific names take precedence; legacy SMS_* settings keep working.
function readConfiguration(fields, optional = {}, override) {
  const values = {};
  const missing = [];
  for (const [field, names] of Object.entries({ ...fields, ...optional })) {
    values[field] = override === undefined
      ? names.map(name => String(process.env[name] || '').trim()).find(Boolean) || ''
      : String(override[field] || '').trim();
    if (!values[field] && Object.hasOwn(fields, field)) missing.push(names[0]);
  }
  return { ...values, missing };
}

function providerError(code = 'OTP_DELIVERY_UNAVAILABLE') {
  const messages = {
    OTP_PROVIDER_NOT_CONFIGURED: 'The selected SMS provider is not configured.',
    OTP_PROVIDER_AUTH_FAILED: 'The selected SMS provider rejected its credentials.',
    OTP_DELIVERY_UNAVAILABLE: 'The SMS provider could not accept the OTP message.',
  };
  const error = new Error(messages[code] || messages.OTP_DELIVERY_UNAVAILABLE);
  error.errorCode = code;
  error.statusCode = 503;
  return error;
}

function requireConfiguration(config) {
  if (config.missing.length) throw providerError('OTP_PROVIDER_NOT_CONFIGURED');
  return config;
}

function internationalPhone(phone) {
  const normalized = requireValidPhone(phone);
  return normalized.startsWith('+') ? normalized : `+91${normalized}`;
}

function requireOtp(otp) {
  const value = String(otp || '');
  if (!/^\d{6}$/.test(value)) throw providerError();
  return value;
}

async function requestJson(url, options) {
  try {
    const response = await fetch(url, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    const data = await response.json().catch(() => null);
    return { response, data };
  } catch {
    // URLs can contain credentials and OTPs (2Factor). Never propagate them.
    throw providerError();
  }
}

module.exports = { readConfiguration, providerError, requireConfiguration, internationalPhone, requireOtp, requestJson };
