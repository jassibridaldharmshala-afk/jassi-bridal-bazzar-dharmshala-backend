const mongoose = require('mongoose');
const Campaign = require('../models/Campaign');
const Coupon = require('../models/Coupon');
const Banner = require('../models/Banner');
const Order = require('../models/Order');
const AnalyticsEvent = require('../models/AnalyticsEvent');
const { CAMPAIGN_PRESETS } = require('../models/Campaign');
const { BANNER_POSITIONS, BANNER_TYPES, DESTINATION_TYPES } = require('../models/Banner');
const { andFilter } = require('../services/storeService');
const { logAudit } = require('../services/auditService');
const { auditSnapshot } = require('../utils/auditData');
const { ApiError, notFound } = require('../utils/apiError');
const { asyncHandler } = require('../middleware/validate');
const { readCouponPayload, validateCouponReferences } = require('./couponController');
const { readBannerPayload } = require('./bannerController');
const {
  buildPaginatedResponse, optionalString, readPagination, requireEnum,
  requireObjectId, requireString,
} = require('../utils/validators');

const STATES = ['DRAFT', 'BUILDING', 'PUBLISHED', 'PAUSED', 'FAILED', 'ARCHIVED'];
const ACTIONS = ['PUBLISH', 'PAUSE', 'ARCHIVE', 'RESTORE'];
const OFFER_FIELDS = [
  'code', 'activationMode', 'benefitType', 'type', 'discountValue', 'buyQuantity', 'getQuantity',
  'minOrderAmount', 'minItemQuantity', 'maxDiscountAmount', 'usageLimit', 'customerLimit',
  'totalBudget', 'customerSegment', 'firstOrderOnly', 'stackingMode', 'scopeMatchMode',
  'minimumPriorOrders', 'minimumLifetimeSpend', 'inactiveDays',
  'minimumRequirementBasis', 'restoreOnFullRefund', 'isPublic', 'applicableProducts',
  'applicableCategories', 'applicableCustomers', 'applicablePincodes',
  'applicablePaymentMethods', 'salesChannels',
];
const CREATIVE_FIELDS = [
  'title', 'subtitle', 'buttonText', 'image', 'tabletImage', 'mobileImage', 'altText',
  'focalPoint', 'type', 'position', 'destinationType', 'destinationValue', 'link', 'displayOrder',
];
const AUDIT_FIELDS = ['key', 'name', 'preset', 'state', 'offer', 'creative', 'startsAt', 'endsAt', 'timezone', 'coupon', 'banners', 'lastError', 'revision'];
const EVENT_NAMES = ['BANNER_IMPRESSION', 'BANNER_CLICK', 'PRODUCT_VIEW', 'ADD_TO_CART', 'BEGIN_CHECKOUT'];
const ORDER_EXCLUDED = new Set(['Cancelled', 'Return Requested', 'Exchange Requested', 'Returned', 'Refunded']);

function plain(value) {
  return typeof value?.toObject === 'function' ? value.toObject() : { ...(value || {}) };
}

function nestedPlain(value) {
  return typeof value?.toObject === 'function' ? value.toObject() : { ...(value || {}) };
}

function dateValue(value, field, fallback) {
  if (value === undefined) return fallback || undefined;
  if (value === null || value === '') return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new ApiError('VALIDATION_ERROR', `${field} is invalid`);
  return date;
}

function numberValue(value, field, fallback = 0, { integer = false, max = 100000000 } = {}) {
  const parsed = value === undefined || value === '' || value === null ? Number(fallback || 0) : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > max || (integer && !Number.isInteger(parsed))) {
    throw new ApiError('VALIDATION_ERROR', `${field} must be ${integer ? 'a whole number' : 'a number'} between 0 and ${max}`);
  }
  return parsed;
}

function booleanValue(value, fallback) {
  if (value === undefined) return Boolean(fallback);
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ApiError('VALIDATION_ERROR', 'Choose a valid yes or no value');
}

function idList(value, fallback = [], field = 'selection', limit = 500) {
  if (value === undefined) return (fallback || []).map(String);
  if (!Array.isArray(value)) throw new ApiError('VALIDATION_ERROR', `${field} must be a list`);
  const result = Array.from(new Set(value.map((item) => String(item?._id || item || '').trim()).filter(Boolean)));
  if (result.length > limit || result.some((id) => !mongoose.isValidObjectId(id))) {
    throw new ApiError('VALIDATION_ERROR', `${field} contains an invalid selection`);
  }
  return result;
}

function stringList(value, fallback = [], field, allowed, pattern, limit = 500) {
  if (value === undefined) return [...(fallback || [])];
  const source = Array.isArray(value) ? value : String(value || '').split(/[\s,]+/);
  const result = Array.from(new Set(source.map((item) => String(item || '').trim().toUpperCase()).filter(Boolean)));
  if (result.length > limit || (allowed && result.some((item) => !allowed.includes(item))) || (pattern && result.some((item) => !pattern.test(item)))) {
    throw new ApiError('VALIDATION_ERROR', `${field} contains an invalid value`);
  }
  return result;
}

function campaignKey(name) {
  const base = String(name || 'campaign').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 55) || 'campaign';
  return `${base}-${new mongoose.Types.ObjectId().toString().slice(-8)}`;
}

