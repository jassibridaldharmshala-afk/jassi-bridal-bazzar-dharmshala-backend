const mongoose = require('mongoose');
const crypto = require('crypto');
const WebsiteTheme = require('../models/WebsiteTheme');
const WebsiteThemeVersion = require('../models/WebsiteThemeVersion');
const StoreContentVersion = require('../models/StoreContentVersion');
const StorefrontDesignVersion = require('../models/StorefrontDesignVersion');
const Store = require('../models/Store');
const Product = require('../models/Product');
const Category = require('../models/Category');
const Settings = require('../models/Settings');
const { applyStorePresentation } = require('../services/storeSettingsValidation');
const { asyncHandler } = require('../middleware/validate');
const { ApiError, notFound } = require('../utils/apiError');
const { logAudit } = require('../services/auditService');
const { hasStoreFeature, planSummary } = require('../config/storePlans');
const { applyContent, publishDueMasterContent, publishDueSellerContent, snapshotContent } = require('../services/storeContentService');
const {
  DEFAULT_WEBSITE_CONFIG,
  buildPresetConfig,
  getPresetList,
  normalizeWebsiteConfig,
} = require('../config/websiteCustomization');

const PUBLIC_CACHE_MS = Math.max(1000, Math.min(60000, Number(process.env.WEBSITE_CONFIG_CACHE_MS) || 15000));
const activeCache = new Map();
let nextMasterScheduleCheck = 0;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sendPublicConfig(req, res, payload) {
  const etag = `W/\"${crypto.createHash('sha1').update(JSON.stringify(payload)).digest('base64url')}\"`;
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  res.setHeader('ETag', etag);
  res.vary('X-Store-Slug');
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  return res.json(payload);
}

function cleanName(value, fallback = 'Untitled Theme') {
  const name = String(value || '').trim().replace(/\s+/g, ' ');
  if (!name) return fallback;
  return name.slice(0, 80);
}

function managedDesignFields(settings = {}) {
  const fields = [];
  if (settings?.brandIdentityEnabled) fields.push('store name', 'tagline', 'logo', 'favicon');
  if (settings?.contactDetailsEnabled) fields.push('footer contact details');
  if (settings?.announcementEnabled !== undefined) fields.push('announcement visibility and text');
  return fields;
}

function designSeoPreview(settings = {}) {
  return {
    title: String(settings?.seoTitle || settings?.storeName || '').slice(0, 70),
    description: String(settings?.seoDescription || '').slice(0, 180),
    image: String(settings?.socialShareImage || '').slice(0, 2000),
    indexing: settings?.searchIndexingEnabled !== false,
  };
}

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'theme';
}

async function uniqueSlug(value, excludeId) {
  const base = slugify(value);
  let slug = base;
  let suffix = 2;
  while (await WebsiteTheme.exists({ slug, ...(excludeId ? { _id: { $ne: excludeId } } : {}) })) {
    slug = `${base}-${suffix}`;
    suffix += 1;
  }
  return slug;
}

function requireThemeId(value) {
  if (!mongoose.isValidObjectId(value)) throw new ApiError('VALIDATION_ERROR', 'Valid theme id is required');
  return value;
}

function requireFutureSchedule(value) {
  const date = new Date(value);
  const earliest = Date.now() + 60 * 1000;
  const latest = Date.now() + 366 * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(date.getTime()) || date.getTime() < earliest || date.getTime() > latest) {
    throw new ApiError('VALIDATION_ERROR', 'Choose a publish time from 1 minute to 1 year in the future');
  }
  return date;
}

function requireCurrentRevision(req, theme) {
  if (req.body?.expectedUpdatedAt === undefined) return; // Compatibility with older admin clients.
  const expected = new Date(req.body.expectedUpdatedAt).getTime();
  if (!Number.isFinite(expected) || expected !== new Date(theme.updatedAt).getTime()) {
    throw new ApiError('DUPLICATE_REQUEST', 'This theme was changed in another session. Export your draft, then reload the theme before saving or publishing.');
  }
}

async function saveTheme(theme) {
  try { return await theme.save(); }
  catch (error) {
    if (error.name === 'VersionError') throw new ApiError('DUPLICATE_REQUEST', 'This theme changed while saving. Export your draft and reload before retrying.');
    throw error;
  }
}

async function ensureDefaultTheme(userId) {
  const existing = await WebsiteTheme.findOne().sort({ isActive: -1, createdAt: 1 });
  if (existing) return existing;
  const settings = await Settings.findOne().lean();
  const initialConfig = buildInitialConfig(settings);
  return WebsiteTheme.create({
    name: 'Default Theme',
    slug: 'default-theme',
    preset: 'default',
    draftConfig: initialConfig,
    publishedConfig: initialConfig,
    isActive: true,
    createdBy: userId,
    updatedBy: userId,
    publishedBy: userId,
    publishedAt: new Date(),
  });
}

function buildInitialConfig(settings) {
  if (!settings) return clone(DEFAULT_WEBSITE_CONFIG);
  return normalizeWebsiteConfig({
    branding: { websiteName: settings.storeName || DEFAULT_WEBSITE_CONFIG.branding.websiteName },
    footer: {
      description: settings.footerText || DEFAULT_WEBSITE_CONFIG.footer.description,
      contactEmail: settings.contactEmail || '',
      contactPhone: settings.contactPhone || '',
      contactAddress: settings.address || '',
      socialLinks: settings.socialLinks || {},
    },
  });
}

