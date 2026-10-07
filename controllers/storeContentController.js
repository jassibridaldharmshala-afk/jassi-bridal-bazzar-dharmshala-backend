const mongoose = require('mongoose');
const { randomUUID } = require('crypto');
const WebsiteTheme = require('../models/WebsiteTheme');
const Store = require('../models/Store');
const Settings = require('../models/Settings');
const StoreContentVersion = require('../models/StoreContentVersion');
const { roleAllows } = require('../models/StoreMember');
const { readConfiguration } = require('../services/masterConfigurationService');
const { isMasterOwner } = require('../config/masterOwner');
const { normalizeWebsiteConfig } = require('../config/websiteCustomization');
const { applyStorePresentation } = require('../services/storeSettingsValidation');
const { asyncHandler } = require('../middleware/validate');
const { ApiError, notFound } = require('../utils/apiError');
const { logAudit } = require('../services/auditService');
const { LIMITS, applyContent, clone, compareContent, contentPreflight, reserveVersion, sanitizeContent, snapshotContent } = require('../services/storeContentService');

const LEGACY_FIELDS = {
  websiteName: ['branding', 'websiteName'], tagline: ['branding', 'tagline'],
  announcement: ['header', 'announcementText'], footerDescription: ['footer', 'description'],
  contactEmail: ['footer', 'contactEmail'], contactPhone: ['footer', 'contactPhone'], contactAddress: ['footer', 'contactAddress'],
};

