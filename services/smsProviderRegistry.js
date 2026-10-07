const providers = Object.freeze({
  twilio: require('./providers/twilioSmsProvider'),
  msg91: require('./providers/msg91Provider'),
  twofactor: require('./providers/twoFactorProvider'),
  fast2sms: require('./providers/fast2smsProvider'),
});
const definitions = Object.freeze([
  { id: 'twilio', label: 'Twilio', fields: [
    { key: 'accountSid', label: 'Account SID', required: true },
    { key: 'authToken', label: 'Auth token', required: true },
    { key: 'from', label: 'SMS sender / phone number', required: true },
  ] },
  { id: 'twofactor', label: '2Factor', fields: [
    { key: 'apiKey', label: 'API key', required: true },
    { key: 'templateName', label: 'Approved template name', required: false },
  ] },
  { id: 'msg91', label: 'MSG91', fields: [
    { key: 'apiKey', label: 'Auth key', required: true },
    { key: 'templateId', label: 'OTP template ID', required: true },
  ] },
  { id: 'fast2sms', label: 'Fast2SMS', fields: [
    { key: 'apiKey', label: 'API key', required: true },
    { key: 'senderId', label: 'Sender ID', required: false },
  ] },
]);
const normalizeProvider = value => {
  const name = String(value || '').trim().toLowerCase();
  return ['2factor', '2factor.in'].includes(name) ? 'twofactor' : name;
};
const isRealSmsProvider = value => Object.hasOwn(providers, normalizeProvider(value));
module.exports = { providers, definitions, normalizeProvider, isRealSmsProvider };