function themeSummary(theme) {
  return {
    _id: theme._id,
    name: theme.name,
    slug: theme.slug,
    preset: theme.preset,
    isActive: theme.isActive,
    hasPublishedVersion: Boolean(theme.publishedConfig),
    publishedAt: theme.publishedAt,
    createdAt: theme.createdAt,
    updatedAt: theme.updatedAt,
  };
}

function publicPayload(theme) {
  if (!theme?.publishedConfig) {
    return { config: clone(DEFAULT_WEBSITE_CONFIG), theme: null };
  }
  return {
    config: normalizeWebsiteConfig(theme.publishedConfig),
    theme: {
      id: theme._id,
      name: theme.name,
      slug: theme.slug,
      preset: theme.preset,
      publishedAt: theme.publishedAt,
    },
  };
}

const CLIENT_DESIGN_GROUPS = ['branding', 'colors', 'header', 'homepage', 'typography', 'buttons', 'productCards', 'footer', 'layout', 'mobile', 'tablet', 'theme'];

function requireClientDesign(store) {
  if (hasStoreFeature(store, 'advancedCustomization')) return;
  const plan = planSummary(store);
  throw new ApiError('FORBIDDEN', `Store design is unavailable on the ${plan.name} plan while its licence is ${plan.status.toLowerCase()}.`);
}

function designOnly(config) {
  const normalized = normalizeWebsiteConfig(config);
  return Object.fromEntries(CLIENT_DESIGN_GROUPS.map((key) => [key, clone(normalized[key])]));
}

function mergeClientDesign(base, design) {
  if (!design) return normalizeWebsiteConfig(base);
  const overlay = designOnly(design);
  if (!design.branding) overlay.branding = clone(base.branding);
  return normalizeWebsiteConfig({ ...base, ...overlay });
}

async function globalPublishedConfig() {
  const active = await WebsiteTheme.findOne({ isActive: true, publishedConfig: { $exists: true, $ne: null } }).sort('-publishedAt').lean();
  return active ? publicPayload(active).config : clone(DEFAULT_WEBSITE_CONFIG);
}

function invalidateActiveCache() {
  activeCache.clear();
}

function sellerDesignRevision(store) {
  return Math.max(0, Number(store?.storefrontDesign?.revision || 0));
}

function requireSellerDesignRevision(req, store) {
  const current = sellerDesignRevision(store);
  if (req.body?.expectedRevision === undefined) {
    if (current === 0) return current;
    throw new ApiError('DUPLICATE_REQUEST', 'This design was changed in another session. Reload the Store Designer before saving or publishing.');
  }
  const expected = Number(req.body.expectedRevision);
  if (!Number.isInteger(expected) || expected !== current) {
    throw new ApiError('DUPLICATE_REQUEST', 'This design was changed in another session. Export your draft, then reload before retrying.');
  }
  return current;
}

async function updateStorefrontDesign(store, currentRevision, nextDesign) {
  const query = { _id: store._id, __v: store.__v };
  const result = await Store.updateOne(query, {
    $set: { storefrontDesign: { ...nextDesign, revision: currentRevision + 1 } },
    $inc: { __v: 1 },
  }, { runValidators: true });
  if (!result.modifiedCount) {
    throw new ApiError('DUPLICATE_REQUEST', 'This store or design changed in another session. Reload before retrying.');
  }
  return Store.findById(store._id);
}

async function reserveSellerDesignVersion(storeId, config, note, publishedBy) {
  const latest = await StorefrontDesignVersion.findOne({ storeId }).sort('-version').select('version').lean();
  try {
    return await StorefrontDesignVersion.create({
      storeId, version: Number(latest?.version || 0) + 1, config,
      note: String(note || 'Published from Store Designer').slice(0, 240), publishedBy,
    });
  } catch (error) {
    if (error?.code === 11000) throw new ApiError('DUPLICATE_REQUEST', 'Another publish completed first. Reload the designer before retrying.');
    throw error;
  }
}

async function publishDueSellerDesign(store) {
  const scheduled = store?.storefrontDesign;
  if (!scheduled?.scheduledFor || !scheduled?.scheduledConfig || new Date(scheduled.scheduledFor).getTime() > Date.now()) return store;
  const config = scheduled.publishedConfig
    ? applyContent(designOnly(scheduled.scheduledConfig), snapshotContent(scheduled.publishedConfig))
    : designOnly(scheduled.scheduledConfig);
  const preflight = await designPreflight(config, { storeId: store._id });
  if (!preflight.ready) return store;
  const history = await reserveSellerDesignVersion(store._id, config, scheduled.scheduledNote || 'Scheduled storefront publish', scheduled.scheduledBy);
  const now = new Date();
  const nextDesign = { ...(scheduled.toObject?.() || scheduled), publishedConfig: clone(config), publishedAt: now, updatedAt: now };
  delete nextDesign.scheduledConfig; delete nextDesign.scheduledFor; delete nextDesign.scheduledNote; delete nextDesign.scheduledBy;
  try {
    const updated = await updateStorefrontDesign(store, sellerDesignRevision(store), nextDesign);
    invalidateActiveCache();
    return updated;
  } catch (error) {
    await StorefrontDesignVersion.deleteOne({ _id: history._id }).catch(() => null);
    throw error;
  }
}

