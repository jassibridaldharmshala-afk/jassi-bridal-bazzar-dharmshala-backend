const mongoose = require('mongoose');
const crypto = require('node:crypto');
const Banner = require('../models/Banner');
const BannerEngagement = require('../models/BannerEngagement');
const Order = require('../models/Order');
const { BANNER_POSITIONS, BANNER_TYPES, DESTINATION_TYPES } = require('../models/Banner');
const { andFilter } = require('../services/storeService');
const { recordEventLater } = require('../services/analyticsService');
const { logAudit } = require('../services/auditService');
const { auditSnapshot } = require('../utils/auditData');
const { asyncHandler } = require('../middleware/validate');
const { ApiError, notFound } = require('../utils/apiError');
const { createRecordOnce } = require('../services/recordCreationService');
const {
  buildPaginatedResponse, optionalString, readPagination, requireBoolean,
  requireEnum, requireObjectId, requireString, wantsPagination,
} = require('../utils/validators');

const AUDIT_FIELDS = [
  'title', 'subtitle', 'image', 'tabletImage', 'mobileImage', 'altText', 'focalPoint',
  'buttonText', 'link', 'destinationType', 'destinationValue', 'campaignKey', 'campaignId', 'couponCode',
  'type', 'position', 'startsAt', 'endsAt', 'isActive', 'isArchived', 'displayOrder', 'revision',
];

function managementRequest(req) {
  return /^\/api\/(admin|seller)(\/|$)/.test(req.baseUrl || '');
}

function liveBannerQuery(now = new Date()) {
  return {
    isActive: true,
    isArchived: { $ne: true },
    $and: [
      { $or: [{ startsAt: { $exists: false } }, { startsAt: null }, { startsAt: { $lte: now } }] },
      { $or: [{ endsAt: { $exists: false } }, { endsAt: null }, { endsAt: { $gte: now } }] },
    ],
  };
}

function bannerStatus(banner, now = new Date()) {
  if (banner.isArchived) return 'Archived';
  if (!banner.isActive) return 'Paused';
  if (banner.startsAt && new Date(banner.startsAt) > now) return 'Scheduled';
  if (banner.endsAt && new Date(banner.endsAt) < now) return 'Ended';
  return 'Live';
}

function publicBannerView(banner) {
  const value = typeof banner?.toObject === 'function' ? banner.toObject() : { ...(banner || {}) };
  return {
    _id: value._id,
    title: value.title,
    subtitle: value.subtitle || '',
    image: value.image,
    tabletImage: value.tabletImage || '',
    mobileImage: value.mobileImage || '',
    altText: value.altText || value.title,
    focalPoint: value.focalPoint || 'center',
    buttonText: value.buttonText || '',
    link: value.link || '/products',
    type: value.type,
    position: value.position,
    displayOrder: value.displayOrder || 0,
    campaignKey: value.campaignKey || `banner-${value._id}`,
    couponCode: value.couponCode || '',
  };
}

function managementBannerView(banner, performance = {}) {
  const value = typeof banner?.toObject === 'function' ? banner.toObject() : { ...(banner || {}) };
  const impressions = Number(value.impressions || value.views || 0);
  const clicks = Number(value.clicks || 0);
  const campaign = performance[value.campaignKey] || {};
  return {
    ...value,
    views: impressions,
    impressions,
    clicks,
    ctr: impressions ? Math.round((clicks / impressions) * 10000) / 100 : 0,
    attributedOrders: Number(campaign.orders || 0),
    attributedRevenue: Math.round(Number(campaign.revenue || 0) * 100) / 100,
    status: bannerStatus(value),
  };
}

async function campaignPerformance(banners, tenantFilter) {
  const keys = [...new Set(banners.map((item) => item.campaignKey).filter(Boolean))];
  if (!keys.length) return {};
  const match = andFilter({
    'attribution.campaign': { $in: keys },
    orderStatus: { $nin: ['Cancelled', 'Returned', 'Refunded'] },
    $or: [{ paymentMethod: 'COD' }, { paymentStatus: 'Paid' }],
  }, tenantFilter || {});
  const rows = await Order.aggregate([
    { $match: match },
    { $group: { _id: '$attribution.campaign', orders: { $sum: 1 }, revenue: { $sum: '$finalAmount' } } },
  ]);
  return Object.fromEntries(rows.map((row) => [row._id, row]));
}