function invalidate() { require('./websiteCustomizationController')._invalidateActiveCache(); }
async function allowed(req) {
  if (isMasterOwner(req.user)) return;
  if (!req.store && !process.env.CLIENT_INSTALLATION_ID && process.env.STANDALONE_CLIENT_MODE !== 'true') {
    throw new ApiError('FORBIDDEN', 'Use the seller Store Content workspace for a client store. Platform-wide content is restricted to the master owner.');
  }
  if (!(await readConfiguration(req.store?._id)).structure.clientPermissions.content) throw new ApiError('FORBIDDEN', 'Store content editing is not enabled for this account');
}
function requireFuture(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() < Date.now() + 60000 || date.getTime() > Date.now() + 366 * 86400000) throw new ApiError('VALIDATION_ERROR', 'Choose a publish time from 1 minute to 1 year in the future.');
  return date;
}
function note(value, fallback) {
  const result = String(value || fallback).trim();
  if (result.length > LIMITS.note) throw new ApiError('VALIDATION_ERROR', `Publish note must be ${LIMITS.note} characters or fewer.`);
  return result;
}
async function globalBase() {
  const theme = await WebsiteTheme.findOne({ isActive: true, publishedConfig: { $exists: true, $ne: null } }).sort('-publishedAt').lean();
  return theme?.publishedConfig || null;
}
async function getContext(req, mutable = false) {
  if (req.store) {
    const store = mutable ? await Store.findById(req.store._id) : req.store;
    const base = await globalBase();
    if (!base && !store?.storefrontDesign?.publishedConfig) return { available: false, scopeType: 'STORE', store };
    const publishedConfig = store.storefrontDesign?.publishedConfig || base;
    return { available: true, scopeType: 'STORE', scopeId: store._id, store, publishedConfig,
      draftConfig: store.storefrontDesign?.draftConfig || publishedConfig, revision: Number(store.storefrontDesign?.revision || 0),
      updatedAt: store.storefrontDesign?.updatedAt || store.updatedAt, scheduledFor: store.storefrontDesign?.scheduledContentFor,
      scheduledId: store.storefrontDesign?.scheduledContentId, scheduledNote: store.storefrontDesign?.scheduledContentNote, scheduledDesignFor: store.storefrontDesign?.scheduledFor,
      scheduledStatus: store.storefrontDesign?.scheduledContentStatus, scheduledAttempts: store.storefrontDesign?.scheduledContentAttempts,
      scheduledError: store.storefrontDesign?.scheduledContentError, scheduledLastAttemptAt: store.storefrontDesign?.scheduledContentLastAttemptAt,
      publishedAt: store.storefrontDesign?.publishedAt };
  }
  const query = WebsiteTheme.findOne({ isActive: true });
  const theme = mutable ? await query : await query.lean();
  if (!theme?.publishedConfig) return { available: false, scopeType: 'THEME', theme };
  return { available: true, scopeType: 'THEME', scopeId: theme._id, theme, publishedConfig: theme.publishedConfig,
    draftConfig: theme.draftConfig || theme.publishedConfig, revision: theme.updatedAt, updatedAt: theme.updatedAt,
    scheduledId: theme.scheduledContentId, scheduledFor: theme.scheduledContentFor, scheduledNote: theme.scheduledContentNote, scheduledDesignFor: theme.scheduledFor,
    scheduledStatus: theme.scheduledContentStatus, scheduledAttempts: theme.scheduledContentAttempts,
    scheduledError: theme.scheduledContentError, scheduledLastAttemptAt: theme.scheduledContentLastAttemptAt, publishedAt: theme.publishedAt };
}
function requireRevision(req, ctx) {
  if (ctx.scopeType === 'STORE') {
    if (!Number.isInteger(Number(req.body?.expectedRevision)) || Number(req.body.expectedRevision) !== ctx.revision) throw new ApiError('DUPLICATE_REQUEST', 'Content changed in another session. Reload before saving.');
  } else if (new Date(req.body?.revision || req.body?.expectedUpdatedAt).getTime() !== new Date(ctx.revision).getTime()) {
    throw new ApiError('DUPLICATE_REQUEST', 'Content changed in another session. Reload before saving.');
  }
}
async function saveContext(ctx, values) {
  if (ctx.scopeType === 'THEME') {
    const defined = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
    const removed = Object.fromEntries(Object.entries(values).filter(([, value]) => value === undefined).map(([key]) => [key, 1]));
    const update = { $set: defined, $inc: { __v: 1 }, ...(Object.keys(removed).length ? { $unset: removed } : {}) };
    const saved = await WebsiteTheme.findOneAndUpdate({ _id: ctx.scopeId, isActive: true, updatedAt: ctx.theme.updatedAt }, update, { new: true, runValidators: true });
    if (!saved) throw new ApiError('DUPLICATE_REQUEST', 'Content changed while saving. Reload and review.');
    return { revision: saved.updatedAt, updatedAt: saved.updatedAt };
  }
  const design = { ...(ctx.store.storefrontDesign?.toObject?.() || ctx.store.storefrontDesign || {}), ...values,
    revision: ctx.revision + 1, updatedAt: new Date() };
  const saved = await Store.findOneAndUpdate({ _id: ctx.store._id, __v: ctx.store.__v }, { $set: { storefrontDesign: design }, $inc: { __v: 1 } }, { new: true, runValidators: true });
  if (!saved) throw new ApiError('DUPLICATE_REQUEST', 'Store content changed while saving. Reload and review.');
  return { revision: Number(saved.storefrontDesign.revision), updatedAt: saved.storefrontDesign.updatedAt };
}
function managedSettings(req, config, settings) {
  const effective = applyStorePresentation(config, settings);
  return { settingsPath: req.store ? '/seller/settings' : '/admin/settings', groups: [
    { id: 'identity', label: 'Store identity', enabled: Boolean(settings.brandIdentityEnabled), source: settings.brandIdentityEnabled ? 'Settings override' : 'Website Designer', fields: [
      { label: 'Company / store name', value: effective.branding.websiteName || '' }, { label: 'Tagline', value: effective.branding.tagline || '' }] },
    { id: 'contact', label: 'Contact & footer', enabled: Boolean(settings.contactDetailsEnabled), source: settings.contactDetailsEnabled ? 'Settings override' : 'Website Designer', fields: [
      { label: 'Contact email', value: effective.footer.contactEmail || '' }, { label: 'Contact phone', value: effective.footer.contactPhone || '' },
      { label: 'Contact address', value: effective.footer.contactAddress || '' }, { label: 'Footer description', value: effective.footer.description || '' }] },
    { id: 'announcement', label: 'Announcement bar', enabled: settings.announcementEnabled !== undefined || settings.announcementText !== undefined, source: settings.announcementEnabled !== undefined || settings.announcementText !== undefined ? 'Settings override' : 'Website Designer', fields: [{ label: 'Announcement', value: effective.header.announcementText || '' }] },
  ] };
}
async function responsePayload(req, ctx) {
  if (!ctx.available) return { available: false, designerPath: req.store ? '/seller/design' : '/admin/customization' };
  const draft = snapshotContent(ctx.draftConfig); const published = snapshotContent(ctx.publishedConfig);
  const latest = await StoreContentVersion.findOne({ scopeType: ctx.scopeType, scopeId: ctx.scopeId }).populate('publishedBy', 'name email phone').sort('-version').lean();
  const config = normalizeWebsiteConfig(ctx.publishedConfig);
  const settings = await Settings.findOne(req.tenantFilter || (req.store?._id ? { storeId: req.store._id } : {})).lean() || {};
  const previewConfig = applyStorePresentation(normalizeWebsiteConfig(ctx.draftConfig), settings);
  const capabilities = req.storeMember ? {
    read: roleAllows(req.storeMember.role, 'content.read'), write: roleAllows(req.storeMember.role, 'content.write'), publish: roleAllows(req.storeMember.role, 'content.publish'),
  } : { read: true, write: true, publish: true };
  return { available: true, scope: ctx.scopeType.toLowerCase(), revision: ctx.revision, updatedAt: ctx.updatedAt, draft, published,
    capabilities, managed: managedSettings(req, config, settings), limits: LIMITS, previewConfig,
    timezone: req.store?.timezone || process.env.STORE_TIMEZONE || 'Asia/Kolkata', scheduledFor: ctx.scheduledFor || null, scheduledNote: ctx.scheduledNote || '',
    scheduledStatus: ctx.scheduledFor ? (ctx.scheduledStatus || 'SCHEDULED') : null, scheduledAttempts: Number(ctx.scheduledAttempts || 0), scheduledError: ctx.scheduledError || '', scheduledLastAttemptAt: ctx.scheduledLastAttemptAt || null,
    scheduledDesignFor: ctx.scheduledDesignFor || null, publishedAt: ctx.publishedAt || latest?.createdAt || null,
    publishedBy: latest?.publishedBy ? (latest.publishedBy.name || latest.publishedBy.email || latest.publishedBy.phone || 'Store team') : '', lastVersion: latest?.version || null,
    content: Object.fromEntries(Object.entries(LEGACY_FIELDS).map(([key, [group, field]]) => [key, config[group][field]])),
    sections: draft.sections.map(({ id, label, heading, description, buttonText }) => ({ id, label, heading, description, buttonText })) };
}