async function publishDueMasterTheme() {
  const theme = await WebsiteTheme.findOne({ scheduledFor: { $lte: new Date() }, scheduledConfig: { $exists: true, $ne: null } }).sort('scheduledFor');
  if (!theme) return;
  const currentActive = await WebsiteTheme.findOne({ isActive: true }).lean();
  const config = currentActive?.publishedConfig
    ? applyContent(normalizeWebsiteConfig(theme.scheduledConfig), snapshotContent(currentActive.publishedConfig))
    : normalizeWebsiteConfig(theme.scheduledConfig);
  const preflight = await designPreflight(config, {});
  if (!preflight.ready) return;
  const latest = await WebsiteThemeVersion.findOne({ theme: theme._id }).sort('-version').lean();
  let history;
  try {
    history = await WebsiteThemeVersion.create({ theme: theme._id, version: Number(latest?.version || 0) + 1, config,
      note: String(theme.scheduledNote || 'Scheduled website publish').slice(0, 240), publishedBy: theme.scheduledBy });
  } catch (error) {
    if (error?.code === 11000) return;
    throw error;
  }
  const previousActive = await WebsiteTheme.findOne({ isActive: true, _id: { $ne: theme._id } }).lean();
  try {
    await WebsiteTheme.updateMany({ isActive: true, _id: { $ne: theme._id } }, { $set: { isActive: false } });
    theme.publishedConfig = config; theme.isActive = true; theme.publishedAt = new Date(); theme.publishedBy = theme.scheduledBy;
    theme.scheduledConfig = undefined; theme.scheduledFor = undefined; theme.scheduledNote = undefined; theme.scheduledBy = undefined;
    theme.markModified('publishedConfig');
    await saveTheme(theme);
    invalidateActiveCache();
  } catch (error) {
    await WebsiteThemeVersion.deleteOne({ _id: history._id }).catch(() => null);
    if (previousActive?._id) await WebsiteTheme.updateOne({ _id: previousActive._id }, { $set: { isActive: true } }).catch(() => null);
    throw error;
  }
}

function collectDesignReferences(config) {
  const productIds = new Set();
  const categoryIds = new Set(config.homepage?.featuredCategoryIds || []);
  Object.values(config.homepage?.sectionProductIds || {}).flat().forEach((id) => productIds.add(String(id)));
  (config.homepage?.blocks || []).forEach((block) => {
    (block.productIds || []).forEach((id) => productIds.add(String(id)));
    (block.categoryIds || []).forEach((id) => categoryIds.add(String(id)));
  });
  return { productIds: [...productIds].filter(mongoose.isValidObjectId), categoryIds: [...categoryIds].filter(mongoose.isValidObjectId) };
}

async function designPreflight(configInput, tenantFilter = {}) {
  const config = normalizeWebsiteConfig(configInput);
  const { productIds, categoryIds } = collectDesignReferences(config);
  const validProductIds = productIds.filter((id) => mongoose.isValidObjectId(id));
  const validCategoryIds = categoryIds.filter((id) => mongoose.isValidObjectId(id));
  const [products, categories] = await Promise.all([
    validProductIds.length ? Product.find({ ...tenantFilter, _id: { $in: validProductIds }, isArchived: { $ne: true } }).select('_id').lean() : [],
    validCategoryIds.length ? Category.find({ ...tenantFilter, _id: { $in: validCategoryIds }, isArchived: { $ne: true } }).select('_id').lean() : [],
  ]);
  const foundProducts = new Set(products.map((item) => String(item._id)));
  const foundCategories = new Set(categories.map((item) => String(item._id)));
  const missingProducts = productIds.filter((id) => !foundProducts.has(String(id)));
  const missingCategories = categoryIds.filter((id) => !foundCategories.has(String(id)));
  const visibleBlocks = (config.homepage?.blocks || []).filter((block) => block.visible !== false);
  const warnings = [];
  if (missingProducts.length) warnings.push(`${missingProducts.length} selected product${missingProducts.length === 1 ? '' : 's'} are unavailable and will fall back to live catalog content.`);
  if (missingCategories.length) warnings.push(`${missingCategories.length} selected categor${missingCategories.length === 1 ? 'y is' : 'ies are'} unavailable and will be skipped.`);
  const missingAlt = visibleBlocks.filter((block) => (block.image || block.mobileImage) && !block.altText).length;
  if (missingAlt) warnings.push(`${missingAlt} visible media block${missingAlt === 1 ? ' needs' : 's need'} image alt text.`);
  const fixedMediaMissingAlt = (config.homepage?.sections || []).filter((section) => section.visible !== false && (section.image || section.mobileImage) && !section.imageAlt).length;
  if (fixedMediaMissingAlt) warnings.push(`${fixedMediaMissingAlt} homepage section${fixedMediaMissingAlt === 1 ? ' needs' : 's need'} image alt text.`);
  const emptyBlocks = visibleBlocks.filter((block) => !block.title && !block.body && !block.image && !block.videoUrl && !(block.productIds || []).length && !(block.categoryIds || []).length && !(block.items || []).length).length;
  if (emptyBlocks) warnings.push(`${emptyBlocks} visible block${emptyBlocks === 1 ? ' is' : 's are'} empty.`);
  const incompleteBlocks = visibleBlocks.filter((block) => (block.type === 'video' && !block.videoUrl)
    || (block.type === 'coupon' && !block.couponCode)
    || (block.type === 'countdown' && (!block.endsAt || new Date(block.endsAt).getTime() <= Date.now()))).length;
  if (incompleteBlocks) warnings.push(`${incompleteBlocks} campaign block${incompleteBlocks === 1 ? ' is' : 's are'} missing required details.`);
  return {
    ready: !missingProducts.length && !missingCategories.length && !missingAlt && !fixedMediaMissingAlt && !emptyBlocks && !incompleteBlocks,
    blocking: [], warnings,
    summary: { productsChecked: productIds.length, categoriesChecked: categoryIds.length, blocksChecked: visibleBlocks.length },
  };
}