exports.getBanners = asyncHandler(async (req, res) => {
  const admin = managementRequest(req);
  let filter = admin ? {} : liveBannerQuery();
  if (admin) {
    const archive = String(req.query.archive || 'active').toLowerCase();
    if (!['active', 'archived', 'all'].includes(archive)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid banner archive filter');
    if (archive === 'active') filter.isArchived = { $ne: true };
    if (archive === 'archived') filter.isArchived = true;
    if (req.query.position) filter.position = requireEnum(req.query.position, BANNER_POSITIONS, 'position');
    if (req.query.type) filter.type = requireEnum(req.query.type, BANNER_TYPES, 'type');
    if (req.query.status === 'active') filter.isActive = true;
    if (req.query.status === 'inactive') filter.isActive = false;
  } else if (req.query.position) {
    filter.position = requireEnum(req.query.position, BANNER_POSITIONS, 'position');
  }
  const search = admin ? String(req.query.search || '').trim().slice(0, 80) : '';
  const query = andFilter(filter, req.tenantFilter);
  const finder = () => Banner.find(query).sort({ position: 1, displayOrder: 1, createdAt: -1 });
  const filterSearch = (items) => !search ? items : items.filter((item) => [item.title, item.subtitle, item.link, item.position, item.campaignKey]
    .filter(Boolean).join(' ').toLowerCase().includes(search.toLowerCase()));
  if (wantsPagination(req.query) && !search) {
    const { page, limit, skip } = readPagination(req.query, { defaultLimit: 24, maxLimit: 100 });
    const [items, total] = await Promise.all([finder().skip(skip).limit(limit), Banner.countDocuments(query)]);
    const performance = admin ? await campaignPerformance(items, req.tenantFilter) : {};
    return res.json(buildPaginatedResponse(items.map((item) => admin ? managementBannerView(item, performance) : publicBannerView(item)), { page, limit, total }));
  }
  const items = filterSearch(await finder().limit(admin ? 500 : 100));
  const performance = admin ? await campaignPerformance(items, req.tenantFilter) : {};
  return res.json(items.map((item) => admin ? managementBannerView(item, performance) : publicBannerView(item)));
});

exports.getBannerById = asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id, 'banner id');
  const banner = await Banner.findOne(andFilter({ _id: id }, req.tenantFilter));
  if (!banner) throw notFound('Banner not found');
  const performance = await campaignPerformance([banner], req.tenantFilter);
  res.json(managementBannerView(banner, performance));
});

exports.createBanner = asyncHandler(async (req, res) => {
  const payload = readBannerPayload(req.body);
  delete payload.storeId;
  if (req.store?._id) payload.storeId = req.store._id;
  const banner = await createRecordOnce(req, { Model: Banner, filter: req.tenantFilter || {}, create: async identity => {
    const record = new Banner({ ...payload, ...identity });
    if (!record.campaignKey) record.campaignKey = `banner-${String(record._id)}`;
    await record.save();
    logAudit({ req, action: 'BANNER_CREATE', entityType: 'Banner', entityId: record._id, storeId: record.storeId, after: auditSnapshot(record, AUDIT_FIELDS) });
    return record;
  } });
  res.status(201).json(managementBannerView(banner));
});

exports.updateBanner = asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id, 'banner id');
  const banner = await Banner.findOne(andFilter({ _id: id }, req.tenantFilter));
  if (!banner) throw notFound('Banner not found');
  if (banner.campaignId) throw new ApiError('VALIDATION_ERROR', 'This banner is managed by Campaigns. Edit the campaign to keep its creative and offer synchronized.');
  if (banner.isArchived) throw new ApiError('VALIDATION_ERROR', 'Restore this banner before editing it');
  if (req.body.revision !== undefined && Number(req.body.revision) !== Number(banner.revision || 0)) {
    throw new ApiError('CONFLICT', 'This banner changed in another session. Reload it before saving.', { statusCode: 409 });
  }
  const before = auditSnapshot(banner, AUDIT_FIELDS);
  Object.assign(banner, readBannerPayload(req.body, banner));
  banner.revision = Number(banner.revision || 0) + 1;
  await banner.save();
  logAudit({ req, action: 'BANNER_UPDATE', entityType: 'Banner', entityId: banner._id, storeId: banner.storeId, before, after: auditSnapshot(banner, AUDIT_FIELDS) });
  res.json(managementBannerView(banner));
});