exports.get = asyncHandler(async (req, res) => { await allowed(req); res.json(await responsePayload(req, await getContext(req))); });

exports.saveDraft = asyncHandler(async (req, res) => {
  await allowed(req); const ctx = await getContext(req, true); if (!ctx.available) throw notFound('Publish an initial website design before editing its content.'); requireRevision(req, ctx);
  const content = sanitizeContent(req.body?.content, ctx.draftConfig); const draftConfig = applyContent(ctx.draftConfig, content);
  const result = await saveContext(ctx, ctx.scopeType === 'THEME' ? { draftConfig, updatedBy: req.user._id } : { draftConfig, updatedBy: req.user._id });
  invalidate(); logAudit({ req, action: 'STORE_CONTENT_DRAFT_SAVE', entityType: ctx.scopeType === 'THEME' ? 'WebsiteTheme' : 'Store', entityId: ctx.scopeId, after: { changedFields: compareContent(snapshotContent(ctx.draftConfig), content).map((item) => item.path) } });
  res.json({ success: true, ...result, draft: snapshotContent(draftConfig) });
});

exports.preflight = asyncHandler(async (req, res) => {
  await allowed(req); const ctx = await getContext(req); if (!ctx.available) throw notFound('Publish an initial website design before reviewing its content.'); requireRevision(req, ctx);
  const content = req.body?.content ? sanitizeContent(req.body.content, ctx.draftConfig) : snapshotContent(ctx.draftConfig);
  const result = contentPreflight(content, ctx.draftConfig); result.changes = compareContent(snapshotContent(ctx.publishedConfig), content); result.scheduledDesignUpdated = Boolean(ctx.scheduledDesignFor); res.json(result);
});