function readDraftPayload(body = {}, existing = null) {
  const current = plain(existing);
  const currentOffer = nestedPlain(current.offer);
  const currentCreative = nestedPlain(current.creative);
  const offerInput = body.offer && typeof body.offer === 'object' ? body.offer : {};
  const creativeInput = body.creative && typeof body.creative === 'object' ? body.creative : {};
  const offer = { ...currentOffer };
  const creative = { ...currentCreative };

  const name = body.name === undefined && existing
    ? current.name
    : requireString(body.name, 'Campaign name', { min: 3, max: 120 });
  const preset = requireEnum(String(body.preset || current.preset || 'FESTIVAL').toUpperCase(), CAMPAIGN_PRESETS, 'campaign goal');

  OFFER_FIELDS.forEach((field) => {
    if (offerInput[field] !== undefined) offer[field] = offerInput[field];
  });
  CREATIVE_FIELDS.forEach((field) => {
    if (creativeInput[field] !== undefined) creative[field] = creativeInput[field];
  });

  offer.code = String(offer.code || '').trim().toUpperCase();
  if (offer.code && !/^[A-Z0-9_-]{3,32}$/.test(offer.code)) throw new ApiError('VALIDATION_ERROR', 'Coupon code must use 3 to 32 letters, numbers, dashes or underscores');
  offer.activationMode = requireEnum(offer.activationMode || 'CODE', ['CODE', 'AUTOMATIC'], 'activation mode');
  offer.benefitType = requireEnum(offer.benefitType || 'DISCOUNT', ['DISCOUNT', 'FREE_SHIPPING', 'BUY_X_GET_Y'], 'offer benefit');
  offer.type = requireEnum(offer.type || 'Percentage', ['Percentage', 'Flat'], 'discount type');
  offer.discountValue = numberValue(offer.discountValue, 'Discount value', 10, { max: offer.type === 'Percentage' ? 100 : 10000000 });
  offer.buyQuantity = numberValue(offer.buyQuantity, 'Buy quantity', 2, { integer: true, max: 100 }) || 1;
  offer.getQuantity = numberValue(offer.getQuantity, 'Free quantity', 1, { integer: true, max: 100 }) || 1;
  offer.minOrderAmount = numberValue(offer.minOrderAmount, 'Minimum order amount', 0);
  offer.minItemQuantity = numberValue(offer.minItemQuantity, 'Minimum item quantity', 0, { integer: true, max: 100000 });
  offer.maxDiscountAmount = numberValue(offer.maxDiscountAmount, 'Maximum discount', 0);
  offer.usageLimit = numberValue(offer.usageLimit, 'Usage limit', 0, { integer: true, max: 10000000 });
  offer.customerLimit = numberValue(offer.customerLimit, 'Customer limit', 1, { integer: true, max: 10000000 });
  offer.totalBudget = numberValue(offer.totalBudget, 'Campaign budget', 0);
  offer.customerSegment = requireEnum(offer.customerSegment || 'ALL', ['ALL', 'NEW', 'REPEAT', 'VIP', 'INACTIVE', 'SELECTED'], 'audience');
  offer.minimumPriorOrders = numberValue(offer.minimumPriorOrders, 'Minimum previous orders', offer.customerSegment === 'VIP' ? 5 : offer.customerSegment === 'REPEAT' ? 1 : 0, { integer: true, max: 100000 });
  offer.minimumLifetimeSpend = numberValue(offer.minimumLifetimeSpend, 'Minimum lifetime spend', offer.customerSegment === 'VIP' ? 25000 : 0);
  offer.inactiveDays = numberValue(offer.inactiveDays, 'Inactive period', 90, { integer: true, max: 3650 }) || 1;
  offer.firstOrderOnly = booleanValue(offer.firstOrderOnly, preset === 'FIRST_ORDER');
  offer.stackingMode = requireEnum(offer.stackingMode || 'ALLOW_PRODUCT_OFFERS', ['EXCLUSIVE', 'ALLOW_PRODUCT_OFFERS'], 'stacking mode');
  offer.scopeMatchMode = requireEnum(offer.scopeMatchMode || 'ALL', ['ANY', 'ALL'], 'scope matching');
  offer.minimumRequirementBasis = requireEnum(offer.minimumRequirementBasis || 'CART', ['CART', 'ELIGIBLE_ITEMS'], 'minimum requirement basis');
  offer.restoreOnFullRefund = booleanValue(offer.restoreOnFullRefund, false);
  offer.isPublic = booleanValue(offer.isPublic, !['VIP', 'SELECTED', 'INACTIVE'].includes(offer.customerSegment));
  offer.applicableProducts = idList(offerInput.applicableProducts, currentOffer.applicableProducts, 'Products');
  offer.applicableCategories = idList(offerInput.applicableCategories, currentOffer.applicableCategories, 'Categories');
  offer.applicableCustomers = idList(offerInput.applicableCustomers, currentOffer.applicableCustomers, 'Customers', 200);
  offer.applicablePincodes = stringList(offerInput.applicablePincodes, currentOffer.applicablePincodes, 'PIN codes', null, /^\d{6}$/);
  offer.applicablePaymentMethods = stringList(offerInput.applicablePaymentMethods, currentOffer.applicablePaymentMethods, 'Payment methods', ['COD', 'UPI', 'CARD', 'NETBANKING', 'WALLET', 'RAZORPAY']);
  offer.salesChannels = stringList(offerInput.salesChannels, currentOffer.salesChannels || ['STOREFRONT'], 'Sales channels', ['STOREFRONT', 'ADMIN', 'SOCIAL']);

  creative.title = optionalString(creative.title || name, 'Banner title', { max: 120 });
  creative.subtitle = optionalString(creative.subtitle, 'Banner subtitle', { max: 300 });
  creative.buttonText = optionalString(creative.buttonText || 'Shop now', 'Button text', { max: 60 });
  creative.image = optionalString(creative.image, 'Desktop image', { max: 2048 });
  creative.tabletImage = optionalString(creative.tabletImage, 'Tablet image', { max: 2048 });
  creative.mobileImage = optionalString(creative.mobileImage, 'Mobile image', { max: 2048 });
  creative.altText = optionalString(creative.altText, 'Alternative text', { max: 180 });
  creative.focalPoint = requireEnum(creative.focalPoint || 'center', ['center', 'top', 'bottom', 'left', 'right'], 'focal point');
  creative.type = requireEnum(creative.type || (['FESTIVAL', 'FLASH'].includes(preset) ? 'Sale' : 'Offer'), BANNER_TYPES, 'banner type');
  creative.position = requireEnum(creative.position || 'Home - Middle', BANNER_POSITIONS, 'banner position');
  creative.destinationType = requireEnum(creative.destinationType || 'CUSTOM', DESTINATION_TYPES, 'destination type');
  creative.destinationValue = optionalString(creative.destinationValue, 'Destination', { max: 300 });
  creative.link = optionalString(creative.link, 'Custom link', { max: 1000 });
  creative.displayOrder = numberValue(creative.displayOrder, 'Display order', 0, { integer: true, max: 100000 });

  const startsAt = dateValue(body.startsAt, 'Campaign start', current.startsAt);
  const endsAt = dateValue(body.endsAt, 'Campaign end', current.endsAt);
  if (startsAt && endsAt && endsAt <= startsAt) throw new ApiError('VALIDATION_ERROR', 'Campaign end must be after its start');
  const timezone = optionalString(body.timezone === undefined ? current.timezone || 'Asia/Kolkata' : body.timezone, 'Timezone', { max: 80 }) || 'Asia/Kolkata';
  return { name, preset, offer, creative, startsAt, endsAt, timezone };
}