exports.updateBannerStatus = asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id, 'banner id');
  const banner = await Banner.findOne(andFilter({ _id: id }, req.tenantFilter));
  if (!banner) throw notFound('Banner not found');
  if (banner.campaignId) throw new ApiError('VALIDATION_ERROR', 'This banner is managed by Campaigns. Pause or publish the campaign instead.');
  const before = auditSnapshot(banner, AUDIT_FIELDS);
  banner.isActive = requireBoolean(req.body.isActive, 'isActive');
  if (banner.isArchived && banner.isActive) throw new ApiError('VALIDATION_ERROR', 'Restore this banner before activating it');
  banner.revision = Number(banner.revision || 0) + 1;
  await banner.save();
  logAudit({ req, action: banner.isActive ? 'BANNER_ACTIVATE' : 'BANNER_PAUSE', entityType: 'Banner', entityId: banner._id, storeId: banner.storeId, before, after: auditSnapshot(banner, AUDIT_FIELDS) });
  res.json(managementBannerView(banner));
});

exports.deleteBanner = asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id, 'banner id');
  const banner = await Banner.findOne(andFilter({ _id: id, isArchived: { $ne: true } }, req.tenantFilter));
  if (!banner) throw notFound('Banner not found');
  if (banner.campaignId) throw new ApiError('VALIDATION_ERROR', 'This banner is managed by Campaigns. Archive the campaign instead.');
  const before = auditSnapshot(banner, AUDIT_FIELDS);
  banner.isActive = false;
  banner.isArchived = true;
  banner.archivedAt = new Date();
  banner.revision = Number(banner.revision || 0) + 1;
  await banner.save();
  logAudit({ req, action: 'BANNER_ARCHIVE', entityType: 'Banner', entityId: banner._id, storeId: banner.storeId, before, after: auditSnapshot(banner, AUDIT_FIELDS) });
  res.json({ success: true, archived: true, message: 'Banner archived. Its media and performance history were preserved.', banner: managementBannerView(banner) });
});

exports.restoreBanner = asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id, 'banner id');
  const banner = await Banner.findOne(andFilter({ _id: id, isArchived: true }, req.tenantFilter));
  if (!banner) throw notFound('Archived banner not found');
  if (banner.campaignId) throw new ApiError('VALIDATION_ERROR', 'This banner is managed by Campaigns. Restore the campaign instead.');
  const before = auditSnapshot(banner, AUDIT_FIELDS);
  banner.isArchived = false;
  banner.archivedAt = undefined;
  banner.isActive = false;
  banner.revision = Number(banner.revision || 0) + 1;
  await banner.save();
  logAudit({ req, action: 'BANNER_RESTORE', entityType: 'Banner', entityId: banner._id, storeId: banner.storeId, before, after: auditSnapshot(banner, AUDIT_FIELDS) });
  res.json(managementBannerView(banner));
});

exports.duplicateBanner = asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id, 'banner id');
  const source = await Banner.findOne(andFilter({ _id: id }, req.tenantFilter)).lean();
  if (!source) throw notFound('Banner not found');
  const copy = { ...source };
  delete copy._id; delete copy.__v; delete copy.createdAt; delete copy.updatedAt; delete copy.archivedAt; delete copy.campaignId;
  copy.title = `${source.title} copy`.slice(0, 120);
  copy.campaignKey = `banner-${new mongoose.Types.ObjectId()}`;
  copy.isActive = false; copy.isArchived = false; copy.impressions = 0; copy.views = 0; copy.clicks = 0; copy.revision = 0;
  const banner = await Banner.create(copy);
  logAudit({ req, action: 'BANNER_DUPLICATE', entityType: 'Banner', entityId: banner._id, storeId: banner.storeId, after: auditSnapshot(banner, AUDIT_FIELDS), summary: `Copied from ${source.title}` });
  res.status(201).json(managementBannerView(banner));
});