exports.publish = asyncHandler(async (req, res) => {
  await allowed(req); const ctx = await getContext(req, true); if (!ctx.available) throw notFound('Publish an initial website design before publishing content.'); requireRevision(req, ctx);
  const content = sanitizeContent(req.body?.content || snapshotContent(ctx.draftConfig), ctx.draftConfig); const preflight = contentPreflight(content, ctx.draftConfig);
  if (!preflight.ready) throw new ApiError('VALIDATION_ERROR', preflight.blocking[0] || 'Resolve the blocking content checks before publishing.');
  const previous = snapshotContent(ctx.publishedConfig); const history = await reserveVersion(ctx.scopeType, ctx.scopeId, content, previous, note(req.body?.note, 'Published from Content Studio'), req.user._id);
  try {
    const values = { publishedConfig: applyContent(ctx.publishedConfig, content), draftConfig: applyContent(ctx.draftConfig, content), publishedAt: new Date(), updatedBy: req.user._id,
      scheduledContent: undefined, scheduledContentId: undefined, scheduledContentFor: undefined, scheduledContentNote: undefined, scheduledContentBy: undefined,
      scheduledContentStatus: undefined, scheduledContentAttempts: undefined, scheduledContentLeaseUntil: undefined, scheduledContentLastAttemptAt: undefined, scheduledContentError: undefined };
    if (ctx.scopeType === 'THEME') values.publishedBy = req.user._id;
    const scheduledConfig = ctx.scopeType === 'THEME' ? ctx.theme.scheduledConfig : ctx.store.storefrontDesign?.scheduledConfig;
    if (scheduledConfig) values.scheduledConfig = applyContent(scheduledConfig, content);
    const result = await saveContext(ctx, values); invalidate();
    if (ctx.scheduledId) await StoreContentVersion.deleteMany({ releaseId: ctx.scheduledId, state: 'RESERVED' }).catch(() => null);
    logAudit({ req, action: 'STORE_CONTENT_PUBLISH', entityType: ctx.scopeType === 'THEME' ? 'WebsiteTheme' : 'Store', entityId: ctx.scopeId, before: previous, after: { version: history.version, changedFields: history.changes.map((item) => item.path) } });
    res.json({ success: true, ...result, publishedAt: new Date(), version: history.version, preflight, scheduledDesignUpdated: Boolean(ctx.scheduledDesignFor) });
  } catch (error) { await StoreContentVersion.deleteOne({ _id: history._id }).catch(() => null); throw error; }
});

exports.schedule = asyncHandler(async (req, res) => {
  await allowed(req); const ctx = await getContext(req, true); if (!ctx.available) throw notFound('Publish an initial website design before scheduling content.'); requireRevision(req, ctx);
  const scheduledFor = requireFuture(req.body?.scheduledFor); const content = sanitizeContent(req.body?.content || snapshotContent(ctx.draftConfig), ctx.draftConfig);
  const preflight = contentPreflight(content, ctx.draftConfig);
  if (!preflight.ready) throw new ApiError('VALIDATION_ERROR', preflight.blocking[0] || 'Resolve the blocking content checks before scheduling.');
  if (ctx.scheduledFor && req.body?.replaceExisting !== true) throw new ApiError('DUPLICATE_REQUEST', 'A content release is already scheduled. Confirm that you want to replace it.');
  const scheduledNote = note(req.body?.note, 'Scheduled content publish');
  const releaseId = randomUUID();
  const draftConfig = applyContent(ctx.draftConfig, content);
  const result = await saveContext(ctx, { draftConfig, scheduledContent: clone(content), scheduledContentId: releaseId, scheduledContentFor: scheduledFor, scheduledContentNote: scheduledNote, scheduledContentBy: req.user._id,
    scheduledContentStatus: 'SCHEDULED', scheduledContentAttempts: 0, scheduledContentLeaseUntil: undefined, scheduledContentLastAttemptAt: undefined, scheduledContentError: undefined, updatedBy: req.user._id });
  if (ctx.scheduledId) await StoreContentVersion.deleteMany({ releaseId: ctx.scheduledId, state: 'RESERVED' }).catch(() => null);
  invalidate(); logAudit({ req, action: ctx.scheduledFor ? 'STORE_CONTENT_RESCHEDULE' : 'STORE_CONTENT_SCHEDULE', entityType: ctx.scopeType === 'THEME' ? 'WebsiteTheme' : 'Store', entityId: ctx.scopeId, after: { releaseId, scheduledFor, note: scheduledNote, timezone: String(req.body?.timezone || '') } });
  res.json({ success: true, ...result, draft: snapshotContent(draftConfig), scheduledFor, scheduledNote, scheduledStatus: 'SCHEDULED', scheduledAttempts: 0, scheduledError: '' });
});

