const WebsiteTheme = require('../models/WebsiteTheme');
const Store = require('../models/Store');
const StoreContentVersion = require('../models/StoreContentVersion');
const { normalizeWebsiteConfig } = require('../config/websiteCustomization');
const { ApiError } = require('../utils/apiError');
const { logAudit } = require('./auditService');

const LIMITS = Object.freeze({
  sectionHeading: 160,
  sectionDescription: 600,
  buttonText: 80,
  buttonLink: 500,
  blockEyebrow: 80,
  blockTitle: 140,
  blockBody: 1200,
  altText: 180,
  item: 160,
  items: 8,
  note: 240,
});
const SECTION_FIELDS = ['heading', 'description', 'buttonText', 'buttonLink', 'imageAlt'];
const BLOCK_FIELDS = ['eyebrow', 'title', 'body', 'buttonText', 'buttonLink', 'altText', 'items'];

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function invalid(message) { throw new ApiError('VALIDATION_ERROR', message); }
function clean(value, max, label) {
  if (typeof value !== 'string') invalid(`${label} must be text.`);
  const result = value.trim();
  if (result.length > max) invalid(`${label} must be ${max} characters or fewer.`);
  return result;
}
function safeInternalLink(value, label) {
  const link = clean(value, LIMITS.buttonLink, label);
  if (link && (!link.startsWith('/') || link.startsWith('//') || link.includes('\\'))) invalid(`${label} must be a safe store path beginning with /.`);
  return link;
}

function snapshotContent(source) {
  const config = normalizeWebsiteConfig(source || {});
  return {
    sections: config.homepage.sections.map((section) => ({
      id: section.id, label: section.label,
      heading: section.heading || '', description: section.description || '',
      buttonText: section.buttonText || '', buttonLink: section.buttonLink || '', imageAlt: section.imageAlt || '',
      hasImage: Boolean(section.image || section.mobileImage || section.backgroundImage), visible: section.visible !== false,
    })),
    blocks: config.homepage.blocks.map((block) => ({
      id: block.id, type: block.type,
      eyebrow: block.eyebrow || '', title: block.title || '', body: block.body || '',
      buttonText: block.buttonText || '', buttonLink: block.buttonLink || '', altText: block.altText || '',
      items: [...(block.items || [])], hasImage: Boolean(block.image || block.mobileImage), visible: block.visible !== false,
    })),
  };
}

