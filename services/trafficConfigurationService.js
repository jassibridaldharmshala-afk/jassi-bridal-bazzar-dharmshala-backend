const { Configuration, Event, Session, Slice, Bucket, Visitor } = require('../models/TrafficAnalytics');
const { ApiError } = require('../utils/apiError');
const { DAY, cleanPath } = require('./trafficAlgorithms');
const DEFAULTS = Object.freeze({ enabled: true, consentRequired: true, timezone: 'Asia/Kolkata', sessionTimeoutMinutes: 30, rawRetentionDays: 90, summaryRetentionDays: 365, attributionDays: 7, excludedPaths: [], excludedReferrers: [], excludeLocalhost: true, ga4MeasurementId: '', ga4Enabled: false, revision: 1, privacyGeneration: 1, whatsappDigest: { enabled: false, frequency: 'DAILY', recipient: '', consent: false, templateName: '', language: 'en' } });
async function configuration(store) {
  if (!store?._id) throw new ApiError('VALIDATION_ERROR', 'Select a store for traffic analytics.');
  return { ...DEFAULTS, timezone: store.timezone || DEFAULTS.timezone, ...await Configuration.findOne({ storeId: store._id }).lean() };
}
function validateConfiguration(body, current) {
  const result = {};
  for (const key of ['enabled', 'consentRequired', 'excludeLocalhost', 'ga4Enabled']) {
    if (body[key] !== undefined) { if (typeof body[key] !== 'boolean') throw new ApiError('VALIDATION_ERROR', `Choose a valid ${key}.`); result[key] = body[key]; }
  }
  for (const [key, min, max] of [['sessionTimeoutMinutes', 5, 120], ['rawRetentionDays', 7, 180], ['summaryRetentionDays', 30, 730], ['attributionDays', 1, 90]]) {
    if (body[key] !== undefined) { const value = Number(body[key]); if (!Number.isInteger(value) || value < min || value > max) throw new ApiError('VALIDATION_ERROR', `${key} must be between ${min} and ${max}.`); result[key] = value; }
  }
  if ((result.summaryRetentionDays ?? current.summaryRetentionDays) < (result.rawRetentionDays ?? current.rawRetentionDays)) throw new ApiError('VALIDATION_ERROR', 'Summary retention cannot be shorter than raw-event retention.');
  if ((result.rawRetentionDays < current.rawRetentionDays || result.summaryRetentionDays < current.summaryRetentionDays) && body.confirmRetentionReduction !== true) throw new ApiError('VALIDATION_ERROR', 'Confirm that reducing retention can permanently delete older analytics.');
  if (body.timezone !== undefined) {
    try { new Intl.DateTimeFormat('en', { timeZone: body.timezone }).format(); result.timezone = String(body.timezone); }
    catch { throw new ApiError('VALIDATION_ERROR', 'Choose a valid IANA timezone.'); }
  }
  if (body.ga4MeasurementId !== undefined) {
    result.ga4MeasurementId = String(body.ga4MeasurementId).trim().toUpperCase();
    if (result.ga4MeasurementId && !/^G-[A-Z0-9]{4,20}$/.test(result.ga4MeasurementId)) throw new ApiError('VALIDATION_ERROR', 'Enter a valid GA4 measurement ID.');
  }
  if ((result.ga4Enabled ?? current.ga4Enabled) && !(result.ga4MeasurementId ?? current.ga4MeasurementId)) throw new ApiError('VALIDATION_ERROR', 'Add your store GA4 measurement ID before enabling GA4.');
  if ((result.ga4Enabled ?? current.ga4Enabled) && !(result.consentRequired ?? current.consentRequired)) throw new ApiError('VALIDATION_ERROR', 'GA4 requires explicit analytics consent. Enable the consent prompt.');
  for (const key of ['excludedPaths', 'excludedReferrers']) {
    if (body[key] !== undefined) {
      if (!Array.isArray(body[key]) || body[key].length > 30 || body[key].some(v => typeof v !== 'string' || v.length > 160)) throw new ApiError('VALIDATION_ERROR', `Use at most 30 ${key}.`);
      result[key] = [...new Set(body[key].filter(Boolean).map(v => key === 'excludedPaths' ? cleanPath(v) : v.toLowerCase().trim()))];
      if (key === 'excludedReferrers' && result[key].some(v => !/^[a-z0-9.-]+$/.test(v))) throw new ApiError('VALIDATION_ERROR', 'Excluded referrers must be hostnames, not URLs.');
    }
  }
  if (body.whatsappDigest !== undefined) {
    const digest = body.whatsappDigest;
    if (!digest || typeof digest !== 'object' || Array.isArray(digest) || typeof digest.enabled !== 'boolean' || typeof digest.consent !== 'boolean' || !['DAILY', 'WEEKLY'].includes(digest.frequency)) throw new ApiError('VALIDATION_ERROR', 'Choose valid WhatsApp digest settings.');
    result.whatsappDigest = { enabled: digest.enabled, frequency: digest.frequency, recipient: String(digest.recipient || '').replace(/[\s()-]/g, ''), consent: digest.consent, templateName: String(digest.templateName || '').trim(), language: String(digest.language || 'en').trim() };
    if (digest.enabled && (!result.whatsappDigest.consent || !/^\+[1-9]\d{7,14}$/.test(result.whatsappDigest.recipient) || !/^[a-z0-9_]{1,100}$/.test(result.whatsappDigest.templateName) || !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(result.whatsappDigest.language))) throw new ApiError('VALIDATION_ERROR', 'WhatsApp digest needs recipient consent, an international number and an approved traffic template/language.');
    if (result.whatsappDigest.recipient.length > 30 || result.whatsappDigest.templateName.length > 100 || result.whatsappDigest.language.length > 10) throw new ApiError('VALIDATION_ERROR', 'WhatsApp digest fields are too long.');
  }
  return result;
}
async function saveConfiguration(store, body, actorId) {
  const current = await configuration(store);
  const changes = validateConfiguration(body, current);
  if (changes.whatsappDigest) {
    changes.whatsappDigest.actorId = actorId;
    if (changes.whatsappDigest.enabled) {
      const service = require('./trafficDigestService');
      await service.assertAccess({ whatsappDigest: { actorId } }, store).catch(error => { throw new ApiError('FORBIDDEN', error.message); });
      if (!(await service.readiness(store._id)).ready) throw new ApiError('VALIDATION_ERROR', 'Configure this store’s Meta credentials and secure storefront URL in Order alerts first.');
      changes.whatsappDigest.nextRunAt = service.nextDigestDate(changes.whatsappDigest.frequency, changes.timezone || current.timezone);
    }
  }
  if (Number(body.expectedRevision) !== current.revision) throw new ApiError('CONFLICT', 'Traffic settings changed. Reload before saving.', { statusCode: 409 });
  const result = await Configuration.findOneAndUpdate({ storeId: store._id, revision: current.revision }, { $set: changes, $inc: { revision: 1 }, $setOnInsert: { storeId: store._id } }, { new: true, upsert: !current._id }).lean().catch(error => {
    if (error.code === 11000) throw new ApiError('CONFLICT', 'Traffic settings changed. Reload before saving.', { statusCode: 409 }); throw error;
  });
  if (!result) throw new ApiError('CONFLICT', 'Traffic settings changed. Reload before saving.', { statusCode: 409 });
  // Update expiry without deleting unrelated application records. Expired data
  // is excluded in queries even while MongoDB's TTL monitor is catching up.
  if (changes.rawRetentionDays !== undefined) {
    await Event.updateMany({ storeId: store._id }, [{ $set: { expiresAt: { $add: ['$receivedAt', result.rawRetentionDays * DAY] } } }]);
    await require('../models/AnalyticsEvent').updateMany({ storeId: store._id, trafficEventId: { $exists: true } }, [{ $set: { expiresAt: { $add: ['$createdAt', result.rawRetentionDays * DAY] } } }]);
  }
  if (changes.summaryRetentionDays !== undefined) {
    await Promise.all([[Session, 'lastActivityAt'], [Slice, 'hour'], [Bucket, 'hour'], [Visitor, 'lastSeenAt']].map(([Model, field]) => Model.updateMany({ storeId: store._id, disabled: { $ne: true } }, [{ $set: { expiresAt: { $add: [`$${field}`, result.summaryRetentionDays * DAY] } } }])));
  }
  return { ...DEFAULTS, ...result };
}
function publicConfiguration(config, store) {
  return { ...Object.fromEntries(['enabled', 'consentRequired', 'sessionTimeoutMinutes', 'attributionDays', 'excludedPaths', 'excludeLocalhost', 'ga4Enabled', 'ga4MeasurementId', 'revision', 'privacyGeneration'].map(key => [key, config[key]])), storeKey: String(store._id) };
}
module.exports = { DEFAULTS, configuration, validateConfiguration, saveConfiguration, publicConfiguration };