function readiness(campaign) {
  const value = plain(campaign);
  const offer = nestedPlain(value.offer);
  const creative = nestedPlain(value.creative);
  const errors = [];
  const warnings = [];
  if (!String(value.name || '').trim()) errors.push('Add a campaign name.');
  if (!/^[A-Z0-9_-]{3,32}$/.test(String(offer.code || ''))) errors.push('Add a valid coupon code.');
  if (!creative.image) errors.push('Upload a desktop campaign image.');
  if (offer.benefitType === 'DISCOUNT' && Number(offer.discountValue || 0) <= 0) errors.push('Enter a discount greater than zero.');
  if (value.preset === 'FIRST_ORDER' && (!offer.firstOrderOnly || offer.customerSegment !== 'NEW')) errors.push('First-order campaigns must target new customers and remain first-order only.');
  if (value.preset === 'FIRST_ORDER' && (!Number(offer.minOrderAmount || 0) || !value.endsAt)) errors.push('First-order campaigns need a minimum order and end time.');
  if (value.preset === 'FREE_SHIPPING' && (!Number(offer.minOrderAmount || 0) || !Number(offer.maxDiscountAmount || 0))) errors.push('Free-shipping campaigns need a minimum order and maximum delivery benefit.');
  if (value.preset === 'FESTIVAL' && (!value.endsAt || (!Number(offer.usageLimit || 0) && !Number(offer.totalBudget || 0)))) errors.push('Festival campaigns need an end time and a usage or budget guard.');
  if (value.preset === 'FLASH' && (!value.startsAt || !value.endsAt || new Date(value.endsAt) <= new Date())) errors.push('Flash campaigns need a start time and future end time.');
  if (value.preset === 'CATEGORY' && !(offer.applicableCategories || []).length) errors.push('Choose at least one category.');
  if (offer.benefitType === 'BUY_X_GET_Y' && !(offer.applicableProducts || []).length && !(offer.applicableCategories || []).length) errors.push('Choose products or categories for the buy-and-get offer.');
  if (value.preset === 'REPEAT' && (offer.customerSegment !== 'REPEAT' || Number(offer.minimumPriorOrders || 0) < 1)) errors.push('Repeat-customer campaigns need at least one previous order.');
  if (value.preset === 'VIP' && (offer.customerSegment !== 'VIP' || (!Number(offer.minimumPriorOrders || 0) && !Number(offer.minimumLifetimeSpend || 0)))) errors.push('VIP campaigns need an order-count or lifetime-spend threshold.');
  if (offer.customerSegment === 'SELECTED' && !(offer.applicableCustomers || []).length) errors.push('Choose at least one customer.');
  if (['PRODUCT', 'CATEGORY', 'COLLECTION'].includes(creative.destinationType) && !creative.destinationValue) errors.push('Choose where the banner should open.');
  if (creative.destinationType === 'COUPON' && !offer.code) errors.push('Add a coupon code for this banner destination.');
  if (!creative.mobileImage) warnings.push('Add a mobile image for the best phone experience.');
  if (!creative.altText) warnings.push('Add image description text for accessibility.');
  if (!value.endsAt && value.preset !== 'FIRST_ORDER') warnings.push('An end time prevents an offer from remaining live by mistake.');
  if (!Number(offer.usageLimit || 0) && !Number(offer.totalBudget || 0)) warnings.push('Set a usage limit or budget if the offer needs a spending guard.');
  return { ready: errors.length === 0, errors, warnings };
}

function lifecycle(campaign, now = new Date()) {
  if (campaign.state === 'ARCHIVED') return 'Archived';
  if (campaign.state === 'FAILED') return 'Failed';
  if (campaign.state === 'DRAFT' || campaign.state === 'BUILDING') return 'Draft';
  if (campaign.state === 'PAUSED') return 'Paused';
  if (campaign.startsAt && new Date(campaign.startsAt) > now) return 'Scheduled';
  if (campaign.endsAt && new Date(campaign.endsAt) <= now) return 'Ended';
  return 'Live';
}