exports.reorderBanners = asyncHandler(async (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length || items.length > 100) throw new ApiError('VALIDATION_ERROR', 'Choose between 1 and 100 banners to reorder');
  const normalized = items.map((item, index) => ({
    id: requireObjectId(item.id || item._id, `items[${index}].id`),
    displayOrder: Math.max(0, Number.parseInt(item.displayOrder, 10) || 0),
  }));
  const ids = normalized.map((item) => item.id);
  const owned = await Banner.countDocuments(andFilter({ _id: { $in: ids }, isArchived: { $ne: true } }, req.tenantFilter));
  if (owned !== new Set(ids).size) throw new ApiError('VALIDATION_ERROR', 'One or more banners cannot be reordered');
  if (await Banner.exists(andFilter({ _id: { $in: ids }, campaignId: { $exists: true, $ne: null } }, req.tenantFilter))) {
    throw new ApiError('VALIDATION_ERROR', 'Campaign-managed banners must be reordered from Campaigns.');
  }
  await Banner.bulkWrite(normalized.map((item) => ({
    updateOne: { filter: andFilter({ _id: item.id }, req.tenantFilter), update: { $set: { displayOrder: item.displayOrder }, $inc: { revision: 1 } } },
  })));
  logAudit({ req, action: 'BANNER_REORDER', entityType: 'Banner', storeId: req.store?._id, after: { items: normalized } });
  res.json({ success: true, message: 'Banner order updated' });
});

exports.recordBannerEvent = asyncHandler(async (req, res) => {
  const config = await require('../services/trafficConfigurationService').configuration(req.store);
  if (!config.enabled || (config.consentRequired && req.body?.consent !== true)) return res.status(202).json({ success: true, ignored: true });
  const id = requireObjectId(req.params.id, 'banner id');
  const event = requireEnum(String(req.body.event || '').toLowerCase(), ['impression', 'click'], 'event');
  const sessionId = optionalString(req.body.sessionId, 'sessionId', { max: 80 });
  const liveQuery = andFilter({ _id: id, ...liveBannerQuery() }, req.tenantFilter);
  const liveBanner = await Banner.findOne(liveQuery).select('_id storeId campaignKey position');
  if (!liveBanner) throw notFound('Banner not found');

  if (event === 'impression' && sessionId) {
    const sessionHash = crypto.createHash('sha256').update(sessionId).digest('hex');
    try {
      await BannerEngagement.create({
        storeId: liveBanner.storeId,
        banner: liveBanner._id,
        event,
        sessionHash,
        day: new Date().toISOString().slice(0, 10),
      });
    } catch (error) {
      if (error?.code === 11000) return res.status(202).json({ success: true, duplicate: true });
      throw error;
    }
  }
  const increment = event === 'impression' ? { impressions: 1, views: 1 } : { clicks: 1 };
  const banner = await Banner.findOneAndUpdate(liveQuery, { $inc: increment }, { new: true });
  if (!banner) throw notFound('Banner not found');
  if (req.body.trafficHandled !== true) recordEventLater({
    name: event === 'impression' ? 'BANNER_IMPRESSION' : 'BANNER_CLICK',
    storeId: banner.storeId,
    sessionId,
    campaign: banner.campaignKey || `banner-${banner._id}`,
    metadata: { bannerId: String(banner._id), position: banner.position },
  });
  res.status(202).json({ success: true });
});