exports.getActiveConfig = asyncHandler(async (req, res) => {
  const checkMasterSchedule = Date.now() >= nextMasterScheduleCheck;
  if (checkMasterSchedule) nextMasterScheduleCheck = Date.now() + 5000;
  try {
    // A content schedule is a patch. Applying it after a full design schedule
    // prevents an older design snapshot from restoring old storefront copy.
    if (checkMasterSchedule) {
      await publishDueMasterTheme();
      if (await publishDueMasterContent()) invalidateActiveCache();
    }
    if (req.store) {
      req.store = await publishDueSellerDesign(req.store) || req.store;
      const beforeContentSchedule = req.store;
      req.store = await publishDueSellerContent(req.store) || req.store;
      if (req.store !== beforeContentSchedule) invalidateActiveCache();
    }
  } catch (_error) { invalidateActiveCache(); }
  const cacheKey = String(req.store?._id || 'default');
  const cached = activeCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return sendPublicConfig(req, res, cached.payload);
  }
  const active = await WebsiteTheme.findOne({ isActive: true, publishedConfig: { $exists: true, $ne: null } }).sort('-publishedAt').lean();
  const settings = await Settings.findOne(req.tenantFilter || {}).lean() || {};
  const payload = active ? publicPayload(active) : { config: buildInitialConfig(settings), theme: null };
  if (req.store?.storefrontDesign?.publishedConfig) {
    payload.config = mergeClientDesign(payload.config, req.store.storefrontDesign.publishedConfig);
    payload.theme = { ...(payload.theme || {}), storePreset: req.store.storefrontDesign.preset || 'custom', storePublishedAt: req.store.storefrontDesign.publishedAt };
  }
  payload.config = applyStorePresentation(payload.config, settings);
  payload.metadata = {
    title: settings.seoTitle || '',
    description: settings.seoDescription || '',
    image: settings.socialShareImage || payload.config?.branding?.logo || '',
    indexing: settings.searchIndexingEnabled !== false,
  };
  payload.brandIdentityManaged = Boolean(settings.brandIdentityEnabled);
  activeCache.set(cacheKey, { payload, expiresAt: Date.now() + PUBLIC_CACHE_MS });
  return sendPublicConfig(req, res, payload);
});

exports.getWorkspace = asyncHandler(async (req, res) => {
  // The default theme must exist before listing themes. Running these reads in
  // parallel made a fresh installation intermittently return an empty list.
  const selected = await ensureDefaultTheme(req.user._id);
  const [themes, settings] = await Promise.all([
    WebsiteTheme.find().sort({ isActive: -1, updatedAt: -1 }), Settings.findOne(req.tenantFilter || {}).lean(),
  ]);
  res.json({
    themes: themes.map(themeSummary),
    selectedTheme: selected,
    configurationLocked: (await require('../services/masterConfigurationService').readConfiguration()).locked,
    presets: getPresetList({ appearanceOnly: true }),
    managedFields: managedDesignFields(settings),
    seoPreview: designSeoPreview(settings),
  });
});

exports.listThemes = asyncHandler(async (req, res) => {
  await ensureDefaultTheme(req.user._id);
  res.json((await WebsiteTheme.find().sort({ isActive: -1, updatedAt: -1 })).map(themeSummary));
});

exports.getTheme = asyncHandler(async (req, res) => {
  const theme = await WebsiteTheme.findById(requireThemeId(req.params.id));
  if (!theme) throw notFound('Theme not found');
  res.json(theme);
});

exports.getPresets = asyncHandler(async (req, res) => {
  res.json(getPresetList());
});

exports.getSellerDesign = asyncHandler(async (req, res) => {
  requireClientDesign(req.store);
  const [base, settings] = await Promise.all([globalPublishedConfig(), Settings.findOne({ storeId: req.store._id }).lean()]);
  const saved = req.store.storefrontDesign || {};
  res.set('Cache-Control', 'private, no-store, max-age=0');
  res.json({
    store: { id: String(req.store._id), name: req.store.name, slug: req.store.slug },
    platform: planSummary(req.store),
    draftConfig: mergeClientDesign(base, saved.draftConfig || saved.publishedConfig),
    publishedConfig: saved.publishedConfig ? mergeClientDesign(base, saved.publishedConfig) : base,
    preset: saved.preset || 'default',
    updatedAt: saved.updatedAt || null,
    publishedAt: saved.publishedAt || null,
    scheduledFor: saved.scheduledFor || null,
    scheduledNote: saved.scheduledNote || '',
    revision: sellerDesignRevision(req.store),
    presets: getPresetList({ appearanceOnly: true }),
    managedFields: managedDesignFields(settings),
    seoPreview: designSeoPreview(settings),
  });
});