function sanitizeContent(input, baseConfig) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Content details are required.');
  if (Object.keys(input).some((key) => !['sections', 'blocks'].includes(key))) throw new ApiError('FORBIDDEN', 'Only storefront wording can be changed here.');
  const base = snapshotContent(baseConfig);
  const sectionMap = new Map(base.sections.map((item) => [item.id, item]));
  const blockMap = new Map(base.blocks.map((item) => [item.id, item]));
  const sections = input.sections === undefined ? base.sections : input.sections;
  const blocks = input.blocks === undefined ? base.blocks : input.blocks;
  if (!Array.isArray(sections) || sections.length > 14) invalid('Homepage section content is invalid.');
  if (!Array.isArray(blocks) || blocks.length > 24) invalid('Custom block content is invalid.');
  const seenSections = new Set();
  const cleanedSections = sections.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some((key) => !['id', 'label', 'heading', 'description', 'buttonText', 'buttonLink', 'imageAlt', 'hasImage', 'visible'].includes(key))) throw new ApiError('FORBIDDEN', 'Only section wording can be changed here.');
    const id = String(item.id || '');
    const existing = sectionMap.get(id);
    if (!existing || seenSections.has(id)) invalid('A homepage section is unknown or repeated.');
    if ((item.visible !== undefined && item.visible !== existing.visible) || (item.label !== undefined && item.label !== existing.label) || (item.hasImage !== undefined && item.hasImage !== existing.hasImage)) throw new ApiError('FORBIDDEN', 'Only section wording can be changed here.');
    seenSections.add(id);
    return {
      ...existing,
      heading: clean(item.heading ?? existing.heading, LIMITS.sectionHeading, `${existing.label} heading`),
      description: clean(item.description ?? existing.description, LIMITS.sectionDescription, `${existing.label} description`),
      buttonText: clean(item.buttonText ?? existing.buttonText, LIMITS.buttonText, `${existing.label} button label`),
      buttonLink: safeInternalLink(item.buttonLink ?? existing.buttonLink, `${existing.label} button destination`),
      imageAlt: clean(item.imageAlt ?? existing.imageAlt, LIMITS.altText, `${existing.label} image description`),
    };
  });
  const seenBlocks = new Set();
  const cleanedBlocks = blocks.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some((key) => !['id', 'type', 'eyebrow', 'title', 'body', 'buttonText', 'buttonLink', 'altText', 'items', 'hasImage', 'visible'].includes(key))) throw new ApiError('FORBIDDEN', 'Only custom block wording can be changed here.');
    const id = String(item.id || '');
    const existing = blockMap.get(id);
    if (!existing || seenBlocks.has(id) || item.type !== existing.type) invalid('A custom content block is unknown, repeated, or changed structurally.');
    if ((item.visible !== undefined && item.visible !== existing.visible) || (item.hasImage !== undefined && item.hasImage !== existing.hasImage)) throw new ApiError('FORBIDDEN', 'Only custom block wording can be changed here.');
    seenBlocks.add(id);
    if (!Array.isArray(item.items ?? existing.items) || (item.items ?? existing.items).length > LIMITS.items) invalid(`${existing.type} block can contain up to ${LIMITS.items} text items.`);
    return {
      ...existing,
      eyebrow: clean(item.eyebrow ?? existing.eyebrow, LIMITS.blockEyebrow, `${existing.type} eyebrow`),
      title: clean(item.title ?? existing.title, LIMITS.blockTitle, `${existing.type} title`),
      body: clean(item.body ?? existing.body, LIMITS.blockBody, `${existing.type} body`),
      buttonText: clean(item.buttonText ?? existing.buttonText, LIMITS.buttonText, `${existing.type} button label`),
      buttonLink: safeInternalLink(item.buttonLink ?? existing.buttonLink, `${existing.type} button destination`),
      altText: clean(item.altText ?? existing.altText, LIMITS.altText, `${existing.type} image description`),
      items: (item.items ?? existing.items).map((value, index) => clean(value, LIMITS.item, `${existing.type} item ${index + 1}`)).filter(Boolean),
    };
  });
  return { sections: cleanedSections, blocks: cleanedBlocks };
}

function reconcileContent(input, baseConfig) {
  const current = snapshotContent(baseConfig);
  const sections = new Map((input?.sections || []).map((item) => [String(item?.id || ''), item]));
  const blocks = new Map((input?.blocks || []).map((item) => [String(item?.id || ''), item]));
  return sanitizeContent({
    sections: current.sections.map((item) => ({ ...item, ...(sections.get(item.id) || {}) , id: item.id, label: item.label, hasImage: item.hasImage })),
    blocks: current.blocks.map((item) => ({ ...item, ...(blocks.get(item.id) || {}), id: item.id, type: item.type, hasImage: item.hasImage })),
  }, baseConfig);
}

function applyContent(baseConfig, contentInput) {
  const config = normalizeWebsiteConfig(baseConfig || {});
  const content = reconcileContent(contentInput, config);
  const sectionMap = new Map(content.sections.map((item) => [item.id, item]));
  config.homepage.sections.forEach((section) => {
    const source = sectionMap.get(section.id);
    if (!source) return;
    SECTION_FIELDS.forEach((key) => { section[key] = source[key]; });
  });
  const blockMap = new Map(content.blocks.map((item) => [item.id, item]));
  config.homepage.blocks.forEach((block) => {
    const source = blockMap.get(block.id);
    if (!source || source.type !== block.type) return;
    BLOCK_FIELDS.forEach((key) => { block[key] = clone(source[key]); });
  });
  return normalizeWebsiteConfig(config);
}