function synchronizationHealth(campaign) {
  const value = plain(campaign);
  const coupon = value.coupon && typeof value.coupon === 'object' && value.coupon.code ? value.coupon : null;
  const banners = (value.banners || []).filter((item) => item && typeof item === 'object' && item.title);
  const issues = [];
  const needsLinks = ['PUBLISHED', 'PAUSED', 'FAILED', 'ARCHIVED'].includes(value.state);
  if (needsLinks && !coupon) issues.push('Linked coupon is missing.');
  if (needsLinks && !banners.length) issues.push('Linked banner is missing.');
  if (coupon) {
    if (String(coupon.campaignId || '') !== String(value._id)) issues.push('Coupon ownership does not match this campaign.');
    if (String(coupon.code || '').toUpperCase() !== String(value.offer?.code || '').toUpperCase()) issues.push('Coupon code is out of sync.');
  }
  banners.forEach((banner) => {
    if (String(banner.campaignId || '') !== String(value._id)) issues.push('Banner ownership does not match this campaign.');
    if (String(banner.campaignKey || '') !== String(value.key || '')) issues.push('Banner attribution is out of sync.');
    if (String(banner.couponCode || '').toUpperCase() !== String(value.offer?.code || '').toUpperCase()) issues.push('Banner coupon link is out of sync.');
  });
  if (value.state === 'PUBLISHED' && coupon && (!coupon.isActive || coupon.isArchived)) issues.push('Linked coupon is not active.');
  if (value.state === 'PUBLISHED' && banners.some((banner) => !banner.isActive || banner.isArchived)) issues.push('A linked banner is not active.');
  if (value.state === 'PAUSED' && coupon?.isActive) issues.push('Linked coupon is still active.');
  if (value.state === 'PAUSED' && banners.some((banner) => banner.isActive)) issues.push('A linked banner is still active.');
  if (value.state === 'ARCHIVED' && coupon && !coupon.isArchived) issues.push('Linked coupon is not archived.');
  if (value.state === 'ARCHIVED' && banners.some((banner) => !banner.isArchived)) issues.push('A linked banner is not archived.');
  if (value.state === 'FAILED' && value.lastError) issues.unshift(value.lastError);
  return { synchronized: issues.length === 0, issues: [...new Set(issues)] };
}

function conflictMapFor(campaigns) {
  const result = Object.fromEntries(campaigns.map((campaign) => [String(campaign._id), []]));
  const startOf = (campaign) => campaign.startsAt ? new Date(campaign.startsAt).getTime() : -Infinity;
  const endOf = (campaign) => campaign.endsAt ? new Date(campaign.endsAt).getTime() : Infinity;
  for (let leftIndex = 0; leftIndex < campaigns.length; leftIndex += 1) {
    const left = campaigns[leftIndex];
    if (left.state === 'ARCHIVED' || !left.creative?.position) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < campaigns.length; rightIndex += 1) {
      const right = campaigns[rightIndex];
      if (right.state === 'ARCHIVED' || left.creative.position !== right.creative?.position) continue;
      if (left.state !== 'PUBLISHED' && right.state !== 'PUBLISHED') continue;
      if (startOf(left) > endOf(right) || startOf(right) > endOf(left)) continue;
      result[String(left._id)].push({ id: String(right._id), name: right.name, position: right.creative.position });
      result[String(right._id)].push({ id: String(left._id), name: left.name, position: left.creative.position });
    }
  }
  return result;
}

function campaignView(campaign, performance = {}, scheduleConflicts = []) {
  const value = plain(campaign);
  const coupon = value.coupon && typeof value.coupon === 'object' ? value.coupon : null;
  const banners = (value.banners || []).filter(Boolean);
  return {
    ...value,
    coupon: coupon?._id || value.coupon || null,
    banners: banners.map((item) => item?._id || item),
    linkedCoupon: coupon ? { id: String(coupon._id), code: coupon.code, usedCount: Number(coupon.usedCount || 0), spentAmount: Number(coupon.spentAmount || 0), isActive: Boolean(coupon.isActive), isArchived: Boolean(coupon.isArchived) } : null,
    linkedBanners: banners.filter((item) => item && typeof item === 'object').map((item) => ({ id: String(item._id), title: item.title, isActive: Boolean(item.isActive), isArchived: Boolean(item.isArchived) })),
    lifecycle: lifecycle(value),
    readiness: readiness(value),
    health: synchronizationHealth(value),
    schedule: { clear: scheduleConflicts.length === 0, conflicts: scheduleConflicts },
    performance: performance[String(value._id)] || emptyPerformance(),
  };
}

function emptyPerformance() {
  return { impressions: 0, clicks: 0, productViews: 0, addToCarts: 0, checkouts: 0, orders: 0, paidOrders: 0, revenue: 0, orderValue: 0, averageOrderValue: 0, discountCost: 0, cancelled: 0, returned: 0, uniqueCustomers: 0, ctr: 0, conversionRate: 0, daily: [] };
}

function round(value) { return Math.round(Number(value || 0) * 100) / 100; }

