const { readConfiguration, requireConfiguration, internationalPhone, requireOtp, requestJson, providerError } = require('./smsProviderUtils');

async function sendOtp(phone, otp, override) {
  const config = requireConfiguration(getConfiguration(override));
  const code = requireOtp(otp);

  const body = new URLSearchParams({
    To: internationalPhone(phone),
    From: config.from,
    Body: `Your Jassi General Store OTP is ${code}. It is valid for ${process.env.OTP_EXPIRY_MINUTES || 5} minutes. Do not share this OTP with anyone.`,
  });
  const { response, data } = await requestJson(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!response.ok || typeof data?.sid !== 'string' || !data.sid || data.error_code || ['failed', 'undelivered', 'canceled'].includes(data.status)) {
    const rejectedCredentials = response.status === 401 || response.status === 403 || Number(data?.code) === 20003;
    // Provider messages can contain account identifiers or other request data.
    // Keep diagnostics actionable without logging or returning that raw text.
    const error = providerError(rejectedCredentials ? 'OTP_PROVIDER_AUTH_FAILED' : 'OTP_DELIVERY_UNAVAILABLE');
    error.providerCode = Number.isSafeInteger(Number(data?.code)) ? Number(data.code) : undefined;
    throw error;
  }
  return { success: true, provider: 'twilio', accountSid: config.accountSid, messageSid: data.sid };
}

function getConfiguration(override) {
  return readConfiguration({ accountSid: ['SMS_ACCOUNT_SID'], authToken: ['SMS_AUTH_TOKEN'], from: ['SMS_SENDER_ID'] }, {}, override);
}

module.exports = { sendOtp, getConfiguration };