exports.cancelSchedule = asyncHandler(async (req, res) => {
  await allowed(req); const ctx = await getContext(req, true); requireRevision(req, ctx);
  const result = await saveContext(ctx, { scheduledContent: undefined, scheduledContentId: undefined, scheduledContentFor: undefined, scheduledContentNote: undefined, scheduledContentBy: undefined,
    scheduledContentStatus: undefined, scheduledContentAttempts: undefined, scheduledContentLeaseUntil: undefined, scheduledContentLastAttemptAt: undefined, scheduledContentError: undefined, updatedBy: req.user._id });
  if (ctx.scheduledId) await StoreContentVersion.deleteMany({ releaseId: ctx.scheduledId, state: 'RESERVED' }).catch(() => null);
  invalidate(); logAudit({ req, action: 'STORE_CONTENT_SCHEDULE_CANCEL', entityType: ctx.scopeType === 'THEME' ? 'WebsiteTheme' : 'Store', entityId: ctx.scopeId }); res.json({ success: true, ...result });
});

exports.history = asyncHandler(async (req, res) => {
  await allowed(req); const ctx = await getContext(req); if (!ctx.scopeId) return res.json([]);
  const paged = req.query?.paged === '1';
  const page = Math.max(1, Math.min(100000, Number(req.query?.page || 1) || 1));
  const limit = Math.max(5, Math.min(50, Number(req.query?.limit || (paged ? 20 : 100)) || 20));
  const query = String(req.query?.q || '').trim().slice(0, 80).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const filter = { scopeType: ctx.scopeType, scopeId: ctx.scopeId, state: { $ne: 'RESERVED' }, ...(query ? { note: { $regex: query, $options: 'i' } } : {}) };
  const [rows, total] = await Promise.all([
    StoreContentVersion.find(filter).populate('publishedBy', 'name email phone').select('-content').sort('-version').skip((page - 1) * limit).limit(limit).lean(),
    StoreContentVersion.countDocuments(filter),
  ]);
  const items = rows.map((item) => ({ ...item, publishedByName: item.publishedBy?.name || item.publishedBy?.email || item.publishedBy?.phone || 'Store team' }));
  res.json(paged ? { items, pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)), hasMore: page * limit < total } } : items);
});