function readBannerPayload(body = {}, existing = null) {
  const title = body.title === undefined && existing ? existing.title : requireString(body.title, 'Banner title', { max: 120 });
  const type = requireEnum(body.type || existing?.type || 'Hero', BANNER_TYPES, 'type');
  const position = requireEnum(body.position || existing?.position || 'Home - Top', BANNER_POSITIONS, 'position');
  const startsAt = readDate(body.startsAt, 'Start date', existing?.startsAt);
  const endsAt = readDate(body.endsAt, 'End date', existing?.endsAt);
  if (startsAt && endsAt && endsAt <= startsAt) throw new ApiError('VALIDATION_ERROR', 'Banner end date must be after its start date');
  const destinationType = requireEnum(body.destinationType || existing?.destinationType || 'CUSTOM', DESTINATION_TYPES, 'destination type');
  const destinationValue = optionalString(body.destinationValue ?? existing?.destinationValue, 'destination', { max: 300 });
  const rawLink = optionalString(body.link ?? existing?.link, 'redirect link', { max: 1000 });
  const link = buildDestinationLink(destinationType, destinationValue, rawLink);
  const image = readImage(body.image, existing?.image, body.removeImage, 'Banner image');
  if (!image) throw new ApiError('VALIDATION_ERROR', 'Banner image is required');
  return {
    title,
    subtitle: optionalString(body.subtitle ?? existing?.subtitle, 'subtitle', { max: 300 }),
    buttonText: optionalString(body.buttonText ?? existing?.buttonText, 'CTA label', { max: 60 }),
    image,
    tabletImage: readImage(body.tabletImage, existing?.tabletImage, body.removeTabletImage, 'Tablet image'),
    mobileImage: readImage(body.mobileImage, existing?.mobileImage, body.removeMobileImage, 'Mobile image'),
    altText: optionalString(body.altText ?? existing?.altText, 'alternative text', { max: 180 }),
    focalPoint: requireEnum(body.focalPoint || existing?.focalPoint || 'center', ['center', 'top', 'bottom', 'left', 'right'], 'focal point'),
    link,
    destinationType,
    destinationValue,
    campaignKey: normalizeCampaignKey(body.campaignKey ?? existing?.campaignKey),
    couponCode: normalizeCoupon(body.couponCode ?? existing?.couponCode),
    type,
    position,
    startsAt,
    endsAt,
    isActive: body.isActive === undefined ? existing?.isActive ?? true : requireBoolean(body.isActive, 'isActive'),
    displayOrder: readDisplayOrder(body.displayOrder ?? existing?.displayOrder),
  };
}

function readImage(value, existing, remove, field) {
  if (remove === true) return '';
  const image = String(value || existing || '').trim();
  if (!image) return '';
  if (image.startsWith('data:') || (!image.startsWith('/') && !/^https?:\/\//i.test(image))) {
    throw new ApiError('VALIDATION_ERROR', `${field} must be an uploaded HTTP URL`);
  }
  return image.slice(0, 2048);
}

function readDate(value, field, existing) {
  if (value === undefined) return existing || undefined;
  if (value === null || value === '') return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new ApiError('VALIDATION_ERROR', `${field} is invalid`);
  return date;
}

function readDisplayOrder(value) {
  const order = Number(value || 0);
  if (!Number.isInteger(order) || order < 0 || order > 100000) throw new ApiError('VALIDATION_ERROR', 'Display order must be a whole number between 0 and 100000');
  return order;
}

function normalizeCampaignKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

function normalizeCoupon(value) {
  const code = String(value || '').trim().toUpperCase();
  if (code && !/^[A-Z0-9_-]{3,32}$/.test(code)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid coupon code');
  return code;
}

function safeCustomLink(value) {
  const link = String(value || '').trim();
  if (!link) return '/products';
  if (link.startsWith('/') && !link.startsWith('//')) return link;
  try {
    const url = new URL(link);
    if (url.protocol === 'https:') return url.toString();
  } catch { /* handled below */ }
  throw new ApiError('VALIDATION_ERROR', 'Redirect link must be an internal path or a secure HTTPS URL');
}

function buildDestinationLink(type, value, fallback) {
  if (type === 'PRODUCT') return `/product?id=${requireObjectId(value, 'product destination')}`;
  if (type === 'CATEGORY') return `/products?category=${requireObjectId(value, 'category destination')}`;
  if (type === 'COLLECTION') {
    const collection = String(value || '').trim().replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 80);
    if (!collection) throw new ApiError('VALIDATION_ERROR', 'Collection destination is required');
    return `/products?collection=${encodeURIComponent(collection)}`;
  }
  if (type === 'COUPON') return `/cart?coupon=${encodeURIComponent(normalizeCoupon(value))}`;
  return safeCustomLink(fallback || value);
}

exports.bannerStatus = bannerStatus;
exports.buildDestinationLink = buildDestinationLink;
exports.liveBannerQuery = liveBannerQuery;
exports.managementBannerView = managementBannerView;
exports.publicBannerView = publicBannerView;
exports.readBannerPayload = readBannerPayload;