async function performanceFor(campaigns, tenantFilter, rangeDays = 30) {
  const result = Object.fromEntries(campaigns.map((item) => [String(item._id), emptyPerformance()]));
  if (!campaigns.length) return result;
  const keys = campaigns.map((item) => String(item.key || '')).filter(Boolean);
  const codes = campaigns.map((item) => String(item.offer?.code || '').toUpperCase()).filter(Boolean);
  const start = new Date(Date.now() - Math.max(1, Math.min(365, rangeDays)) * 86400000);
  const [events, orders] = await Promise.all([
    keys.length ? AnalyticsEvent.find(andFilter({ campaign: { $in: keys }, name: { $in: EVENT_NAMES }, createdAt: { $gte: start } }, tenantFilter)).select('campaign name createdAt').lean() : [],
    (keys.length || codes.length) ? Order.find(andFilter({ createdAt: { $gte: start }, $or: [{ 'attribution.campaign': { $in: keys } }, { 'coupon.code': { $in: codes } }] }, tenantFilter)).select('user finalAmount couponDiscount coupon paymentMethod paymentStatus orderStatus attribution createdAt').lean() : [],
  ]);
  const byKey = new Map(campaigns.map((item) => [String(item.key || ''), item]));
  const byCode = new Map(campaigns.filter((item) => item.offer?.code).map((item) => [String(item.offer.code).toUpperCase(), item]));
  const customers = Object.create(null);
  const daily = Object.create(null);
  const bump = (campaign, field, amount = 1, date) => {
    const id = String(campaign._id); result[id][field] += amount;
    if (date) {
      const day = new Date(date).toISOString().slice(0, 10);
      daily[id] ||= Object.create(null); daily[id][day] ||= { date: day, impressions: 0, clicks: 0, orders: 0, revenue: 0 };
      if (Object.prototype.hasOwnProperty.call(daily[id][day], field)) daily[id][day][field] += amount;
    }
  };
  for (const event of events) {
    const campaign = byKey.get(String(event.campaign || ''));
    if (!campaign) continue;
    if (event.name === 'BANNER_IMPRESSION') bump(campaign, 'impressions', 1, event.createdAt);
    if (event.name === 'BANNER_CLICK') bump(campaign, 'clicks', 1, event.createdAt);
    if (event.name === 'PRODUCT_VIEW') bump(campaign, 'productViews');
    if (event.name === 'ADD_TO_CART') bump(campaign, 'addToCarts');
    if (event.name === 'BEGIN_CHECKOUT') bump(campaign, 'checkouts');
  }
  for (const order of orders) {
    const campaign = byKey.get(String(order.attribution?.campaign || '')) || byCode.get(String(order.coupon?.code || '').toUpperCase());
    if (!campaign) continue;
    const orderedAt = new Date(order.createdAt).getTime();
    const startsAt = campaign.startsAt ? new Date(campaign.startsAt).getTime() : 0;
    const attributionEndsAt = campaign.endsAt ? new Date(campaign.endsAt).getTime() + (7 * 86400000) : Infinity;
    if (orderedAt < startsAt || orderedAt > attributionEndsAt) continue;
    const id = String(campaign._id);
    const status = String(order.orderStatus || '');
    if (status === 'Cancelled') { bump(campaign, 'cancelled'); continue; }
    if (['Return Requested', 'Exchange Requested', 'Returned', 'Refunded'].includes(status)) { bump(campaign, 'returned'); continue; }
    if (ORDER_EXCLUDED.has(status)) continue;
    bump(campaign, 'orders', 1, order.createdAt);
    bump(campaign, 'orderValue', Number(order.finalAmount || 0));
    bump(campaign, 'discountCost', Number(order.coupon?.savingAmount ?? order.couponDiscount ?? 0));
    customers[id] ||= new Set(); if (order.user) customers[id].add(String(order.user));
    const paid = order.paymentStatus === 'Paid' || (String(order.paymentMethod).toUpperCase() === 'COD' && status === 'Delivered');
    if (paid) { bump(campaign, 'paidOrders'); bump(campaign, 'revenue', Number(order.finalAmount || 0), order.createdAt); }
  }
  campaigns.forEach((campaign) => {
    const id = String(campaign._id); const row = result[id];
    row.revenue = round(row.revenue); row.orderValue = round(row.orderValue); row.discountCost = round(row.discountCost);
    row.averageOrderValue = row.orders ? round(row.orderValue / row.orders) : 0;
    row.uniqueCustomers = customers[id]?.size || 0;
    row.ctr = row.impressions ? round((row.clicks / row.impressions) * 100) : 0;
    row.conversionRate = row.clicks ? round((row.orders / row.clicks) * 100) : 0;
    row.daily = Object.values(daily[id] || {}).sort((a, b) => a.date.localeCompare(b.date)).map((item) => ({ ...item, revenue: round(item.revenue) }));
  });
  return result;
}

function couponBody(campaign, active) {
  const offer = nestedPlain(campaign.offer);
  return {
    code: offer.code, title: campaign.name, description: campaign.creative?.subtitle || `${campaign.name} campaign offer`,
    terms: 'Offer eligibility, availability and store policies apply.', activationMode: offer.activationMode,
    benefitType: offer.benefitType, type: offer.type, discountValue: offer.benefitType === 'DISCOUNT' ? offer.discountValue : 0,
    buyQuantity: offer.buyQuantity, getQuantity: offer.getQuantity, minOrderAmount: offer.minOrderAmount,
    minItemQuantity: offer.minItemQuantity, maxDiscountAmount: offer.maxDiscountAmount, validFrom: campaign.startsAt,
    expiryDate: campaign.endsAt, usageLimit: offer.usageLimit, customerLimit: offer.customerLimit,
    firstOrderOnly: offer.firstOrderOnly || campaign.preset === 'FIRST_ORDER', restoreOnFullRefund: offer.restoreOnFullRefund,
    customerSegment: offer.customerSegment, totalBudget: offer.totalBudget, priority: 10, stackingMode: offer.stackingMode,
    minimumPriorOrders: offer.minimumPriorOrders, minimumLifetimeSpend: offer.minimumLifetimeSpend, inactiveDays: offer.inactiveDays,
    scopeMatchMode: offer.scopeMatchMode, minimumRequirementBasis: offer.minimumRequirementBasis,
    isPublic: offer.isPublic, isActive: active, applicablePaymentMethods: offer.applicablePaymentMethods,
    applicableProducts: offer.applicableProducts, applicableCategories: offer.applicableCategories,
    applicableCustomers: offer.applicableCustomers, applicablePincodes: offer.applicablePincodes, salesChannels: offer.salesChannels,
  };
}

function bannerBody(campaign, active) {
  const creative = nestedPlain(campaign.creative);
  const destinationValue = creative.destinationType === 'COUPON' ? campaign.offer.code : creative.destinationValue;
  return {
    ...creative, title: creative.title || campaign.name, campaignKey: campaign.key, couponCode: campaign.offer.code,
    destinationValue, startsAt: campaign.startsAt, endsAt: campaign.endsAt, isActive: active,
  };
}

async function restoreDocument(Model, snapshot) {
  if (!snapshot?._id) return;
  await Model.replaceOne({ _id: snapshot._id }, snapshot).catch(() => null);
}

