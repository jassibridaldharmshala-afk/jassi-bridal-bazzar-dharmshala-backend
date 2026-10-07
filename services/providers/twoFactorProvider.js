const { readConfiguration, requireConfiguration, internationalPhone, requireOtp, requestJson, providerError } = require('./smsProviderUtils');

function getConfiguration(override) {
  return readConfiguration({ apiKey: ['TWOFACTOR_API_KEY'] }, { templateName: ['TWOFACTOR_TEMPLATE_NAME'] }, override);
}

async function sendOtp(phone, otp, override) {
  const config = requireConfiguration(getConfiguration(override));
  // Manual Generation API: send the same code our backend hashes and verifies.
  // https://2factor.in/api-docs (Send OTP / Manual Generation)
  const parts = [config.apiKey, 'SMS', internationalPhone(phone), requireOtp(otp)];
  if (config.templateName) parts.push(config.templateName);
  const url = `https://2factor.in/API/V1/${parts.map(encodeURIComponent).join('/')}`;
  const { response, data } = await requestJson(url, { method: 'GET', headers: { Accept: 'application/json' } });
  if (!response.ok || data?.Status !== 'Success' || typeof data.Details !== 'string' || !data.Details.trim()) {
    const rejectedCredentials = [401, 403].includes(response.status) || /^invalid api key$/i.test(String(data?.Details || '').trim());
    throw providerError(rejectedCredentials ? 'OTP_PROVIDER_AUTH_FAILED' : 'OTP_DELIVERY_UNAVAILABLE');
  }
  return { success: true, provider: 'twofactor' };
}

module.exports = { sendOtp, getConfiguration };