function compareContent(beforeInput, afterInput) {
  const before = beforeInput || { sections: [], blocks: [] };
  const after = afterInput || { sections: [], blocks: [] };
  const changes = [];
  for (const group of ['sections', 'blocks']) {
    const previous = new Map((before[group] || []).map((item) => [item.id, item]));
    for (const item of after[group] || []) {
      const old = previous.get(item.id) || {};
      for (const key of group === 'sections' ? SECTION_FIELDS : BLOCK_FIELDS) {
        const left = JSON.stringify(old[key] ?? '');
        const right = JSON.stringify(item[key] ?? '');
        if (left !== right) changes.push({ path: `${group}.${item.id}.${key}`, before: displayValue(old[key]).slice(0, 4000), after: displayValue(item[key]).slice(0, 4000) });
      }
    }
  }
  return changes;
}

function displayValue(value) {
  if (value === undefined || value === null) return '';
  return Array.isArray(value) || typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function contentPreflight(contentInput, baseConfig) {
  const content = sanitizeContent(contentInput, baseConfig);
  const warnings = [];
  const blocking = [];
  const visible = [...content.sections, ...content.blocks].filter((item) => item.visible !== false);
  const emptySections = content.sections.filter((item) => item.visible !== false && !item.heading && !item.description).length;
  const emptyBlocks = content.blocks.filter((item) => item.visible !== false && !item.title && !item.body && !(item.items || []).length).length;
  const missingAlt = visible.filter((item) => item.hasImage && !(item.imageAlt || item.altText)).length;
  const incompleteCtas = visible.filter((item) => Boolean(item.buttonText) !== Boolean(item.buttonLink)).length;
  const malformedFaqs = content.blocks.filter((item) => item.visible !== false && item.type === 'faq').flatMap((item) => item.items || []).filter((item) => !String(item).includes('|')).length;
  const duplicateHeadings = content.sections.filter((item) => item.visible !== false && item.heading).map((item) => item.heading.toLowerCase()).filter((value, index, rows) => rows.indexOf(value) !== index).length;
  if (emptySections) warnings.push(`${emptySections} homepage section${emptySections === 1 ? ' has' : 's have'} no heading or description.`);
  if (emptyBlocks) warnings.push(`${emptyBlocks} visible custom block${emptyBlocks === 1 ? ' is' : 's are'} empty.`);
  if (missingAlt) warnings.push(`${missingAlt} visible image${missingAlt === 1 ? ' needs' : 's need'} a description for accessibility.`);
  if (incompleteCtas) warnings.push(`${incompleteCtas} call-to-action${incompleteCtas === 1 ? ' is' : 's are'} missing either a button label or destination.`);
  if (malformedFaqs) warnings.push(`${malformedFaqs} FAQ item${malformedFaqs === 1 ? ' does' : 's do'} not include an answer. Use Question|Answer.`);
  if (duplicateHeadings) warnings.push(`${duplicateHeadings} visible homepage heading${duplicateHeadings === 1 ? ' is' : 's are'} repeated.`);
  return { ready: blocking.length === 0, blocking, warnings, changes: [], summary: { sections: content.sections.length, blocks: content.blocks.length, visibleAreas: visible.length } };
}

async function reserveVersion(scopeType, scopeId, content, previous, note, userId, options = {}) {
  if (options.releaseId) {
    const existing = await StoreContentVersion.findOne({ releaseId: options.releaseId });
    if (existing) return existing;
  }
  let latest = await StoreContentVersion.findOne({ scopeType, scopeId }).sort('-version').select('version').lean();
  if (!latest && options.ensureBaseline !== false) {
    try {
      latest = await StoreContentVersion.create({ scopeType, scopeId, version: 1, content: clone(previous), changes: [], note: 'Initial published storefront content', publishedBy: userId, kind: 'BASELINE', state: 'PUBLISHED' });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      latest = await StoreContentVersion.findOne({ scopeType, scopeId }).sort('-version').select('version').lean();
    }
  }
  try {
    return await StoreContentVersion.create({
      scopeType, scopeId, version: Number(latest?.version || 0) + 1, content: clone(content),
      changes: compareContent(previous, content), note: clean(String(note || 'Content published'), LIMITS.note, 'Publish note'), publishedBy: userId,
      kind: options.kind || 'PUBLISH', state: options.state || 'PUBLISHED', releaseId: options.releaseId,
    });
  } catch (error) {
    if (error?.code === 11000 && options.releaseId) return StoreContentVersion.findOne({ releaseId: options.releaseId });
    if (error?.code === 11000) throw new ApiError('DUPLICATE_REQUEST', 'Another content publish completed first. Reload before retrying.');
    throw error;
  }
}

const RELEASE_LEASE_MS = 5 * 60 * 1000;
const RELEASE_RETRY_DELAY_MS = 5 * 60 * 1000;
const RELEASE_MAX_ATTEMPTS = 3;
const MASTER_RELEASE_FIELDS = ['scheduledContent', 'scheduledContentId', 'scheduledContentFor', 'scheduledContentNote', 'scheduledContentBy', 'scheduledContentStatus', 'scheduledContentAttempts', 'scheduledContentLeaseUntil', 'scheduledContentLastAttemptAt', 'scheduledContentError'];
const STORE_RELEASE_FIELDS = MASTER_RELEASE_FIELDS.map((field) => `storefrontDesign.${field}`);
let worker;
let running = false;

function dueStatus(path = '') {
  const field = (name) => `${path}${name}`;
  const retryBefore = new Date(Date.now() - RELEASE_RETRY_DELAY_MS);
  return { $or: [
    { [field('scheduledContentStatus')]: { $exists: false } },
    { [field('scheduledContentStatus')]: 'SCHEDULED' },
    { [field('scheduledContentStatus')]: 'FAILED', [field('scheduledContentAttempts')]: { $lt: RELEASE_MAX_ATTEMPTS }, [field('scheduledContentLastAttemptAt')]: { $lte: retryBefore } },
    { [field('scheduledContentStatus')]: 'PROCESSING', [field('scheduledContentLeaseUntil')]: { $lte: new Date() } },
  ] };
}
function unsetFields(fields) { return Object.fromEntries(fields.map((field) => [field, 1])); }

async function claimMasterSchedule() {
  const now = new Date();
  return WebsiteTheme.findOneAndUpdate({ $and: [
    { scheduledContentFor: { $lte: now }, scheduledContent: { $exists: true, $ne: null } }, dueStatus(),
  ] }, { $set: { scheduledContentStatus: 'PROCESSING', scheduledContentLeaseUntil: new Date(Date.now() + RELEASE_LEASE_MS), scheduledContentLastAttemptAt: now, scheduledContentError: '' }, $inc: { scheduledContentAttempts: 1 } }, { new: true, sort: { scheduledContentFor: 1 } });
}
async function clearMasterSchedule(sourceId, releaseId) {
  await WebsiteTheme.updateOne({ _id: sourceId, scheduledContentId: releaseId }, { $unset: unsetFields(MASTER_RELEASE_FIELDS) });
}
async function failMasterSchedule(source, error) {
  await WebsiteTheme.updateOne({ _id: source._id, scheduledContentId: source.scheduledContentId }, { $set: { scheduledContentStatus: 'FAILED', scheduledContentError: String(error?.message || 'Content release failed').slice(0, 500) }, $unset: { scheduledContentLeaseUntil: 1 } });
}
async function processClaimedMasterSchedule(source) {
  const releaseId = source.scheduledContentId || `legacy-theme-${source._id}-${new Date(source.scheduledContentFor).getTime()}`;
  if (!source.scheduledContentId) { await WebsiteTheme.updateOne({ _id: source._id }, { $set: { scheduledContentId: releaseId } }); source.scheduledContentId = releaseId; }
  try {
    let history = await StoreContentVersion.findOne({ releaseId });
    if (history?.state === 'PUBLISHED') { await clearMasterSchedule(source._id, releaseId); return WebsiteTheme.findOne({ isActive: true }); }
    const theme = await WebsiteTheme.findOne({ isActive: true }) || source;
    const base = theme.publishedConfig || theme.draftConfig;
    const content = reconcileContent(source.scheduledContent, base);
    history = history || await reserveVersion('THEME', theme._id, content, snapshotContent(base), source.scheduledContentNote || 'Scheduled content publish', source.scheduledContentBy, { kind: 'SCHEDULED', state: 'RESERVED', releaseId });
    const values = {
      publishedConfig: applyContent(base, content),
      draftConfig: applyContent(theme.draftConfig || base, content),
      publishedAt: new Date(), publishedBy: source.scheduledContentBy, updatedBy: source.scheduledContentBy,
    };
    if (theme.scheduledConfig) values.scheduledConfig = applyContent(theme.scheduledConfig, content);
    const updated = await WebsiteTheme.findOneAndUpdate({ _id: theme._id, updatedAt: theme.updatedAt }, { $set: values, $inc: { __v: 1 } }, { new: true, runValidators: true });
    if (!updated) throw new ApiError('DUPLICATE_REQUEST', 'The active theme changed while scheduled content was publishing.');
    await StoreContentVersion.updateOne({ _id: history._id }, { $set: { state: 'PUBLISHED' } });
    await clearMasterSchedule(source._id, releaseId);
    await logAudit({ action: 'STORE_CONTENT_SCHEDULE_PUBLISH', entityType: 'WebsiteTheme', entityId: updated._id, source: 'SYSTEM', after: { releaseId, version: history.version } }).catch(() => null);
    return updated;
  } catch (error) { await failMasterSchedule(source, error).catch(() => null); throw error; }
}

async function claimSellerSchedule(storeId) {
  const now = new Date();
  const filter = { $and: [
    ...(storeId ? [{ _id: storeId }] : []),
    { 'storefrontDesign.scheduledContentFor': { $lte: now }, 'storefrontDesign.scheduledContent': { $exists: true, $ne: null } },
    dueStatus('storefrontDesign.'),
  ] };
  return Store.findOneAndUpdate(filter, { $set: { 'storefrontDesign.scheduledContentStatus': 'PROCESSING', 'storefrontDesign.scheduledContentLeaseUntil': new Date(Date.now() + RELEASE_LEASE_MS), 'storefrontDesign.scheduledContentLastAttemptAt': now, 'storefrontDesign.scheduledContentError': '' }, $inc: { 'storefrontDesign.scheduledContentAttempts': 1, __v: 1 } }, { new: true, sort: { 'storefrontDesign.scheduledContentFor': 1 } });
}
async function clearSellerSchedule(storeId, releaseId) {
  return Store.findOneAndUpdate({ _id: storeId, 'storefrontDesign.scheduledContentId': releaseId }, { $unset: unsetFields(STORE_RELEASE_FIELDS), $inc: { __v: 1 } }, { new: true });
}
async function failSellerSchedule(store, error) {
  await Store.updateOne({ _id: store._id, 'storefrontDesign.scheduledContentId': store.storefrontDesign.scheduledContentId }, { $set: { 'storefrontDesign.scheduledContentStatus': 'FAILED', 'storefrontDesign.scheduledContentError': String(error?.message || 'Content release failed').slice(0, 500) }, $unset: { 'storefrontDesign.scheduledContentLeaseUntil': 1 }, $inc: { __v: 1 } });
}
async function processClaimedSellerSchedule(store) {
  const design = store.storefrontDesign;
  const releaseId = design.scheduledContentId || `legacy-store-${store._id}-${new Date(design.scheduledContentFor).getTime()}`;
  if (!design.scheduledContentId) { await Store.updateOne({ _id: store._id }, { $set: { 'storefrontDesign.scheduledContentId': releaseId } }); design.scheduledContentId = releaseId; }
  try {
    let history = await StoreContentVersion.findOne({ releaseId });
    if (history?.state === 'PUBLISHED') return (await clearSellerSchedule(store._id, releaseId)) || store;
    const activeTheme = await WebsiteTheme.findOne({ isActive: true }).lean();
    const publishedBase = design.publishedConfig || activeTheme?.publishedConfig || {};
    const content = reconcileContent(design.scheduledContent, publishedBase);
    history = history || await reserveVersion('STORE', store._id, content, snapshotContent(publishedBase), design.scheduledContentNote || 'Scheduled content publish', design.scheduledContentBy, { kind: 'SCHEDULED', state: 'RESERVED', releaseId });
    const next = { ...(design.toObject?.() || design), publishedConfig: applyContent(publishedBase, content), draftConfig: applyContent(design.draftConfig || publishedBase, content), publishedAt: new Date(), updatedAt: new Date(), updatedBy: design.scheduledContentBy, revision: Number(design.revision || 0) + 1 };
    if (next.scheduledConfig) next.scheduledConfig = applyContent(next.scheduledConfig, content);
    const updated = await Store.findOneAndUpdate({ _id: store._id, __v: store.__v }, { $set: { storefrontDesign: next }, $inc: { __v: 1 } }, { new: true, runValidators: true });
    if (!updated) throw new ApiError('DUPLICATE_REQUEST', 'Store content changed while its schedule was publishing.');
    await StoreContentVersion.updateOne({ _id: history._id }, { $set: { state: 'PUBLISHED' } });
    const cleared = await clearSellerSchedule(store._id, releaseId);
    await logAudit({ action: 'STORE_CONTENT_SCHEDULE_PUBLISH', entityType: 'Store', entityId: store._id, storeId: store._id, source: 'SYSTEM', after: { releaseId, version: history.version } }).catch(() => null);
    return cleared || updated;
  } catch (error) { await failSellerSchedule(store, error).catch(() => null); throw error; }
}

async function publishDueMasterContent() {
  const source = await claimMasterSchedule();
  if (!source) return null;
  return processClaimedMasterSchedule(source);
}
async function publishDueSellerContent(storeInput) {
  const claimed = await claimSellerSchedule(storeInput?._id);
  if (!claimed) return storeInput;
  return processClaimedSellerSchedule(claimed);
}
async function processDueContentReleases(limit = 10) {
  let processed = 0;
  while (processed < limit) {
    const source = await claimMasterSchedule();
    if (!source) break;
    await processClaimedMasterSchedule(source).catch(() => null); processed += 1;
  }
  while (processed < limit) {
    const store = await claimSellerSchedule();
    if (!store) break;
    await processClaimedSellerSchedule(store).catch(() => null); processed += 1;
  }
  return processed;
}
function startContentReleaseWorker() {
  if (worker || process.env.NODE_ENV === 'test') return stopContentReleaseWorker;
  const configured = Number(process.env.CONTENT_RELEASE_INTERVAL_MS || 60000);
  const interval = Number.isFinite(configured) ? Math.min(3600000, Math.max(30000, configured)) : 60000;
  processDueContentReleases().catch((error) => console.error(`Content release worker unavailable: ${error.message}`));
  worker = setInterval(() => processDueContentReleases().catch((error) => console.error(`Content release worker unavailable: ${error.message}`)), interval);
  worker.unref();
  return stopContentReleaseWorker;
}

function stopContentReleaseWorker() {
  if (worker) clearInterval(worker);
  worker = null;
}

module.exports = { LIMITS, RELEASE_MAX_ATTEMPTS, applyContent, clone, compareContent, contentPreflight, processDueContentReleases, publishDueMasterContent, publishDueSellerContent, reconcileContent, reserveVersion, sanitizeContent, snapshotContent, startContentReleaseWorker, stopContentReleaseWorker };
