const { readConfiguration, requireConfiguration, internationalPhone, requireOtp, requestJson, providerError } = require('./smsProviderUtils');

function getConfiguration(override) {
  return readConfiguration({
    apiKey: ['MSG91_AUTH_KEY', 'SMS_API_KEY'],
    templateId: ['MSG91_TEMPLATE_ID', 'SMS_TEMPLATE_ID'],
  }, {}, override);
}

async function sendOtp(phone, otp, override) {
  const config = requireConfiguration(getConfiguration(override));
  const { response, data } = await requestJson('https://control.msg91.com/api/v5/otp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      authkey: config.apiKey,
    },
    body: JSON.stringify({
      template_id: config.templateId,
      mobile: internationalPhone(phone).slice(1),
      otp: requireOtp(otp),
    }),
  });

  // MSG91 can return an application-level error with HTTP 200.
  if (!response.ok || data?.type !== 'success') {
    throw providerError([401, 403].includes(response.status) ? 'OTP_PROVIDER_AUTH_FAILED' : 'OTP_DELIVERY_UNAVAILABLE');
  }
  return { success: true, provider: 'msg91' };
}

module.exports = { sendOtp, getConfiguration };
