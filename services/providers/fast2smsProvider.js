const { readConfiguration, requireConfiguration, internationalPhone, requireOtp, requestJson, providerError } = require('./smsProviderUtils');

function getConfiguration(override) {
  return readConfiguration({ apiKey: ['FAST2SMS_API_KEY', 'SMS_API_KEY'] }, { senderId: ['FAST2SMS_SENDER_ID', 'SMS_SENDER_ID'] }, override);
}

async function sendOtp(phone, otp, override) {
  const config = requireConfiguration(getConfiguration(override));
  const number = internationalPhone(phone);
  if (!/^\+91[6-9]\d{9}$/.test(number)) throw providerError();
  const { response, data } = await requestJson('https://www.fast2sms.com/dev/bulkV2', {
    method: 'POST',
    headers: {
      authorization: config.apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      route: 'otp',
      variables_values: requireOtp(otp),
      numbers: number.slice(3),
      sender_id: config.senderId || undefined,
    }),
  });

  if (!response.ok || data?.return !== true) {
    throw providerError([401, 403].includes(response.status) ? 'OTP_PROVIDER_AUTH_FAILED' : 'OTP_DELIVERY_UNAVAILABLE');
  }
  return { success: true, provider: 'fast2sms' };
}

module.exports = { sendOtp, getConfiguration };