exports.updateSellerDesign = asyncHandler(async (req, res) => {
  requireClientDesign(req.store);
  const revision = requireSellerDesignRevision(req, req.store);
  const incoming = req.body?.config;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) throw new ApiError('VALIDATION_ERROR', 'A website design is required');
  const design = designOnly(incoming);
  const nextDesign = {
    ...(req.store.storefrontDesign?.toObject?.() || req.store.storefrontDesign || {}),
    preset: String(design.theme?.preset || req.body?.preset || 'custom').slice(0, 40),
    draftConfig: design,
    updatedAt: new Date(),
    updatedBy: req.user._id,
  };
  const updatedStore = await updateStorefrontDesign(req.store, revision, nextDesign);
  invalidateActiveCache();
  logAudit({ req, action: 'STOREFRONT_DESIGN_DRAFT_SAVE', entityType: 'Store', entityId: req.store._id, after: { preset: nextDesign.preset } });
  res.json({ draftConfig: mergeClientDesign(await globalPublishedConfig(), design), updatedAt: updatedStore.storefrontDesign.updatedAt, revision: sellerDesignRevision(updatedStore) });
});

exports.publishSellerDesign = asyncHandler(async (req, res) => {
  requireClientDesign(req.store);
  const revision = requireSellerDesignRevision(req, req.store);
  if (!req.store.storefrontDesign?.draftConfig) throw new ApiError('VALIDATION_ERROR', 'Save the website design before publishing');
  const config = req.store.storefrontDesign.publishedConfig
    ? applyContent(designOnly(req.store.storefrontDesign.draftConfig), snapshotContent(req.store.storefrontDesign.publishedConfig))
    : designOnly(req.store.storefrontDesign.draftConfig);
  const preflight = await designPreflight(config, { storeId: req.store._id });
  if (!preflight.ready) throw new ApiError('VALIDATION_ERROR', preflight.blocking[0] || preflight.warnings[0] || 'Complete the storefront review before publishing');
  const history = await reserveSellerDesignVersion(req.store._id, config, req.body?.note, req.user._id);
  const version = history.version;
  const now = new Date();
  const nextDesign = {
    ...(req.store.storefrontDesign?.toObject?.() || req.store.storefrontDesign || {}),
    publishedConfig: clone(config), draftConfig: clone(config), publishedAt: now, updatedAt: now, updatedBy: req.user._id,
  };
  delete nextDesign.scheduledConfig; delete nextDesign.scheduledFor; delete nextDesign.scheduledNote; delete nextDesign.scheduledBy;
  let updatedStore;
  try { updatedStore = await updateStorefrontDesign(req.store, revision, nextDesign); }
  catch (error) { await StorefrontDesignVersion.deleteOne({ _id: history._id }).catch(() => null); throw error; }
  invalidateActiveCache();
  logAudit({ req, action: 'STOREFRONT_DESIGN_PUBLISH', entityType: 'Store', entityId: req.store._id, after: { preset: nextDesign.preset, publishedAt: now, version } });
  res.json({ success: true, publishedAt: now, revision: sellerDesignRevision(updatedStore), version: { _id: history._id, version: history.version, note: history.note, createdAt: history.createdAt }, preflight, config: mergeClientDesign(await globalPublishedConfig(), config) });
});

exports.preflightSellerDesign = asyncHandler(async (req, res) => {
  requireClientDesign(req.store);
  const incoming = req.body?.config || req.store.storefrontDesign?.draftConfig;
  if (!incoming) throw new ApiError('VALIDATION_ERROR', 'Save or provide a design before checking it');
  res.json(await designPreflight(designOnly(incoming), { storeId: req.store._id }));
});

exports.getSellerDesignHistory = asyncHandler(async (req, res) => {
  requireClientDesign(req.store);
  res.set('Cache-Control', 'private, no-store, max-age=0');
  res.json(await StorefrontDesignVersion.find({ storeId: req.store._id }).select('-config').populate('publishedBy', 'name email phone').sort('-version').limit(100).lean());
});

exports.discardSellerDesign = asyncHandler(async (req, res) => {
  requireClientDesign(req.store);
  const revision = requireSellerDesignRevision(req, req.store);
  const base = await globalPublishedConfig();
  const draftConfig = req.store.storefrontDesign?.publishedConfig ? clone(req.store.storefrontDesign.publishedConfig) : designOnly(base);
  const now = new Date();
  const nextDesign = { ...(req.store.storefrontDesign?.toObject?.() || req.store.storefrontDesign || {}), draftConfig, updatedAt: now, updatedBy: req.user._id };
  const updatedStore = await updateStorefrontDesign(req.store, revision, nextDesign);
  invalidateActiveCache();
  logAudit({ req, action: 'STOREFRONT_DESIGN_DRAFT_DISCARD', entityType: 'Store', entityId: req.store._id });
  res.json({ draftConfig: mergeClientDesign(base, draftConfig), updatedAt: updatedStore.storefrontDesign.updatedAt, revision: sellerDesignRevision(updatedStore) });
});

