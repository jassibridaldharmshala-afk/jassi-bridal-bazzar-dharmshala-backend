const mockSmsProvider = require('./providers/mockSmsProvider');
const msg91Provider = require('./providers/msg91Provider');
const fast2smsProvider = require('./providers/fast2smsProvider');
const twilioSmsProvider = require('./providers/twilioSmsProvider');
const twoFactorProvider = require('./providers/twoFactorProvider');
const { isDemoOtpMode } = require('../config/env');

// One registry for delivery, owner trust, handover and configuration diagnostics.
const { providers, normalizeProvider, isRealSmsProvider } = require('./smsProviderRegistry');

function getProvider() {
  if (process.env.NODE_ENV !== 'production' && isDemoOtpMode()) return 'mock';
  return normalizeProvider(process.env.SMS_PROVIDER) || 'mock';
}

function getSmsProviderStatus() {
  const provider = normalizeProvider(process.env.SMS_PROVIDER) || 'mock';
  const supported = isRealSmsProvider(provider);
  const missing = supported ? providers[provider].getConfiguration().missing : ['SMS_PROVIDER'];
  return { provider, supported, configured: supported && missing.length === 0, missing };
}

async function sendOtp(phone, otp, { requireReal = false } = {}) {
  try {
    const connection = await require('./smsConfigurationService').resolveSmsConfiguration();
    const configured = connection.provider;
    // A typo must never silently select mock delivery, even in development.
    if (configured !== 'mock' && !isRealSmsProvider(configured)) return { success: false, code: 'OTP_PROVIDER_NOT_CONFIGURED' };
    const provider = !requireReal && process.env.NODE_ENV !== 'production' && isDemoOtpMode() ? 'mock' : configured;
    if (isRealSmsProvider(provider)) {
      const delivery = await providers[provider].sendOtp(phone, otp, connection.credentials || undefined);
      if (delivery?.success !== true) return { success: false, code: 'OTP_DELIVERY_UNAVAILABLE' };
      return { success: true, provider };
    }
    if (requireReal || !isDemoOtpMode()) return { success: false, code: 'OTP_PROVIDER_NOT_CONFIGURED' };
    return await sendViaMock(phone, otp);
  } catch (error) {
    const code = ['OTP_PROVIDER_AUTH_FAILED', 'OTP_PROVIDER_NOT_CONFIGURED'].includes(error.errorCode)
      ? error.errorCode : 'OTP_DELIVERY_UNAVAILABLE';
    console.warn('SMS delivery failed:', code, Number.isSafeInteger(error.providerCode) ? error.providerCode : '');
    return { success: false, code };
  }
}

async function sendViaMock(phone, otp) {
  return mockSmsProvider.sendOtp(phone, otp);
}

async function sendViaMSG91(phone, otp) {
  return msg91Provider.sendOtp(phone, otp);
}

async function sendViaFast2SMS(phone, otp) {
  return fast2smsProvider.sendOtp(phone, otp);
}

async function sendViaTwilioSMS(phone, otp) {
  return twilioSmsProvider.sendOtp(phone, otp);
}

async function sendViaTwoFactor(phone, otp) {
  return twoFactorProvider.sendOtp(phone, otp);
}

module.exports = {
  getProvider,
  isRealSmsProvider,
  getSmsProviderStatus,
  sendOtp,
  sendViaMock,
  sendViaMSG91,
  sendViaFast2SMS,
  sendViaTwilioSMS,
  sendViaTwoFactor,
};