async function applyLinkedTransition(campaign, req, { couponUpdate, bannerUpdate, mutateCampaign }) {
  const campaignSnapshot = campaign.toObject();
  const coupon = campaign.coupon ? await Coupon.findOne(andFilter({ _id: campaign.coupon }, req.tenantFilter)) : null;
  const banners = campaign.banners?.length ? await Banner.find(andFilter({ _id: { $in: campaign.banners } }, req.tenantFilter)) : [];
  const couponSnapshot = coupon?.toObject();
  const bannerSnapshots = banners.map((banner) => banner.toObject());
  try {
    if (coupon && couponUpdate) { coupon.set(couponUpdate); coupon.revision = Number(coupon.revision || 0) + 1; await coupon.save(); }
    for (const banner of banners) {
      if (bannerUpdate) banner.set(bannerUpdate);
      banner.revision = Number(banner.revision || 0) + 1;
      await banner.save();
    }
    mutateCampaign();
    await campaign.save();
  } catch (error) {
    await restoreDocument(Campaign, campaignSnapshot);
    await restoreDocument(Coupon, couponSnapshot);
    await Promise.all(bannerSnapshots.map((snapshot) => restoreDocument(Banner, snapshot)));
    throw error;
  }
}

async function syncCampaign(campaign, req, active = true) {
  const check = readiness(campaign);
  if (!check.ready) throw new ApiError('VALIDATION_ERROR', check.errors.join(' '), { details: { readiness: check } });
  const couponPayload = readCouponPayload(couponBody(campaign, active));
  await validateCouponReferences(couponPayload, req.tenantFilter);
  let coupon = campaign.coupon ? await Coupon.findOne(andFilter({ _id: campaign.coupon }, req.tenantFilter)) : null;
  if (!coupon) coupon = await Coupon.findOne(andFilter({ campaignId: campaign._id }, req.tenantFilter));
  let banner = campaign.banners?.length ? await Banner.findOne(andFilter({ _id: { $in: campaign.banners } }, req.tenantFilter)) : null;
  if (!banner) banner = await Banner.findOne(andFilter({ campaignId: campaign._id }, req.tenantFilter));
  const bannerPayload = readBannerPayload(bannerBody(campaign, active), banner);
  const duplicate = await Coupon.exists(andFilter({ code: couponPayload.code, ...(coupon ? { _id: { $ne: coupon._id } } : {}) }, req.tenantFilter));
  if (duplicate) throw new ApiError('DUPLICATE_REQUEST', 'A coupon with this code already exists');
  if (coupon && couponPayload.code !== coupon.code) {
    const used = Number(coupon.usedCount || 0) > 0 || await Order.exists(andFilter({ $or: [{ 'coupon.couponId': coupon._id }, { 'coupon.code': coupon.code }] }, req.tenantFilter));
    if (used) throw new ApiError('VALIDATION_ERROR', 'Coupon code cannot be changed after it has been used in an order');
  }
  if (coupon && couponPayload.usageLimit && couponPayload.usageLimit < Number(coupon.usedCount || 0)) throw new ApiError('VALIDATION_ERROR', 'Usage limit cannot be lower than existing redemptions');
  if (coupon && couponPayload.totalBudget && couponPayload.totalBudget < Number(coupon.spentAmount || 0)) throw new ApiError('VALIDATION_ERROR', 'Campaign budget cannot be lower than the amount already spent');

  const oldCoupon = coupon ? coupon.toObject() : null;
  const oldBanner = banner ? banner.toObject() : null;
  let createdCoupon = false;
  let createdBanner = false;
  try {
    if (!coupon) { coupon = new Coupon({ storeId: req.store?._id, campaignId: campaign._id }); createdCoupon = true; }
    Object.assign(coupon, couponPayload, { campaignId: campaign._id, isArchived: false, archivedAt: undefined });
    if (oldCoupon) coupon.revision = Number(coupon.revision || 0) + 1;
    await coupon.save();
    if (!banner) { banner = new Banner({ storeId: req.store?._id, campaignId: campaign._id }); createdBanner = true; }
    Object.assign(banner, bannerPayload, { campaignId: campaign._id, isArchived: false, archivedAt: undefined });
    if (oldBanner) banner.revision = Number(banner.revision || 0) + 1;
    await banner.save();
    campaign.coupon = coupon._id;
    campaign.banners = [banner._id];
    campaign.state = active ? 'PUBLISHED' : 'PAUSED';
    campaign.lastError = undefined;
    campaign.lastSyncedAt = new Date();
    if (active && !campaign.publishedAt) campaign.publishedAt = new Date();
    if (!active) campaign.pausedAt = new Date();
    await campaign.save();
    return campaign;
  } catch (error) {
    if (createdCoupon && coupon?._id) await Coupon.deleteOne({ _id: coupon._id }).catch(() => null);
    else await restoreDocument(Coupon, oldCoupon);
    if (createdBanner && banner?._id) await Banner.deleteOne({ _id: banner._id }).catch(() => null);
    else await restoreDocument(Banner, oldBanner);
    if (error?.code === 11000) throw new ApiError('DUPLICATE_REQUEST', 'This coupon code or campaign is already in use');
    throw error;
  }
}

async function findCampaign(req) {
  const campaign = await Campaign.findOne(andFilter({ _id: requireObjectId(req.params.id, 'campaign id') }, req.tenantFilter));
  if (!campaign) throw notFound('Campaign not found');
  return campaign;
}

async function populatedCampaign(id, tenantFilter) {
  return Campaign.findOne(andFilter({ _id: id }, tenantFilter))
    .populate('coupon', 'campaignId code usedCount spentAmount isActive isArchived')
    .populate('banners', 'campaignId campaignKey couponCode title isActive isArchived');
}

async function waitForIdempotentCampaign(id, tenantFilter) {
  let campaign;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    campaign = await populatedCampaign(id, tenantFilter);
    if (!campaign || campaign.state !== 'BUILDING') return campaign;
    await new Promise((resolve) => setTimeout(resolve, 35));
  }
  return campaign;
}