exports.restoreSellerDesignVersion = asyncHandler(async (req, res) => {
  requireClientDesign(req.store);
  const revision = requireSellerDesignRevision(req, req.store);
  const versionId = requireThemeId(req.params.versionId);
  const version = await StorefrontDesignVersion.findOne({ _id: versionId, storeId: req.store._id });
  if (!version) throw notFound('Store design version not found');
  const now = new Date();
  const nextDesign = { ...(req.store.storefrontDesign?.toObject?.() || req.store.storefrontDesign || {}), draftConfig: designOnly(version.config), updatedAt: now, updatedBy: req.user._id };
  const updatedStore = await updateStorefrontDesign(req.store, revision, nextDesign);
  invalidateActiveCache();
  logAudit({ req, action: 'STOREFRONT_DESIGN_VERSION_RESTORE', entityType: 'Store', entityId: req.store._id, after: { restoredVersion: version.version } });
  res.json({ draftConfig: mergeClientDesign(await globalPublishedConfig(), nextDesign.draftConfig), updatedAt: updatedStore.storefrontDesign.updatedAt, revision: sellerDesignRevision(updatedStore), restoredVersion: version.version, message: 'Version restored to draft. Review and publish when ready.' });
});

exports.scheduleSellerDesign = asyncHandler(async (req, res) => {
  requireClientDesign(req.store);
  const revision = requireSellerDesignRevision(req, req.store);
  const scheduledFor = requireFutureSchedule(req.body?.scheduledFor);
  if (!req.store.storefrontDesign?.draftConfig) throw new ApiError('VALIDATION_ERROR', 'Save the website design before scheduling it');
  const config = designOnly(req.store.storefrontDesign.draftConfig);
  if ((config.homepage?.blocks || []).some((block) => block.visible !== false && block.type === 'countdown' && new Date(block.endsAt).getTime() <= scheduledFor.getTime())) {
    throw new ApiError('VALIDATION_ERROR', 'Countdown blocks must end after the scheduled publish time');
  }
  const preflight = await designPreflight(config, { storeId: req.store._id });
  if (!preflight.ready) throw new ApiError('VALIDATION_ERROR', preflight.warnings[0] || 'Complete the storefront review before scheduling');
  const nextDesign = { ...(req.store.storefrontDesign?.toObject?.() || req.store.storefrontDesign || {}),
    scheduledConfig: clone(config), scheduledFor, scheduledNote: String(req.body?.note || 'Scheduled storefront publish').slice(0, 240), scheduledBy: req.user._id,
    updatedAt: new Date(), updatedBy: req.user._id };
  const updatedStore = await updateStorefrontDesign(req.store, revision, nextDesign);
  invalidateActiveCache();
  logAudit({ req, action: 'STOREFRONT_DESIGN_SCHEDULE', entityType: 'Store', entityId: req.store._id, after: { scheduledFor } });
  res.json({ scheduledFor, scheduledNote: nextDesign.scheduledNote, revision: sellerDesignRevision(updatedStore), updatedAt: updatedStore.storefrontDesign.updatedAt, preflight });
});

exports.cancelSellerDesignSchedule = asyncHandler(async (req, res) => {
  requireClientDesign(req.store);
  const revision = requireSellerDesignRevision(req, req.store);
  const nextDesign = { ...(req.store.storefrontDesign?.toObject?.() || req.store.storefrontDesign || {}), updatedAt: new Date(), updatedBy: req.user._id };
  delete nextDesign.scheduledConfig; delete nextDesign.scheduledFor; delete nextDesign.scheduledNote; delete nextDesign.scheduledBy;
  const updatedStore = await updateStorefrontDesign(req.store, revision, nextDesign);
  invalidateActiveCache();
  logAudit({ req, action: 'STOREFRONT_DESIGN_SCHEDULE_CANCEL', entityType: 'Store', entityId: req.store._id });
  res.json({ success: true, revision: sellerDesignRevision(updatedStore), updatedAt: updatedStore.storefrontDesign.updatedAt });
});

exports.createTheme = asyncHandler(async (req, res) => {
  const name = cleanName(req.body?.name);
  const preset = String(req.body?.preset || 'default');
  if (!getPresetList().some((item) => item.id === preset)) throw new ApiError('VALIDATION_ERROR', 'Unknown theme preset');
  const config = req.body?.config ? normalizeWebsiteConfig(req.body.config) : buildPresetConfig(preset);
  const theme = await WebsiteTheme.create({
    name,
    slug: await uniqueSlug(name),
    preset,
    draftConfig: config,
    isActive: false,
    createdBy: req.user._id,
    updatedBy: req.user._id,
  });
  logAudit({ req, action: 'WEBSITE_THEME_CREATE', entityType: 'WebsiteTheme', entityId: theme._id, after: themeSummary(theme) });
  res.status(201).json(theme);
});

exports.duplicateTheme = asyncHandler(async (req, res) => {
  const source = await WebsiteTheme.findById(requireThemeId(req.params.id));
  if (!source) throw notFound('Theme not found');
  const name = cleanName(req.body?.name, `${source.name} Copy`);
  const theme = await WebsiteTheme.create({
    name,
    slug: await uniqueSlug(name),
    preset: source.preset,
    draftConfig: normalizeWebsiteConfig(source.draftConfig || source.publishedConfig),
    isActive: false,
    createdBy: req.user._id,
    updatedBy: req.user._id,
  });
  logAudit({ req, action: 'WEBSITE_THEME_DUPLICATE', entityType: 'WebsiteTheme', entityId: theme._id, before: { sourceThemeId: source._id }, after: themeSummary(theme) });
  res.status(201).json(theme);
});