exports.restore = asyncHandler(async (req, res) => {
  await allowed(req); const ctx = await getContext(req, true); requireRevision(req, ctx);
  if (!mongoose.isValidObjectId(req.params.versionId)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid content version.');
  const version = await StoreContentVersion.findOne({ _id: req.params.versionId, scopeType: ctx.scopeType, scopeId: ctx.scopeId }).lean(); if (!version) throw notFound('Content version not found.');
  const current = snapshotContent(ctx.draftConfig);
  const versionSectionIds = new Set((version.content?.sections || []).map((item) => String(item.id)));
  const versionBlockIds = new Set((version.content?.blocks || []).map((item) => String(item.id)));
  const currentSectionIds = new Set(current.sections.map((item) => String(item.id)));
  const currentBlockIds = new Set(current.blocks.map((item) => String(item.id)));
  const compatibility = {
    removedAreasSkipped: [...versionSectionIds].filter((id) => !currentSectionIds.has(id)).length + [...versionBlockIds].filter((id) => !currentBlockIds.has(id)).length,
    newerAreasPreserved: [...currentSectionIds].filter((id) => !versionSectionIds.has(id)).length + [...currentBlockIds].filter((id) => !versionBlockIds.has(id)).length,
  };
  const content = sanitizeContent(require('../services/storeContentService').reconcileContent(version.content, ctx.draftConfig), ctx.draftConfig); const draftConfig = applyContent(ctx.draftConfig, content); const result = await saveContext(ctx, { draftConfig, updatedBy: req.user._id });
  invalidate(); logAudit({ req, action: 'STORE_CONTENT_VERSION_RESTORE', entityType: ctx.scopeType === 'THEME' ? 'WebsiteTheme' : 'Store', entityId: ctx.scopeId, after: { restoredVersion: version.version } });
  res.json({ success: true, ...result, draft: snapshotContent(draftConfig), restoredVersion: version.version, compatibility, message: compatibility.removedAreasSkipped || compatibility.newerAreasPreserved ? `Version restored to draft. ${compatibility.removedAreasSkipped} removed area(s) were skipped and ${compatibility.newerAreasPreserved} newer area(s) were preserved.` : 'Content version restored to draft. Review and publish it when ready.' });
});

exports.retrySchedule = asyncHandler(async (req, res) => {
  await allowed(req); const ctx = await getContext(req, true); if (!ctx.scheduledFor) throw notFound('No scheduled content release is available to retry.'); requireRevision(req, ctx);
  const result = await saveContext(ctx, { scheduledContentStatus: 'SCHEDULED', scheduledContentAttempts: 0, scheduledContentLeaseUntil: undefined, scheduledContentLastAttemptAt: undefined, scheduledContentError: undefined, updatedBy: req.user._id });
  invalidate(); logAudit({ req, action: 'STORE_CONTENT_SCHEDULE_RETRY', entityType: ctx.scopeType === 'THEME' ? 'WebsiteTheme' : 'Store', entityId: ctx.scopeId });
  res.json({ success: true, ...result, scheduledFor: ctx.scheduledFor, scheduledNote: ctx.scheduledNote, scheduledStatus: 'SCHEDULED', scheduledAttempts: 0, scheduledError: '' });
});

// Older generated clients still use this immediate-publish contract.
exports.update = asyncHandler(async (req, res) => {
  await allowed(req); const theme = await WebsiteTheme.findOne({ isActive: true }); if (!theme?.publishedConfig) throw notFound('Ask the store owner to publish an initial theme');
  if (!req.body?.revision || new Date(req.body.revision).getTime() !== new Date(theme.updatedAt).getTime()) throw new ApiError('DUPLICATE_REQUEST', 'Content changed in another session. Reload before saving.');
  const content = req.body.content;
  if (!content || Object.keys(content).some((key) => !Object.prototype.hasOwnProperty.call(LEGACY_FIELDS, key)) || Object.keys(req.body).some((key) => !['content', 'sections', 'revision'].includes(key))) throw new ApiError('FORBIDDEN', 'Only store content can be edited here');
  for (const value of Object.values(content)) if (typeof value !== 'string' || value.length > 1000) throw new ApiError('VALIDATION_ERROR', 'Keep content fields under 1000 characters');
  if (!content.websiteName?.trim()) throw new ApiError('VALIDATION_ERROR', 'Enter a website name');
  const sections = req.body.sections || [];
  if (!Array.isArray(sections) || sections.length > 14 || sections.some((item) => !item || Object.keys(item).some((key) => !['id', 'label', 'heading', 'description', 'buttonText'].includes(key)))) throw new ApiError('FORBIDDEN', 'Only section wording can be edited here');
  const patchConfig = (source) => { const config = normalizeWebsiteConfig(source);
    for (const [key, [group, field]] of Object.entries(LEGACY_FIELDS)) if (content[key] !== undefined) config[group][field] = content[key].trim();
    for (const item of sections) { const section = config.homepage.sections.find((entry) => entry.id === item.id); if (!section) throw new ApiError('VALIDATION_ERROR', 'Unknown homepage section');
      for (const key of ['heading', 'description', 'buttonText']) { if (typeof item[key] !== 'string' || item[key].length > 1000) throw new ApiError('VALIDATION_ERROR', 'Keep section wording under 1000 characters'); section[key] = item[key].trim(); } }
    return normalizeWebsiteConfig(config); };
  const saved = await WebsiteTheme.findOneAndUpdate({ _id: theme._id, isActive: true, updatedAt: theme.updatedAt }, { $set: { publishedConfig: patchConfig(theme.publishedConfig), draftConfig: patchConfig(theme.draftConfig), updatedBy: req.user._id }, $inc: { __v: 1 } }, { new: true, runValidators: true });
  if (!saved) throw new ApiError('DUPLICATE_REQUEST', 'Content changed while saving. Reload and review.'); invalidate(); logAudit({ req, action: 'STORE_CONTENT_UPDATE', entityType: 'WebsiteTheme', entityId: saved._id }); res.json({ success: true, revision: saved.updatedAt });
});