exports.list = asyncHandler(async (req, res) => {
  const { page, limit, skip } = readPagination(req.query, { defaultLimit: 12, maxLimit: 100 });
  const range = Math.max(1, Math.min(365, Number.parseInt(req.query.range, 10) || 30));
  const filter = {};
  const state = String(req.query.state || '').toUpperCase();
  if (state && state !== 'ALL') {
    requireEnum(state, [...STATES, 'LIVE', 'SCHEDULED', 'ENDED'], 'campaign state');
    const now = new Date();
    if (state === 'LIVE') Object.assign(filter, { state: 'PUBLISHED', $and: [{ $or: [{ startsAt: null }, { startsAt: { $exists: false } }, { startsAt: { $lte: now } }] }, { $or: [{ endsAt: null }, { endsAt: { $exists: false } }, { endsAt: { $gt: now } }] }] });
    else if (state === 'SCHEDULED') Object.assign(filter, { state: 'PUBLISHED', startsAt: { $gt: now } });
    else if (state === 'ENDED') Object.assign(filter, { state: 'PUBLISHED', endsAt: { $lte: now } });
    else if (state === 'DRAFT') filter.state = { $in: ['DRAFT', 'BUILDING'] };
    else filter.state = state;
  }
  const search = String(req.query.search || '').trim().slice(0, 80);
  if (search) {
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const searchFilter = [{ name: { $regex: escaped, $options: 'i' } }, { key: { $regex: escaped, $options: 'i' } }, { 'offer.code': { $regex: escaped, $options: 'i' } }];
    if (filter.$and) filter.$and.push({ $or: searchFilter }); else filter.$or = searchFilter;
  }
  const query = andFilter(filter, req.tenantFilter);
  const statsQuery = andFilter({ state: { $ne: 'ARCHIVED' } }, req.tenantFilter);
  const [items, total, statsCampaigns] = await Promise.all([
    Campaign.find(query).sort({ updatedAt: -1 }).skip(skip).limit(limit).populate('coupon', 'code usedCount spentAmount isActive isArchived').populate('banners', 'title isActive isArchived'),
    Campaign.countDocuments(query),
    Campaign.find(statsQuery).select('key name state startsAt endsAt offer creative.position').limit(2000).lean(),
  ]);
  const metricCampaigns = [...new Map([...items, ...statsCampaigns].map((item) => [String(item._id), item])).values()];
  const performance = await performanceFor(metricCampaigns, req.tenantFilter, range);
  const conflicts = conflictMapFor(statsCampaigns);
  const stats = statsCampaigns.reduce((sum, item) => {
    const itemPerformance = performance[String(item._id)] || emptyPerformance();
    const status = lifecycle(item); sum.total += 1; sum.byStatus[status] = (sum.byStatus[status] || 0) + 1;
    ['impressions', 'clicks', 'orders', 'paidOrders', 'revenue', 'orderValue', 'discountCost'].forEach((field) => { sum[field] += Number(itemPerformance[field] || 0); });
    return sum;
  }, { total: 0, byStatus: {}, impressions: 0, clicks: 0, orders: 0, paidOrders: 0, revenue: 0, orderValue: 0, discountCost: 0 });
  stats.revenue = round(stats.revenue); stats.orderValue = round(stats.orderValue); stats.discountCost = round(stats.discountCost);
  stats.ctr = stats.impressions ? round((stats.clicks / stats.impressions) * 100) : 0;
  stats.conversionRate = stats.clicks ? round((stats.orders / stats.clicks) * 100) : 0;
  res.json({ ...buildPaginatedResponse(items.map((item) => campaignView(item, performance, conflicts[String(item._id)] || [])), { page, limit, total }), stats, range, timezone: req.store?.timezone || 'Asia/Kolkata' });
});

exports.get = asyncHandler(async (req, res) => {
  const range = Math.max(1, Math.min(365, Number.parseInt(req.query.range, 10) || 30));
  const campaign = await populatedCampaign(requireObjectId(req.params.id, 'campaign id'), req.tenantFilter);
  if (!campaign) throw notFound('Campaign not found');
  const performance = await performanceFor([campaign], req.tenantFilter, range);
  const scheduled = await Campaign.find(andFilter({ state: { $ne: 'ARCHIVED' } }, req.tenantFilter)).select('name state startsAt endsAt creative.position').limit(2000).lean();
  const conflicts = conflictMapFor(scheduled);
  res.json(campaignView(campaign, performance, conflicts[String(campaign._id)] || []));
});

exports.create = asyncHandler(async (req, res) => {
  const idempotencyKey = String(req.headers['idempotency-key'] || req.body?.idempotencyKey || '').trim().slice(0, 100);
  if (idempotencyKey) {
    const existing = await Campaign.findOne(andFilter({ idempotencyKey }, req.tenantFilter));
    if (existing) return res.json(campaignView(await waitForIdempotentCampaign(existing._id, req.tenantFilter)));
  }
  const payload = readDraftPayload(req.body);
  const publishing = req.body?.publish === true;
  const campaign = new Campaign({ ...payload, key: campaignKey(payload.name), state: publishing ? 'BUILDING' : 'DRAFT', idempotencyKey: idempotencyKey || undefined, storeId: req.store?._id, createdBy: req.user?._id, updatedBy: req.user?._id });
  try { await campaign.save(); }
  catch (error) {
    if (error?.code !== 11000 || !idempotencyKey) throw error;
    const existing = await Campaign.findOne(andFilter({ idempotencyKey }, req.tenantFilter));
    if (!existing) throw error;
    return res.json(campaignView(await waitForIdempotentCampaign(existing._id, req.tenantFilter)));
  }
  try {
    if (publishing) await syncCampaign(campaign, req, true);
  } catch (error) {
    campaign.state = 'FAILED'; campaign.lastError = String(error.message || 'Campaign publish failed').slice(0, 500); await campaign.save();
    throw error;
  }
  logAudit({ req, action: publishing ? 'CAMPAIGN_PUBLISH' : 'CAMPAIGN_CREATE_DRAFT', entityType: 'Campaign', entityId: campaign._id, storeId: campaign.storeId, after: auditSnapshot(campaign, AUDIT_FIELDS) });
  const saved = await populatedCampaign(campaign._id, req.tenantFilter);
  res.status(201).json(campaignView(saved));
});