exports.updateDraft = asyncHandler(async (req, res) => {
  const theme = await WebsiteTheme.findById(requireThemeId(req.params.id));
  if (!theme) throw notFound('Theme not found');
  requireCurrentRevision(req, theme);
  const incoming = req.body?.config ?? req.body?.draftConfig;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    throw new ApiError('VALIDATION_ERROR', 'A theme configuration is required. The existing draft has not changed.');
  }
  const before = clone(theme.draftConfig || {});
  if (req.body?.name !== undefined) {
    theme.name = cleanName(req.body.name, theme.name);
    theme.slug = await uniqueSlug(theme.name, theme._id);
  }
  theme.draftConfig = normalizeWebsiteConfig(incoming);
  theme.preset = theme.draftConfig.theme.preset;
  theme.updatedBy = req.user._id;
  theme.markModified('draftConfig');
  await saveTheme(theme);
  logAudit({ req, action: 'WEBSITE_THEME_DRAFT_SAVE', entityType: 'WebsiteTheme', entityId: theme._id, before, after: theme.draftConfig });
  res.json(theme);
});

exports.preflightTheme = asyncHandler(async (req, res) => {
  const theme = await WebsiteTheme.findById(requireThemeId(req.params.id));
  if (!theme) throw notFound('Theme not found');
  requireCurrentRevision(req, theme);
  res.json(await designPreflight(req.body?.config || theme.draftConfig, req.tenantFilter || {}));
});

exports.scheduleTheme = asyncHandler(async (req, res) => {
  const theme = await WebsiteTheme.findById(requireThemeId(req.params.id));
  if (!theme) throw notFound('Theme not found');
  requireCurrentRevision(req, theme);
  const scheduledFor = requireFutureSchedule(req.body?.scheduledFor);
  const currentActive = await WebsiteTheme.findOne({ isActive: true }).lean();
  const config = currentActive?.publishedConfig && String(currentActive._id) !== String(theme._id)
    ? applyContent(normalizeWebsiteConfig(theme.draftConfig), snapshotContent(currentActive.publishedConfig))
    : normalizeWebsiteConfig(theme.draftConfig);
  if ((config.homepage?.blocks || []).some((block) => block.visible !== false && block.type === 'countdown' && new Date(block.endsAt).getTime() <= scheduledFor.getTime())) {
    throw new ApiError('VALIDATION_ERROR', 'Countdown blocks must end after the scheduled publish time');
  }
  const preflight = await designPreflight(config, req.tenantFilter || {});
  if (!preflight.ready) throw new ApiError('VALIDATION_ERROR', preflight.warnings[0] || 'Complete the storefront review before scheduling');
  theme.scheduledConfig = clone(config); theme.scheduledFor = scheduledFor;
  theme.scheduledNote = String(req.body?.note || 'Scheduled website publish').slice(0, 240); theme.scheduledBy = req.user._id;
  theme.markModified('scheduledConfig');
  await saveTheme(theme); invalidateActiveCache();
  logAudit({ req, action: 'WEBSITE_THEME_SCHEDULE', entityType: 'WebsiteTheme', entityId: theme._id, after: { scheduledFor } });
  res.json({ theme, preflight });
});

exports.cancelThemeSchedule = asyncHandler(async (req, res) => {
  const theme = await WebsiteTheme.findById(requireThemeId(req.params.id));
  if (!theme) throw notFound('Theme not found');
  requireCurrentRevision(req, theme);
  theme.scheduledConfig = undefined; theme.scheduledFor = undefined; theme.scheduledNote = undefined; theme.scheduledBy = undefined;
  await saveTheme(theme); invalidateActiveCache();
  logAudit({ req, action: 'WEBSITE_THEME_SCHEDULE_CANCEL', entityType: 'WebsiteTheme', entityId: theme._id });
  res.json(theme);
});

exports.discardDraft = asyncHandler(async (req, res) => {
  const theme = await WebsiteTheme.findById(requireThemeId(req.params.id));
  if (!theme) throw notFound('Theme not found');
  requireCurrentRevision(req, theme);
  theme.draftConfig = normalizeWebsiteConfig(theme.publishedConfig || buildPresetConfig(theme.preset));
  theme.updatedBy = req.user._id;
  theme.markModified('draftConfig');
  await saveTheme(theme);
  logAudit({ req, action: 'WEBSITE_THEME_DRAFT_DISCARD', entityType: 'WebsiteTheme', entityId: theme._id });
  res.json(theme);
});

