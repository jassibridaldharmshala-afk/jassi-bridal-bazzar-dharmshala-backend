const crypto = require('crypto');
const mongoose = require('mongoose');
const SmsConfiguration = require('../models/SmsConfiguration');
const { providers, definitions, normalizeProvider, isRealSmsProvider } = require('./smsProviderRegistry');
const { encryptSecret, decryptSecret } = require('../utils/secretBox');
const { ApiError } = require('../utils/apiError');
const { getJwtSecret, isDemoOtpMode } = require('../config/env');
const { requireValidPhone } = require('../utils/phoneUtils');

const key = 'deployment';
const secretFields = '+active.credentialsEncrypted +pending.credentialsEncrypted +challenge';
const overrideEnabled = () => process.env.SMS_CONFIG_SOURCE === 'environment';
const conflict = () => new ApiError('DUPLICATE_REQUEST', 'OTP settings changed in another session. Reload before continuing.');
const invalid = message => new ApiError('VALIDATION_ERROR', message);
function revisionOf(input) {
  if (!Number.isSafeInteger(input?.revision) || input.revision < 0) throw invalid('A valid settings revision is required.');
  return input.revision;
}
function knownKeys(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(field => !allowed.includes(field))) throw invalid('Only the supported OTP settings fields can be changed.');
}
function environmentConnection() {
  const provider = normalizeProvider(process.env.SMS_PROVIDER) || 'mock';
  return { source: 'environment', provider, credentials: isRealSmsProvider(provider) ? providers[provider].getConfiguration() : null };
}
function decryptConnection(value) {
  try {
    const credentials = JSON.parse(decryptSecret(value.credentialsEncrypted));
    if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) throw new Error();
    return credentials;
  } catch {
    throw new ApiError('OTP_PROVIDER_NOT_CONFIGURED', 'Saved SMS credentials cannot be read. Ask the deployment administrator to check the encryption key or restore backend configuration.', { statusCode: 503 });
  }
}
async function resolveSmsConfiguration() {
  if (overrideEnabled() || mongoose.connection.readyState !== 1) return environmentConnection();
  // No process-level secret cache: successful activation applies on every node
  // immediately. Query/decryption errors must not silently switch providers.
  const doc = await SmsConfiguration.findById(key).select('+active.credentialsEncrypted').lean();
  if (!doc?.active || doc.active.source === 'environment') return environmentConnection();
  return { source: 'settings', provider: doc.active.provider, credentials: decryptConnection(doc.active) };
}
async function read() { return SmsConfiguration.findById(key).select(secretFields); }
function publicConnection(value) {
  if (!value) return null;
  return { source: value.source, provider: value.provider, savedFields: [...(value.savedFields || [])], verifiedAt: value.verifiedAt || null };
}
async function status(actor) {
  const doc = await read();
  const env = environmentConnection();
  let active = publicConnection(doc?.active);
  if (!active || active.source === 'environment' || overrideEnabled()) active = {
    source: 'environment', provider: env.provider, savedFields: [], verifiedAt: null,
  };
  const definition = definitions.find(item => item.id === env.provider);
  const environment = { provider: env.provider, configured: Boolean(env.credentials && !env.credentials.missing.length) };
  if (active.source === 'environment') active.configured = environment.configured;
  else active.configured = true;
  const challenge = doc?.challenge;
  const ownChallenge = challenge?.actor === String(actor._id) && challenge.phone === requireValidPhone(actor.phone);
  return {
    revision: doc?.revision || 0, active, pending: publicConnection(doc?.pending),
    providers: definitions, environment: { ...environment, label: definition?.label || env.provider },
    environmentOverride: overrideEnabled(), demoMode: isDemoOtpMode(),
    phoneMasked: `••••••${String(actor.phone).slice(-4)}`,
    retryAfter: Math.max(0, Math.ceil((Number(doc?.lastTestAt || 0) + 60000 - Date.now()) / 1000)),
    challenge: ownChallenge && challenge.state === 'READY' && challenge.expiresAt > new Date() && challenge.attempts < 5
      ? { id: challenge.id, expiresAt: challenge.expiresAt } : null,
  };
}
function encryptedConnection(provider, credentials, source) {
  const definition = definitions.find(item => item.id === provider);
  const clean = Object.fromEntries(definition.fields.map(field => [field.key, String(credentials[field.key] || '').trim()]));
  const missing = definition.fields.filter(field => field.required && !clean[field.key]);
  if (missing.length) throw invalid(`Required: ${missing.map(field => field.label).join(', ')}.`);
  return { source, provider, credentialsEncrypted: encryptSecret(JSON.stringify(clean)), savedFields: definition.fields.filter(field => clean[field.key]).map(field => field.key) };
}
async function saveDraft(input) {
  knownKeys(input, ['revision', 'source', 'provider', 'credentials']);
  const revision = revisionOf(input);
  const current = await read();
  if (revision !== Number(current?.revision || 0)) throw conflict();
  const source = input.source || 'settings';
  if (!['settings', 'environment'].includes(source)) throw invalid('Choose Settings or backend environment configuration.');
  let pending;
  if (source === 'environment') {
    if (input.provider !== undefined || input.credentials !== undefined) throw invalid('Backend configuration does not accept credentials from the browser.');
    const env = environmentConnection();
    if (!env.credentials || env.credentials.missing.length) throw invalid('Backend SMS configuration is incomplete. Configure a real provider before switching back.');
    pending = encryptedConnection(env.provider, env.credentials, source);
  } else {
    const provider = normalizeProvider(input.provider);
    const definition = definitions.find(item => item.id === provider);
    if (!definition) throw invalid('Choose Twilio, 2Factor, MSG91 or Fast2SMS.');
    const incoming = input.credentials || {};
    knownKeys(incoming, definition.fields.map(field => field.key));
    // Blank secret inputs keep saved values only for this exact provider.
    const previous = [current?.pending, current?.active].find(entry => entry?.source === 'settings' && entry.provider === provider);
    let credentials = {};
    if (previous) {
      try { credentials = decryptConnection(previous); }
      catch (error) {
        // Recovery after lost/rotated encryption material requires an entire
        // new set of required credentials and another real activation test.
        if (!definition.fields.filter(field => field.required).every(field => typeof incoming[field.key] === 'string' && incoming[field.key].trim())) throw error;
      }
    }
    for (const [field, value] of Object.entries(incoming)) {
      if (value === null && !definition.fields.find(item => item.key === field).required) { credentials[field] = ''; continue; }
      if (typeof value !== 'string' || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) throw invalid('Credential fields must be text of at most 512 characters without control characters.');
      if (value.trim()) credentials[field] = value.trim();
    }
    pending = encryptedConnection(provider, credentials, source);
  }
  const update = { $set: { pending }, $unset: { challenge: 1 }, $inc: { revision: 1 } };
  try {
    const saved = await SmsConfiguration.findOneAndUpdate({ _id: key, revision }, update, { new: true, upsert: !current, runValidators: true });
    if (!saved) throw conflict();
  } catch (error) { if (error.code === 11000) throw conflict(); throw error; }
}
const hashCode = (challenge, code) => crypto.createHmac('sha256', getJwtSecret()).update(`sms-settings:${challenge.id}:${challenge.actor}:${challenge.phone}:${challenge.revision}:${code}`).digest('hex');
async function sendTest(input, actor) {
  knownKeys(input, ['revision']);
  const revision = revisionOf(input);
  const current = await read();
  if (!current || current.revision !== revision) throw conflict();
  if (!current.pending) throw invalid('Save a provider draft first.');
  const credentials = decryptConnection(current.pending);
  const otp = String(crypto.randomInt(100000, 1000000));
  const challenge = { id: crypto.randomUUID(), actor: String(actor._id), phone: requireValidPhone(actor.phone), revision, expiresAt: new Date(Date.now() + 300000), attempts: 0, state: 'SENDING' };
  challenge.codeHash = hashCode(challenge, otp);
  const claimed = await SmsConfiguration.findOneAndUpdate({ _id: key, revision, $or: [{ lastTestAt: { $exists: false } }, { lastTestAt: { $lte: new Date(Date.now() - 60000) } }] }, { $set: { challenge, lastTestAt: new Date() } });
  if (!claimed) throw new ApiError('OTP_RATE_LIMIT', 'Please wait 60 seconds between test messages, then reload if settings changed.', { statusCode: 429 });
  try {
    // Test always sends a random, real code; never a demo OTP or another
    // provider. The browser cannot supply the destination or SMS content.
    const sent = await providers[current.pending.provider].sendOtp(challenge.phone, otp, credentials);
    if (sent?.success !== true) throw new Error();
    const result = await SmsConfiguration.updateOne({ _id: key, revision, 'challenge.id': challenge.id }, { $set: { 'challenge.state': 'READY' } });
    if (!result.matchedCount) throw conflict();
  } catch (error) {
    await SmsConfiguration.updateOne({ _id: key, 'challenge.id': challenge.id }, { $set: { 'challenge.state': 'FAILED' }, $unset: { 'challenge.codeHash': 1 } });
    if (error.errorCode === 'DUPLICATE_REQUEST') throw error;
    throw new ApiError('OTP_DELIVERY_UNAVAILABLE', 'Test SMS could not be sent. Check the selected provider credentials, approved template and balance. Your active provider has not changed.', { statusCode: 503 });
  }
}
async function activate(input, actor) {
  knownKeys(input, ['revision', 'challengeId', 'otp']);
  const revision = revisionOf(input);
  if (typeof input.otp !== 'string' || !/^\d{6}$/.test(input.otp) || typeof input.challengeId !== 'string') throw invalid('Enter the six-digit test OTP.');
  if (overrideEnabled()) throw invalid('Backend emergency override is enabled. Remove SMS_CONFIG_SOURCE=environment before activating Settings configuration.');
  const current = await read();
  if (!current || current.revision !== revision) throw conflict();
  const challenge = current.challenge;
  const usable = challenge && challenge.id === input.challengeId && challenge.actor === String(actor._id)
    && challenge.phone === requireValidPhone(actor.phone) && challenge.state === 'READY'
    && challenge.revision === revision && challenge.expiresAt > new Date() && challenge.attempts < 5 && current.pending;
  if (!usable) throw invalid('This test OTP is expired or unavailable. Request a new test.');
  const expected = Buffer.from(hashCode(challenge, input.otp));
  const actual = Buffer.from(challenge.codeHash || '');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    await SmsConfiguration.updateOne({ _id: key, revision, 'challenge.id': challenge.id, 'challenge.attempts': { $lt: 5 } }, { $inc: { 'challenge.attempts': 1 } });
    throw invalid('Incorrect test OTP. Five failed attempts require a new test.');
  }
  if (current.pending.source === 'environment') {
    const env = environmentConnection();
    const saved = decryptConnection(current.pending);
    if (env.provider !== current.pending.provider || !env.credentials || Object.keys(saved).some(field => saved[field] !== env.credentials[field])) throw invalid('Backend SMS configuration changed after the test. Save and test it again.');
  }
  const active = { ...current.pending.toObject(), verifiedAt: new Date() };
  const updated = await SmsConfiguration.updateOne({ _id: key, revision, 'challenge.id': challenge.id, 'challenge.state': 'READY', 'challenge.attempts': { $lt: 5 }, 'challenge.expiresAt': { $gt: new Date() } }, {
    $set: { active }, $unset: { pending: 1, challenge: 1 }, $inc: { revision: 1 },
  });
  if (!updated.matchedCount) throw conflict();
  return active.provider;
}
async function discardDraft(input) {
  knownKeys(input, ['revision']);
  const revision = revisionOf(input);
  const result = await SmsConfiguration.updateOne({ _id: key, revision }, { $unset: { pending: 1, challenge: 1 }, $inc: { revision: 1 } });
  if (!result.matchedCount) throw conflict();
}
module.exports = { resolveSmsConfiguration, status, saveDraft, sendTest, activate, discardDraft };