exports.update = asyncHandler(async (req, res) => {
  const campaign = await findCampaign(req);
  if (campaign.state === 'ARCHIVED') throw new ApiError('VALIDATION_ERROR', 'Restore this campaign before editing it');
  if (req.body.revision !== undefined && Number(req.body.revision) !== Number(campaign.revision || 0)) throw new ApiError('CONFLICT', 'This campaign changed in another session. Reload it before saving.', { statusCode: 409 });
  const beforeDocument = campaign.toObject();
  const before = auditSnapshot(campaign, AUDIT_FIELDS);
  Object.assign(campaign, readDraftPayload(req.body, campaign));
  campaign.updatedBy = req.user?._id; campaign.revision = Number(campaign.revision || 0) + 1;
  const shouldSync = campaign.state === 'PUBLISHED' || req.body?.publish === true;
  if (!shouldSync) { campaign.state = campaign.state === 'FAILED' ? 'DRAFT' : campaign.state; campaign.lastError = undefined; await campaign.save(); }
  else {
    try { await syncCampaign(campaign, req, true); }
    catch (error) { await restoreDocument(Campaign, beforeDocument); throw error; }
  }
  logAudit({ req, action: shouldSync ? 'CAMPAIGN_UPDATE_PUBLISHED' : 'CAMPAIGN_UPDATE_DRAFT', entityType: 'Campaign', entityId: campaign._id, storeId: campaign.storeId, before, after: auditSnapshot(campaign, AUDIT_FIELDS) });
  res.json(campaignView(await populatedCampaign(campaign._id, req.tenantFilter)));
});

exports.status = asyncHandler(async (req, res) => {
  const campaign = await findCampaign(req);
  const action = requireEnum(String(req.body?.action || '').toUpperCase(), ACTIONS, 'campaign action');
  const before = auditSnapshot(campaign, AUDIT_FIELDS);
  campaign.revision = Number(campaign.revision || 0) + 1; campaign.updatedBy = req.user?._id;
  if (action === 'PUBLISH') {
    if (campaign.state === 'ARCHIVED') throw new ApiError('VALIDATION_ERROR', 'Restore this campaign before publishing it');
    try { await syncCampaign(campaign, req, true); }
    catch (error) { campaign.state = 'FAILED'; campaign.lastError = String(error.message || 'Campaign publish failed').slice(0, 500); await campaign.save(); throw error; }
  } else if (action === 'PAUSE') {
    if (!campaign.coupon && !campaign.banners?.length) throw new ApiError('VALIDATION_ERROR', 'Save or publish this draft before pausing it');
    await applyLinkedTransition(campaign, req, {
      couponUpdate: { isActive: false }, bannerUpdate: { isActive: false },
      mutateCampaign: () => { campaign.state = 'PAUSED'; campaign.pausedAt = new Date(); campaign.lastError = undefined; },
    });
  } else if (action === 'ARCHIVE') {
    const now = new Date();
    await applyLinkedTransition(campaign, req, {
      couponUpdate: { isActive: false, isPublic: false, isArchived: true, archivedAt: now },
      bannerUpdate: { isActive: false, isArchived: true, archivedAt: now },
      mutateCampaign: () => { campaign.state = 'ARCHIVED'; campaign.archivedAt = now; },
    });
  } else {
    await applyLinkedTransition(campaign, req, {
      couponUpdate: { isActive: false, isArchived: false, archivedAt: undefined },
      bannerUpdate: { isActive: false, isArchived: false, archivedAt: undefined },
      mutateCampaign: () => { campaign.state = campaign.coupon || campaign.banners?.length ? 'PAUSED' : 'DRAFT'; campaign.archivedAt = undefined; campaign.lastError = undefined; },
    });
  }
  logAudit({ req, action: `CAMPAIGN_${action}`, entityType: 'Campaign', entityId: campaign._id, storeId: campaign.storeId, before, after: auditSnapshot(campaign, AUDIT_FIELDS) });
  res.json(campaignView(await populatedCampaign(campaign._id, req.tenantFilter)));
});

exports.duplicate = asyncHandler(async (req, res) => {
  const source = await findCampaign(req);
  const value = source.toObject();
  const codeBase = String(value.offer?.code || 'OFFER').replace(/_COPY_\d+$/, '').slice(0, 22);
  value.offer.code = `${codeBase}_COPY_${String(Date.now()).slice(-4)}`.slice(0, 32);
  const copy = await Campaign.create({
    storeId: source.storeId, key: campaignKey(`${source.name} copy`), name: `${source.name} copy`.slice(0, 120), preset: source.preset,
    state: 'DRAFT', offer: value.offer, creative: value.creative, startsAt: source.startsAt, endsAt: source.endsAt,
    timezone: source.timezone, createdBy: req.user?._id, updatedBy: req.user?._id,
  });
  logAudit({ req, action: 'CAMPAIGN_DUPLICATE', entityType: 'Campaign', entityId: copy._id, storeId: copy.storeId, after: auditSnapshot(copy, AUDIT_FIELDS), summary: `Copied from ${source.name}` });
  res.status(201).json(campaignView(copy));
});

exports.repair = asyncHandler(async (req, res) => {
  const campaign = await findCampaign(req);
  if (campaign.state === 'ARCHIVED') throw new ApiError('VALIDATION_ERROR', 'Restore this campaign before repairing it');
  const before = auditSnapshot(campaign, AUDIT_FIELDS);
  campaign.revision = Number(campaign.revision || 0) + 1;
  try { await syncCampaign(campaign, req, true); }
  catch (error) { campaign.state = 'FAILED'; campaign.lastError = String(error.message || 'Campaign repair failed').slice(0, 500); await campaign.save(); throw error; }
  logAudit({ req, action: 'CAMPAIGN_REPAIR', entityType: 'Campaign', entityId: campaign._id, storeId: campaign.storeId, before, after: auditSnapshot(campaign, AUDIT_FIELDS) });
  res.json(campaignView(await populatedCampaign(campaign._id, req.tenantFilter)));
});

exports.readiness = readiness;
exports.performanceFor = performanceFor;