exports.publishTheme = asyncHandler(async (req, res) => {
  const theme = await WebsiteTheme.findById(requireThemeId(req.params.id));
  if (!theme) throw notFound('Theme not found');
  requireCurrentRevision(req, theme);
  const config = normalizeWebsiteConfig(theme.draftConfig);
  const preflight = await designPreflight(config, req.tenantFilter || {});
  if (!preflight.ready) throw new ApiError('VALIDATION_ERROR', preflight.blocking[0] || preflight.warnings[0] || 'Complete the storefront review before publishing');
  const latest = await WebsiteThemeVersion.findOne({ theme: theme._id }).sort('-version').lean();
  const version = Number(latest?.version || 0) + 1;
  // Reserve the history version before altering the live store. A failed
  // history insert (including a simultaneous publish) must not deactivate it.
  const previousActive = await WebsiteTheme.findOne({ isActive: true }).lean();
  const history = await WebsiteThemeVersion.create({
    theme: theme._id,
    version,
    config,
    note: String(req.body?.note || `Published ${theme.name}`).slice(0, 240),
    publishedBy: req.user._id,
  });
  try {
    await WebsiteTheme.updateMany({ _id: { $ne: theme._id }, isActive: true }, { $set: { isActive: false } });
    theme.publishedConfig = config;
    theme.draftConfig = config;
    theme.isActive = true;
    theme.publishedAt = new Date();
    theme.publishedBy = req.user._id;
    theme.updatedBy = req.user._id;
    theme.scheduledConfig = undefined; theme.scheduledFor = undefined; theme.scheduledNote = undefined; theme.scheduledBy = undefined;
    theme.markModified('publishedConfig');
    theme.markModified('draftConfig');
    await saveTheme(theme);
  } catch (error) {
    await WebsiteThemeVersion.deleteOne({ _id: history._id }).catch(() => null);
    // Standalone MongoDB has no multi-document transactions. Restore the
    // previous selection only if another successful publish has not won.
    if (previousActive && !await WebsiteTheme.exists({ isActive: true })) {
      await WebsiteTheme.updateOne({ _id: previousActive._id }, { $set: { isActive: true } }).catch(() => null);
    }
    invalidateActiveCache();
    throw error;
  }
  invalidateActiveCache();
  logAudit({ req, action: 'WEBSITE_THEME_PUBLISH', entityType: 'WebsiteTheme', entityId: theme._id, after: { version, name: theme.name } });
  res.json({ theme, version: history, preflight });
});

exports.activateTheme = asyncHandler(async (req, res) => {
  const theme = await WebsiteTheme.findById(requireThemeId(req.params.id));
  if (!theme) throw notFound('Theme not found');
  requireCurrentRevision(req, theme);
  if (!theme.publishedConfig) throw new ApiError('VALIDATION_ERROR', 'Publish this theme before activating it');
  const previousActive = await WebsiteTheme.findOne({ isActive: true }).lean();
  try {
    if (previousActive?.publishedConfig && String(previousActive._id) !== String(theme._id)) {
      const currentContent = snapshotContent(previousActive.publishedConfig);
      theme.publishedConfig = applyContent(theme.publishedConfig, currentContent);
      theme.draftConfig = applyContent(theme.draftConfig || theme.publishedConfig, currentContent);
      theme.markModified('publishedConfig'); theme.markModified('draftConfig');
    }
    await WebsiteTheme.updateMany({ _id: { $ne: theme._id }, isActive: true }, { $set: { isActive: false } });
    theme.isActive = true;
    theme.updatedBy = req.user._id;
    await saveTheme(theme);
  } catch (error) {
    if (previousActive && !await WebsiteTheme.exists({ isActive: true })) {
      await WebsiteTheme.updateOne({ _id: previousActive._id }, { $set: { isActive: true } }).catch(() => null);
    }
    invalidateActiveCache();
    throw error;
  }
  invalidateActiveCache();
  logAudit({ req, action: 'WEBSITE_THEME_ACTIVATE', entityType: 'WebsiteTheme', entityId: theme._id });
  res.json(theme);
});

exports.deleteTheme = asyncHandler(async (req, res) => {
  const theme = await WebsiteTheme.findById(requireThemeId(req.params.id));
  if (!theme) throw notFound('Theme not found');
  if (theme.isActive) throw new ApiError('DUPLICATE_REQUEST', 'The active theme cannot be deleted');
  const deleted = await WebsiteTheme.deleteOne({ _id: theme._id, isActive: false, __v: theme.__v });
  if (!deleted.deletedCount) throw new ApiError('DUPLICATE_REQUEST', 'This theme changed or became active. Reload before deleting.');
  await Promise.all([
    WebsiteThemeVersion.deleteMany({ theme: theme._id }),
    StoreContentVersion.deleteMany({ scopeType: 'THEME', scopeId: theme._id }),
  ]);
  logAudit({ req, action: 'WEBSITE_THEME_DELETE', entityType: 'WebsiteTheme', entityId: theme._id, before: themeSummary(theme) });
  res.json({ success: true, message: 'Theme deleted' });
});

exports.getHistory = asyncHandler(async (req, res) => {
  const themeId = requireThemeId(req.params.id);
  if (!await WebsiteTheme.exists({ _id: themeId })) throw notFound('Theme not found');
  const versions = WebsiteThemeVersion.find({ theme: themeId }).populate('publishedBy', 'name email phone').sort('-version').limit(100);
  // Restoring still reads the immutable snapshot on the server. The designer
  // only needs metadata, not 100 complete theme configurations in memory.
  if (req.query?.summary === 'true') versions.select('-config');
  res.json(await versions.lean());
});

exports.restoreVersion = asyncHandler(async (req, res) => {
  const theme = await WebsiteTheme.findById(requireThemeId(req.params.id));
  if (!theme) throw notFound('Theme not found');
  requireCurrentRevision(req, theme);
  const versionId = requireThemeId(req.params.versionId);
  const version = await WebsiteThemeVersion.findOne({ _id: versionId, theme: theme._id });
  if (!version) throw notFound('Theme version not found');
  theme.draftConfig = normalizeWebsiteConfig(version.config);
  theme.updatedBy = req.user._id;
  theme.markModified('draftConfig');
  await saveTheme(theme);
  logAudit({ req, action: 'WEBSITE_THEME_VERSION_RESTORE', entityType: 'WebsiteTheme', entityId: theme._id, after: { restoredVersion: version.version } });
  res.json({ theme, restoredVersion: version.version, message: 'Version restored to draft. Review and publish it when ready.' });
});

exports._invalidateActiveCache = invalidateActiveCache;
