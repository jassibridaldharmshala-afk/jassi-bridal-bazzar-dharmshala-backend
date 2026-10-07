const mongoose = require('mongoose');
const Review = require('../models/Review');
const ReviewVote = require('../models/ReviewVote');
const ReviewReport = require('../models/ReviewReport');
const Product = require('../models/Product');
const Order = require('../models/Order');
const User = require('../models/User');
const { asyncHandler } = require('../middleware/validate');
const { ApiError, forbidden, notFound } = require('../utils/apiError');
const {
  buildPaginatedResponse, optionalString, readPagination, requireArray,
  requireBoolean, requireEnum, requireObjectId, requireRating, requireString, wantsPagination,
} = require('../utils/validators');
const { andFilter } = require('../services/storeService');
const { isMasterOwner } = require('../config/masterOwner');
const { analyseReview } = require('../services/reviewIntelligenceService');
const { logAudit } = require('../services/auditService');
const { notifyLater } = require('../services/notificationService');

const REVIEWABLE_ORDER_STATUSES = ['Delivered', 'Return Requested', 'Exchange Requested', 'Returned', 'Refunded'];
const MODERATION_STATUSES = ['PENDING', 'PUBLISHED', 'HIDDEN', 'REJECTED', 'ARCHIVED'];
const REPORT_REASONS = ['SPAM', 'ABUSE', 'PRIVACY', 'IRRELEVANT', 'OTHER'];
const BULK_ACTIONS = ['PUBLISH', 'HIDE', 'ARCHIVE', 'RESTORE', 'FEATURE', 'UNFEATURE'];
const MANAGEMENT_SORTS = { oldest: { createdAt: 1 }, rating_high: { rating: -1, createdAt: -1 }, rating_low: { rating: 1, createdAt: -1 }, helpful: { helpfulCount: -1, createdAt: -1 }, reported: { reportCount: -1, createdAt: -1 } };
const ratingLocks = new Map();

function escapedRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizedStatus(review) {
  if (review?.archivedAt || review?.moderationStatus === 'ARCHIVED') return 'ARCHIVED';
  if (review?.isVisible === false && (!review?.moderationStatus || review.moderationStatus === 'PUBLISHED')) return 'HIDDEN';
  return review?.moderationStatus || (review?.isVisible ? 'PUBLISHED' : 'HIDDEN');
}

function publicReviewResponse(review) {
  if (!review) return null;
  const value = typeof review.toObject === 'function' ? review.toObject() : { ...review };
  delete value.helpfulBy;
  delete value.moderationNote;
  delete value.moderatedBy;
  delete value.riskSignals;
  delete value.archivedAt;
  delete value.withdrawnAt;
  delete value.storeId;
  delete value.merchantReplyHistory;
  value.helpfulCount = Math.max(0, Number(value.helpfulCount || 0));
  value.moderationStatus = normalizedStatus(value);
  if (value.merchantReply) delete value.merchantReply.repliedBy;
  return value;
}

function maskPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 4 ? `XXXXXX${digits.slice(-4)}` : '';
}

function managementReviewResponse(review) {
  const value = typeof review?.toObject === 'function' ? review.toObject() : { ...(review || {}) };
  delete value.helpfulBy;
  delete value.moderationNote;
  value.moderationStatus = normalizedStatus(value);
  value.helpfulCount = Math.max(0, Number(value.helpfulCount || 0));
  value.reportCount = Math.max(0, Number(value.reportCount || 0));
  if (value.user) {
    value.user.phoneMasked = maskPhone(value.user.phone);
    delete value.user.phone;
  }
  if (value.product?.images?.length) value.product.images = value.product.images.slice(0, 1);
  return value;
}

function managementScope(req) {
  if (String(req.query?.scope || '').toLowerCase() === 'all' && isMasterOwner(req.user)) return {};
  return req.tenantFilter || {};
}

function safePhotos(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 4) throw new ApiError('VALIDATION_ERROR', 'Choose up to 4 review photos');
  return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean).map((url) => {
    if (url.length > 2048 || (!/^https:\/\//i.test(url) && !/^\/uploads\/[a-z0-9_.-]+$/i.test(url))) {
      throw new ApiError('VALIDATION_ERROR', 'Review photos must be uploaded images');
    }
    return url;
  }))];
}

function optionalAspect(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  return requireRating(value, field);
}

function reviewInput(body = {}) {
  const rating = requireRating(body.rating);
  const title = optionalString(body.title, 'title', { max: 120 });
  const comment = optionalString(body.comment, 'comment', { max: 2000 });
  const photos = safePhotos(body.photos);
  const aspects = {
    quality: optionalAspect(body.aspects?.quality, 'quality rating'),
    fit: optionalAspect(body.aspects?.fit, 'fit rating'),
    colorAccuracy: optionalAspect(body.aspects?.colorAccuracy, 'colour accuracy rating'),
  };
  Object.keys(aspects).forEach((key) => aspects[key] === undefined && delete aspects[key]);
  const recommend = body.recommend === undefined || body.recommend === null || body.recommend === ''
    ? undefined : requireBoolean(body.recommend, 'recommend');
  return { rating, title, comment, photos, aspects, recommend, intelligence: analyseReview({ rating, title, comment }) };
}

function purchaseSnapshot(order, productId) {
  const item = (order?.orderItems || []).find((entry) => String(entry.product) === String(productId));
  return item ? { size: item.size || '', color: item.color || '', variantId: item.variantId || '' } : {};
}

function ratingScope(productId, storeId) {
  const filter = { product: new mongoose.Types.ObjectId(String(productId)), isVisible: true };
  if (storeId && mongoose.Types.ObjectId.isValid(storeId)) filter.storeId = new mongoose.Types.ObjectId(String(storeId));
  return filter;
}

async function recomputeProductRatingNow(productId, storeId) {
  const stats = await Review.aggregate([
    { $match: ratingScope(productId, storeId) },
    { $group: { _id: '$product', rating: { $avg: '$rating' }, numReviews: { $sum: 1 } } },
  ]);
  const productFilter = { _id: productId };
  if (storeId) productFilter.storeId = storeId;
  await Product.updateOne(productFilter, {
    rating: stats[0] ? Math.round(Number(stats[0].rating) * 10) / 10 : 0,
    numReviews: stats[0]?.numReviews || 0,
  });
}

function recomputeProductRating(productId, storeId) {
  const key = `${storeId || 'legacy'}:${productId}`;
  const previous = ratingLocks.get(key) || Promise.resolve();
  const next = previous.catch(() => null).then(() => recomputeProductRatingNow(productId, storeId));
  ratingLocks.set(key, next);
  return next.finally(() => { if (ratingLocks.get(key) === next) ratingLocks.delete(key); });
}

async function syncRating(review) {
  try {
    await recomputeProductRating(review.product, review.storeId);
    return true;
  } catch {
    setImmediate(() => recomputeProductRating(review.product, review.storeId).catch(() => null));
    return false;
  }
}

function purchaseFilter(userId, productId, tenantFilter = {}) {
  return andFilter({ user: userId, orderStatus: { $in: REVIEWABLE_ORDER_STATUSES }, 'orderItems.product': productId }, tenantFilter);
}

async function findDeliveredPurchase(userId, productId, tenantFilter) {
  return Order.findOne(purchaseFilter(userId, productId, tenantFilter)).sort('-deliveredAt -createdAt');
}

async function requireDeliveredPurchase(userId, productId, tenantFilter) {
  const order = await findDeliveredPurchase(userId, productId, tenantFilter);
  if (!order) throw forbidden('You can leave a review after you have received this product from a delivered order');
  return order;
}

async function requireProduct(productId, tenantFilter) {
  const product = await Product.findOne(andFilter({ _id: productId }, tenantFilter)).select('_id storeId');
  if (!product) throw notFound('Product not found');
  return product;
}

function applyIntelligence(review, input, { preserveModeration = false } = {}) {
  review.sentiment = input.intelligence.sentiment;
  review.topics = input.intelligence.topics;
  review.riskSignals = input.intelligence.riskSignals;
  if (input.intelligence.needsModeration) {
    review.moderationStatus = 'PENDING';
    review.isVisible = false;
    review.moderationReason = 'Automatic safety review required';
  } else if (!preserveModeration || ['PENDING', 'ARCHIVED'].includes(normalizedStatus(review))) {
    review.moderationStatus = 'PUBLISHED';
    review.isVisible = true;
    review.moderationReason = '';
    review.archivedAt = undefined;
    review.withdrawnAt = undefined;
  }
}

exports.createReview = asyncHandler(async (req, res) => {
  const productId = requireObjectId(req.params.productId, 'product id');
  const input = reviewInput(req.body);
  const product = await requireProduct(productId, req.tenantFilter);
  const order = await requireDeliveredPurchase(req.user._id, productId, req.tenantFilter);
  const storeId = order.storeId || product.storeId;
  const existing = await Review.findOne(andFilter({ user: req.user._id, product: productId }, storeId ? { storeId } : {}));
  if (existing) throw new ApiError('DUPLICATE_REQUEST', 'You have already reviewed this product. You can edit your existing review.');
  const recentReviewCount = await Review.countDocuments(andFilter({
    user: req.user._id,
    createdAt: { $gte: new Date(Date.now() - 60 * 60 * 1000) },
  }, storeId ? { storeId } : {}));
  if (recentReviewCount >= 5) {
    input.intelligence.riskSignals = [...new Set([...(input.intelligence.riskSignals || []), 'HIGH_REVIEW_VELOCITY'])];
    input.intelligence.needsModeration = true;
  }
  try {
    const review = new Review({
      user: req.user._id, product: productId, order: order._id, rating: input.rating,
      title: input.title, comment: input.comment, photos: input.photos || [], aspects: input.aspects,
      recommend: input.recommend, purchase: purchaseSnapshot(order, productId), verifiedPurchase: true, storeId,
    });
    applyIntelligence(review, input);
    await review.save();
    const ratingSynced = await syncRating(review);
    await logAudit({ req, action: 'REVIEW_SUBMITTED', entityType: 'Review', entityId: review._id, storeId: review.storeId, after: { rating: review.rating, moderationStatus: normalizedStatus(review), sentiment: review.sentiment, topics: review.topics, photoCount: review.photos.length } });
    notifyLater({
      userId: req.user._id, storeId: review.storeId, event: 'REVIEW_SUBMITTED',
      title: review.isVisible ? 'Review published' : 'Review received',
      message: review.isVisible ? 'Thank you. Your verified review is now visible.' : 'Thank you. Your review is waiting for a quick safety check.',
      metadata: { reviewId: String(review._id), productId: String(productId) },
      adminEvent: review.rating <= 2 ? 'REVIEW_NEGATIVE' : 'REVIEW_SUBMITTED',
    });
    res.status(201).json({ ...publicReviewResponse(review), ratingSynced });
  } catch (error) {
    if (error?.code === 11000) throw new ApiError('DUPLICATE_REQUEST', 'You have already reviewed this product. You can edit your existing review.');
    throw error;
  }
});

exports.updateReview = asyncHandler(async (req, res) => {
  const reviewId = requireObjectId(req.params.id, 'review id');
  const review = await Review.findOne(andFilter({ _id: reviewId }, req.tenantFilter));
  if (!review) throw notFound('Review not found');
  if (String(review.user) !== String(req.user._id)) throw forbidden('Only the customer who wrote this review can edit its rating or wording');
  const input = reviewInput({ ...review.toObject(), ...req.body, aspects: { ...(review.aspects?.toObject?.() || review.aspects || {}), ...(req.body?.aspects || {}) } });
  const before = { rating: review.rating, moderationStatus: normalizedStatus(review), photoCount: review.photos?.length || 0 };
  review.rating = input.rating; review.title = input.title; review.comment = input.comment;
  if (input.photos !== undefined) review.photos = input.photos;
  review.aspects = input.aspects;
  if (input.recommend !== undefined) review.recommend = input.recommend;
  review.editedAt = new Date();
  applyIntelligence(review, input, { preserveModeration: true });
  await review.save();
  const ratingSynced = await syncRating(review);
  await logAudit({ req, action: 'REVIEW_UPDATED', entityType: 'Review', entityId: review._id, storeId: review.storeId, before, after: { rating: review.rating, moderationStatus: normalizedStatus(review), photoCount: review.photos?.length || 0 } });
  res.json({ ...publicReviewResponse(review), ratingSynced });
});

exports.withdrawMyReview = asyncHandler(async (req, res) => {
  const reviewId = requireObjectId(req.params.id, 'review id');
  const review = await Review.findOne(andFilter({ _id: reviewId, user: req.user._id }, req.tenantFilter));
  if (!review) throw notFound('Review not found');
  const before = { moderationStatus: normalizedStatus(review), isVisible: review.isVisible };
  review.moderationStatus = 'ARCHIVED'; review.isVisible = false; review.isFeatured = false;
  review.archivedAt = new Date(); review.withdrawnAt = new Date();
  await review.save(); await syncRating(review);
  await logAudit({ req, action: 'REVIEW_WITHDRAWN', entityType: 'Review', entityId: review._id, storeId: review.storeId, before, after: { moderationStatus: 'ARCHIVED', isVisible: false } });
  res.json({ success: true, review: publicReviewResponse(review) });
});

exports.getMyReview = asyncHandler(async (req, res) => {
  const productId = requireObjectId(req.params.productId, 'product id');
  await requireProduct(productId, req.tenantFilter);
  const review = await Review.findOne(andFilter({ user: req.user._id, product: productId }, req.tenantFilter));
  res.json(publicReviewResponse(review));
});

exports.getReviewEligibility = asyncHandler(async (req, res) => {
  const productId = requireObjectId(req.params.productId, 'product id');
  await requireProduct(productId, req.tenantFilter);
  const [existingReview, order, votes, legacyHelpful] = await Promise.all([
    Review.findOne(andFilter({ user: req.user._id, product: productId }, req.tenantFilter)),
    findDeliveredPurchase(req.user._id, productId, req.tenantFilter),
    ReviewVote.find(andFilter({ user: req.user._id }, req.tenantFilter)).populate({ path: 'review', match: { product: productId }, select: '_id' }),
    Review.find(andFilter({ product: productId, helpfulBy: req.user._id }, req.tenantFilter)).select('_id'),
  ]);
  const helpfulReviewIds = [...new Set([...votes.filter((item) => item.review).map((item) => String(item.review._id)), ...legacyHelpful.map((item) => String(item._id))])];
  const canEdit = Boolean(existingReview); const hasDeliveredPurchase = Boolean(order);
  res.json({
    canReview: canEdit || hasDeliveredPurchase, canEdit, hasDeliveredPurchase,
    orderId: order?._id || existingReview?.order || null, existingReview: publicReviewResponse(existingReview), helpfulReviewIds,
    reason: canEdit || hasDeliveredPurchase ? null : 'DELIVERY_REQUIRED',
    message: canEdit ? 'You can edit or resubmit your existing review.' : hasDeliveredPurchase ? 'Your delivered purchase is eligible for a verified review.' : 'You can review this product after it has been delivered.',
  });
});

exports.getReviewSummary = asyncHandler(async (req, res) => {
  const productId = requireObjectId(req.params.productId, 'product id');
  await requireProduct(productId, req.tenantFilter);
  const rows = await Review.aggregate([
    { $match: andFilter({ product: new mongoose.Types.ObjectId(productId), isVisible: true }, req.tenantFilter) },
    { $group: { _id: '$rating', count: { $sum: 1 } } },
  ]);
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  rows.forEach((row) => { distribution[row._id] = Number(row.count || 0); });
  const total = Object.values(distribution).reduce((sum, count) => sum + count, 0);
  const weightedTotal = Object.entries(distribution).reduce((sum, [rating, count]) => sum + Number(rating) * count, 0);
  const recommended = distribution[4] + distribution[5];
  res.json({ average: total ? Math.round((weightedTotal / total) * 10) / 10 : 0, total, distribution, recommendationPercentage: total ? Math.round((recommended / total) * 100) : 0 });
});

exports.getReviews = asyncHandler(async (req, res) => {
  const productId = requireObjectId(req.params.productId, 'product id');
  await requireProduct(productId, req.tenantFilter);
  const { page, limit, skip } = readPagination(req.query, { defaultLimit: 20, maxLimit: 100 });
  const filter = andFilter({ product: productId, isVisible: true }, req.tenantFilter);
  if (req.query.rating !== undefined && String(req.query.rating).trim()) filter.rating = requireRating(req.query.rating);
  const sort = req.query.sort === 'highest' ? { rating: -1, createdAt: -1 }
    : req.query.sort === 'lowest' ? { rating: 1, createdAt: -1 }
      : req.query.sort === 'helpful' ? { helpfulCount: -1, createdAt: -1 } : { createdAt: -1 };
  const finder = () => Review.find(filter).select('-helpfulBy -moderationNote -riskSignals').populate('user', 'name').sort(sort);
  const items = await finder().skip(skip).limit(limit);
  if (!wantsPagination(req.query)) return res.json(items.map(publicReviewResponse));
  const total = await Review.countDocuments(filter);
  return res.json(buildPaginatedResponse(items.map(publicReviewResponse), { page, limit, total }));
});

exports.toggleHelpful = asyncHandler(async (req, res) => {
  const reviewId = requireObjectId(req.params.id, 'review id');
  const review = await Review.findOne(andFilter({ _id: reviewId, isVisible: true }, req.tenantFilter)).select('+helpfulBy');
  if (!review) throw notFound('Review not found');
  if (String(review.user) === String(req.user._id)) throw forbidden('You cannot mark your own review as helpful');
  const desired = req.body?.helpful === undefined ? null : requireBoolean(req.body.helpful, 'helpful');
  const voteFilter = { review: review._id, user: req.user._id };
  const existingVote = await ReviewVote.findOne(voteFilter);
  const legacyHelpful = (review.helpfulBy || []).some((id) => String(id) === String(req.user._id));
  const currentlyHelpful = Boolean(existingVote || legacyHelpful);
  const helpful = desired === null ? !currentlyHelpful : desired;
  let delta = 0;
  if (helpful && !currentlyHelpful) {
    const recentVotes = await ReviewVote.countDocuments({ user: req.user._id, createdAt: { $gte: new Date(Date.now() - 10 * 60 * 1000) } });
    if (recentVotes >= 20) throw new ApiError('RATE_LIMITED', 'Too many helpful votes. Please try again later.', { statusCode: 429 });
    try { await ReviewVote.create({ ...voteFilter, storeId: review.storeId }); delta = 1; }
    catch (error) { if (error?.code !== 11000) throw error; }
  } else if (!helpful && currentlyHelpful) {
    const removed = await ReviewVote.deleteOne(voteFilter);
    if (legacyHelpful) review.helpfulBy.pull(req.user._id);
    if (removed.deletedCount || legacyHelpful) delta = -1;
  }
  if (legacyHelpful) await Review.updateOne({ _id: review._id }, { $pull: { helpfulBy: req.user._id } });
  if (delta) await Review.updateOne({ _id: review._id }, { $inc: { helpfulCount: delta } });
  const refreshed = await Review.findById(review._id).select('helpfulCount');
  if (Number(refreshed?.helpfulCount) < 0) await Review.updateOne({ _id: review._id }, { helpfulCount: 0 });
  res.json({ reviewId: review._id, helpful, helpfulCount: Math.max(0, Number(refreshed?.helpfulCount || 0)) });
});

exports.reportReview = asyncHandler(async (req, res) => {
  const reviewId = requireObjectId(req.params.id, 'review id');
  const review = await Review.findOne(andFilter({ _id: reviewId, isVisible: true }, req.tenantFilter));
  if (!review) throw notFound('Review not found');
  if (String(review.user) === String(req.user._id)) throw forbidden('You cannot report your own review');
  const reason = requireEnum(req.body?.reason, REPORT_REASONS, 'report reason');
  const details = optionalString(req.body?.details, 'details', { max: 500 });
  try {
    await ReviewReport.create({ review: review._id, reporter: req.user._id, reason, details, storeId: review.storeId });
  } catch (error) {
    if (error?.code === 11000) throw new ApiError('DUPLICATE_REQUEST', 'You have already reported this review');
    throw error;
  }
  const reportCount = await ReviewReport.countDocuments({ review: review._id, status: 'OPEN' });
  const update = { reportCount };
  if (reportCount >= 3) Object.assign(update, { moderationStatus: 'PENDING', isVisible: false, moderationReason: 'Multiple customer reports require review' });
  await Review.updateOne({ _id: review._id }, update);
  if (reportCount >= 3) await syncRating({ product: review.product, storeId: review.storeId });
  await logAudit({ req, action: 'REVIEW_REPORTED', entityType: 'Review', entityId: review._id, storeId: review.storeId, after: { reason, reportCount } });
  notifyLater({ storeId: review.storeId, event: 'REVIEW_REPORTED', title: 'Review reported', message: 'A customer review needs moderation.', metadata: { reviewId: String(review._id), productId: String(review.product) } });
  res.status(201).json({ success: true, message: 'Thank you. The review was sent for moderation.' });
});

exports.featuredReviews = asyncHandler(async (req, res) => {
  const { limit, skip } = readPagination(req.query, { defaultLimit: 3, maxLimit: 12 });
  const filter = andFilter({ isVisible: true, comment: { $exists: true, $nin: ['', null] } }, req.tenantFilter);
  if (String(req.query.curatedOnly || '') === 'true') filter.isFeatured = true;
  const reviews = await Review.find(filter).select('-helpfulBy -moderationNote -riskSignals').populate('user', 'name').populate('product', 'name slug').sort({ isFeatured: -1, rating: -1, helpfulCount: -1, createdAt: -1 }).skip(skip).limit(limit);
  res.json(reviews.map(publicReviewResponse));
});

async function managementFilter(req) {
  const scope = managementScope(req);
  const clauses = [];
  if (Object.keys(scope).length) clauses.push(scope);
  const status = String(req.query.status || '').toUpperCase();
  if (status) {
    requireEnum(status, MODERATION_STATUSES, 'status');
    if (status === 'PUBLISHED') clauses.push({ isVisible: true, moderationStatus: { $ne: 'ARCHIVED' } });
    else if (status === 'HIDDEN') clauses.push({ $or: [{ moderationStatus: 'HIDDEN' }, { isVisible: false, moderationStatus: { $exists: false } }] });
    else clauses.push({ moderationStatus: status });
  }
  if (req.query.rating) clauses.push({ rating: requireRating(req.query.rating) });
  if (req.query.verified) clauses.push({ verifiedPurchase: requireBoolean(req.query.verified, 'verified') });
  if (req.query.media) clauses.push(requireBoolean(req.query.media, 'media') ? { 'photos.0': { $exists: true } } : { 'photos.0': { $exists: false } });
  if (req.query.reported === 'true') clauses.push({ reportCount: { $gt: 0 } });
  if (req.query.unanswered === 'true') clauses.push({ 'merchantReply.body': { $in: ['', null] } });
  if (req.query.sentiment) clauses.push({ sentiment: requireEnum(String(req.query.sentiment).toUpperCase(), ['POSITIVE', 'NEUTRAL', 'NEGATIVE'], 'sentiment') });
  if (req.query.productId) clauses.push({ product: requireObjectId(req.query.productId, 'product id') });
  const date = {};
  if (req.query.from) { const parsed = new Date(req.query.from); if (!Number.isFinite(parsed.getTime())) throw new ApiError('VALIDATION_ERROR', 'Invalid from date'); date.$gte = parsed; }
  if (req.query.to) { const parsed = new Date(req.query.to); if (!Number.isFinite(parsed.getTime())) throw new ApiError('VALIDATION_ERROR', 'Invalid to date'); parsed.setHours(23, 59, 59, 999); date.$lte = parsed; }
  if (Object.keys(date).length) clauses.push({ createdAt: date });
  const search = String(req.query.search || '').trim();
  if (search) {
    const expression = new RegExp(escapedRegex(search.slice(0, 100)), 'i');
    const [products, users] = await Promise.all([
      Product.find(andFilter({ $or: [{ name: expression }, { sku: expression }] }, scope)).select('_id').limit(100).lean(),
      User.find({ $or: [{ name: expression }, { phone: expression }] }).select('_id').limit(100).lean(),
    ]);
    clauses.push({ $or: [{ title: expression }, { comment: expression }, { product: { $in: products.map((item) => item._id) } }, { user: { $in: users.map((item) => item._id) } }] });
  }
  return clauses.length === 0 ? {} : clauses.length === 1 ? clauses[0] : { $and: clauses };
}

exports.adminReviews = asyncHandler(async (req, res) => {
  const { page, limit, skip } = readPagination(req.query, { defaultLimit: 25, maxLimit: 500 });
  const filter = await managementFilter(req);
  const reviews = await Review.find(filter).select('-helpfulBy -moderationNote')
    .populate('user', 'name phone').populate('product', 'name slug sku images primaryImage').populate('storeId', 'name slug')
    .sort(MANAGEMENT_SORTS[req.query.sort] || { createdAt: -1 }).skip(skip).limit(limit);
  const items = reviews.map(managementReviewResponse);
  if (!wantsPagination(req.query)) return res.json(items);
  res.json(buildPaginatedResponse(items, { page, limit, total: await Review.countDocuments(filter) }));
});

exports.adminReviewExport = asyncHandler(async (req, res) => {
  const filter = await managementFilter(req);
  const limit = Math.min(1000, Math.max(1, Number.parseInt(req.query.limit, 10) || 500));
  const [reviews, total] = await Promise.all([
    Review.find(filter).select('-helpfulBy -moderationNote -riskSignals')
      .populate('user', 'name phone').populate('product', 'name slug sku').populate('storeId', 'name slug')
      .sort(MANAGEMENT_SORTS[req.query.sort] || { createdAt: -1 }).limit(limit),
    Review.countDocuments(filter),
  ]);
  res.json({ items: reviews.map(managementReviewResponse), total, limited: total > reviews.length });
});

exports.adminReviewOptions = asyncHandler(async (req, res) => {
  const scope = managementScope(req);
  const rows = await Review.aggregate([
    ...(Object.keys(scope).length ? [{ $match: scope }] : []),
    { $group: { _id: '$product', reviewCount: { $sum: 1 } } },
    { $sort: { reviewCount: -1 } },
    { $limit: 250 },
  ]);
  const products = await Product.find({ _id: { $in: rows.map((item) => item._id) } })
    .select('name sku storeId').populate('storeId', 'name slug').lean();
  const counts = new Map(rows.map((item) => [String(item._id), Number(item.reviewCount || 0)]));
  res.json(products.map((product) => ({
    id: product._id,
    name: product.name,
    sku: product.sku || '',
    store: product.storeId ? { id: product.storeId._id, name: product.storeId.name, slug: product.storeId.slug } : null,
    reviewCount: counts.get(String(product._id)) || 0,
  })).sort((left, right) => right.reviewCount - left.reviewCount || String(left.name).localeCompare(String(right.name))));
});

exports.adminReviewStats = asyncHandler(async (req, res) => {
  const filter = managementScope(req);
  const match = Object.keys(filter).length ? filter : {};
  const [rows, trend, topics, productHealth] = await Promise.all([
    Review.aggregate([{ $match: match }, { $group: { _id: null, total: { $sum: 1 }, ratingTotal: { $sum: '$rating' }, published: { $sum: { $cond: ['$isVisible', 1, 0] } }, pending: { $sum: { $cond: [{ $eq: ['$moderationStatus', 'PENDING'] }, 1, 0] } }, hidden: { $sum: { $cond: [{ $eq: ['$moderationStatus', 'HIDDEN'] }, 1, 0] } }, rejected: { $sum: { $cond: [{ $eq: ['$moderationStatus', 'REJECTED'] }, 1, 0] } }, archived: { $sum: { $cond: [{ $eq: ['$moderationStatus', 'ARCHIVED'] }, 1, 0] } }, negative: { $sum: { $cond: [{ $lte: ['$rating', 2] }, 1, 0] } }, reported: { $sum: { $cond: [{ $gt: ['$reportCount', 0] }, 1, 0] } }, answered: { $sum: { $cond: [{ $gt: [{ $strLenCP: { $ifNull: ['$merchantReply.body', ''] } }, 0] }, 1, 0] } } } }]),
    Review.aggregate([{ $match: andFilter({ createdAt: { $gte: new Date(Date.now() - 30 * 86400000) } }, match) }, { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, average: { $avg: '$rating' }, count: { $sum: 1 } } }, { $sort: { _id: 1 } }]),
    Review.aggregate([{ $match: match }, { $unwind: '$topics' }, { $group: { _id: '$topics', count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 6 }]),
    Review.aggregate([
      { $match: match },
      { $group: { _id: '$product', average: { $avg: '$rating' }, count: { $sum: 1 }, negative: { $sum: { $cond: [{ $lte: ['$rating', 2] }, 1, 0] } } } },
      { $sort: { negative: -1, count: -1 } },
      { $limit: 8 },
      { $lookup: { from: Product.collection.name, localField: '_id', foreignField: '_id', as: 'product' } },
      { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
      { $project: { _id: 0, productId: '$_id', name: { $ifNull: ['$product.name', 'Unavailable product'] }, sku: { $ifNull: ['$product.sku', ''] }, average: { $round: ['$average', 1] }, count: 1, negative: 1 } },
    ]),
  ]);
  const data = rows[0] || {};
  const total = Number(data.total || 0); const answered = Number(data.answered || 0);
  res.json({ total, average: total ? Math.round((Number(data.ratingTotal || 0) / total) * 10) / 10 : 0, published: Number(data.published || 0), pending: Number(data.pending || 0), hidden: Number(data.hidden || 0), rejected: Number(data.rejected || 0), archived: Number(data.archived || 0), negative: Number(data.negative || 0), reported: Number(data.reported || 0), unanswered: Math.max(0, total - answered), responseRate: total ? Math.round((answered / total) * 100) : 0, trend: trend.map((item) => ({ date: item._id, average: Math.round(Number(item.average || 0) * 10) / 10, count: item.count })), topics: topics.map((item) => ({ topic: item._id, count: item.count })), productHealth });
});

exports.adminReviewDetail = asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id, 'review id');
  const review = await Review.findOne(andFilter({ _id: id }, managementScope(req))).select('+moderationNote +merchantReplyHistory -helpfulBy')
    .populate('user', 'name phone').populate('product', 'name slug sku images primaryImage').populate('storeId', 'name slug')
    .populate('order', 'invoiceNumber orderStatus paymentMethod deliveredAt createdAt orderItems');
  if (!review) throw notFound('Review not found');
  const reports = await ReviewReport.find(andFilter({ review: review._id }, managementScope(req))).populate('reporter', 'name').sort('-createdAt').lean();
  const value = managementReviewResponse(review);
  value.moderationNote = review.moderationNote || '';
  value.reports = reports;
  res.json(value);
});

async function moderate(review, { status, reason, note, actor, featured }) {
  if (status) {
    review.moderationStatus = status; review.isVisible = status === 'PUBLISHED';
    review.moderationReason = reason || ''; review.moderationNote = note || '';
    review.moderatedBy = actor; review.moderatedAt = new Date();
    if (status === 'ARCHIVED') { review.archivedAt = new Date(); review.isFeatured = false; } else review.archivedAt = undefined;
  }
  if (featured !== undefined) {
    if (featured && normalizedStatus(review) !== 'PUBLISHED') throw new ApiError('VALIDATION_ERROR', 'Publish the review before featuring it');
    review.isFeatured = featured;
  }
  await review.save();
  if (status && ['PUBLISHED', 'HIDDEN', 'REJECTED'].includes(status)) {
    await ReviewReport.updateMany({ review: review._id, status: 'OPEN' }, { status: 'RESOLVED', resolvedBy: actor, resolutionNote: note || reason || '', resolvedAt: new Date() });
  }
  return review;
}

exports.moderateReview = asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id, 'review id');
  const review = await Review.findOne(andFilter({ _id: id }, managementScope(req))).select('+moderationNote');
  if (!review) throw notFound('Review not found');
  const status = requireEnum(String(req.body?.status || '').toUpperCase(), ['PENDING', 'PUBLISHED', 'HIDDEN', 'REJECTED'], 'status');
  const reason = optionalString(req.body?.reason, 'reason', { max: 300 });
  const note = optionalString(req.body?.note, 'moderation note', { max: 1000 });
  if (['HIDDEN', 'REJECTED'].includes(status) && !reason) throw new ApiError('VALIDATION_ERROR', 'Add a reason before hiding or rejecting a review');
  const before = { moderationStatus: normalizedStatus(review), isVisible: review.isVisible, isFeatured: review.isFeatured };
  await moderate(review, { status, reason, note, actor: req.user._id }); await syncRating(review);
  await logAudit({ req, action: 'REVIEW_MODERATED', entityType: 'Review', entityId: review._id, storeId: review.storeId, before, after: { moderationStatus: status, isVisible: review.isVisible, reason } });
  notifyLater({ userId: review.user, storeId: review.storeId, event: 'REVIEW_MODERATED', title: status === 'PUBLISHED' ? 'Review published' : 'Review update', message: status === 'PUBLISHED' ? 'Your review is now visible to shoppers.' : `Your review is not currently public${reason ? `: ${reason}` : '.'}`, metadata: { reviewId: String(review._id), productId: String(review.product) } });
  res.json(managementReviewResponse(review));
});

exports.toggleVisibility = asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id, 'review id');
  const review = await Review.findOne(andFilter({ _id: id }, managementScope(req))).select('+moderationNote');
  if (!review) throw notFound('Review not found');
  const isVisible = requireBoolean(req.body?.isVisible, 'isVisible');
  const status = isVisible ? 'PUBLISHED' : 'HIDDEN';
  await moderate(review, { status, reason: optionalString(req.body?.reason, 'reason', { max: 300 }) || (isVisible ? '' : 'Hidden by store team'), actor: req.user._id });
  await syncRating(review);
  await logAudit({ req, action: 'REVIEW_MODERATED', entityType: 'Review', entityId: review._id, storeId: review.storeId, after: { moderationStatus: status, isVisible } });
  res.json(managementReviewResponse(review));
});

exports.archiveReview = asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id, 'review id');
  const review = await Review.findOne(andFilter({ _id: id }, managementScope(req))).select('+moderationNote');
  if (!review) throw notFound('Review not found');
  const before = { moderationStatus: normalizedStatus(review), isVisible: review.isVisible };
  await moderate(review, { status: 'ARCHIVED', reason: optionalString(req.body?.reason, 'reason', { max: 300 }) || 'Archived by store team', note: optionalString(req.body?.note, 'note', { max: 1000 }), actor: req.user._id });
  await syncRating(review);
  await logAudit({ req, action: 'REVIEW_ARCHIVED', entityType: 'Review', entityId: review._id, storeId: review.storeId, before, after: { moderationStatus: 'ARCHIVED', isVisible: false } });
  res.json(managementReviewResponse(review));
});

exports.restoreReview = asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id, 'review id');
  const review = await Review.findOne(andFilter({ _id: id, moderationStatus: 'ARCHIVED' }, managementScope(req))).select('+moderationNote');
  if (!review) throw notFound('Archived review not found');
  await moderate(review, { status: 'PENDING', reason: 'Restored for moderation', note: optionalString(req.body?.note, 'note', { max: 1000 }), actor: req.user._id });
  await logAudit({ req, action: 'REVIEW_RESTORED', entityType: 'Review', entityId: review._id, storeId: review.storeId, after: { moderationStatus: 'PENDING', isVisible: false } });
  res.json(managementReviewResponse(review));
});

exports.setFeatured = asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id, 'review id');
  const review = await Review.findOne(andFilter({ _id: id }, managementScope(req))).select('+moderationNote');
  if (!review) throw notFound('Review not found');
  const featured = requireBoolean(req.body?.featured, 'featured');
  const before = { isFeatured: review.isFeatured };
  await moderate(review, { featured, actor: req.user._id });
  await logAudit({ req, action: featured ? 'REVIEW_FEATURED' : 'REVIEW_UNFEATURED', entityType: 'Review', entityId: review._id, storeId: review.storeId, before, after: { isFeatured: featured } });
  res.json(managementReviewResponse(review));
});

exports.replyToReview = asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id, 'review id');
  const review = await Review.findOne(andFilter({ _id: id }, managementScope(req))).select('+merchantReplyHistory');
  if (!review) throw notFound('Review not found');
  const body = requireString(req.body?.body, 'reply', { max: 1000 });
  const before = { replied: Boolean(review.merchantReply?.body) }; const now = new Date();
  review.merchantReplyHistory = [...(review.merchantReplyHistory || []), { body, action: before.replied ? 'UPDATED' : 'PUBLISHED', actor: req.user._id, at: now }];
  review.merchantReply = { body, repliedBy: req.user._id, repliedAt: review.merchantReply?.repliedAt || now, editedAt: review.merchantReply?.body ? now : undefined };
  await review.save();
  await logAudit({ req, action: before.replied ? 'REVIEW_REPLY_UPDATED' : 'REVIEW_REPLIED', entityType: 'Review', entityId: review._id, storeId: review.storeId, before, after: { replied: true } });
  notifyLater({ userId: review.user, storeId: review.storeId, event: 'REVIEW_REPLIED', title: 'Store replied to your review', message: 'The store team responded to your product review.', metadata: { reviewId: String(review._id), productId: String(review.product) } });
  res.json(managementReviewResponse(review));
});

exports.deleteReply = asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id, 'review id');
  const review = await Review.findOne(andFilter({ _id: id }, managementScope(req))).select('+merchantReplyHistory');
  if (!review) throw notFound('Review not found');
  if (!review.merchantReply?.body) throw notFound('Store response not found');
  review.merchantReplyHistory = [...(review.merchantReplyHistory || []), { body: review.merchantReply.body, action: 'REMOVED', actor: req.user._id, at: new Date() }];
  review.merchantReply = undefined; await review.save();
  await logAudit({ req, action: 'REVIEW_REPLY_DELETED', entityType: 'Review', entityId: review._id, storeId: review.storeId, before: { replied: true }, after: { replied: false } });
  res.json(managementReviewResponse(review));
});

exports.bulkReviewAction = asyncHandler(async (req, res) => {
  const ids = [...new Set(requireArray(req.body?.ids, 'review ids', { max: 100 }).map((id) => requireObjectId(id, 'review id')))];
  const action = requireEnum(String(req.body?.action || '').toUpperCase(), BULK_ACTIONS, 'action');
  const reason = optionalString(req.body?.reason, 'reason', { max: 300 });
  if (action === 'HIDE' && !reason) throw new ApiError('VALIDATION_ERROR', 'Add a reason before hiding reviews');
  const reviews = await Review.find(andFilter({ _id: { $in: ids } }, managementScope(req))).select('+moderationNote');
  if (reviews.length !== ids.length) throw new ApiError('FORBIDDEN', 'One or more reviews are unavailable for this store');
  const affectedProducts = new Map();
  for (const review of reviews) {
    const before = { moderationStatus: normalizedStatus(review), isVisible: review.isVisible, isFeatured: review.isFeatured };
    if (action === 'FEATURE' || action === 'UNFEATURE') await moderate(review, { featured: action === 'FEATURE', actor: req.user._id });
    else {
      const status = { PUBLISH: 'PUBLISHED', HIDE: 'HIDDEN', ARCHIVE: 'ARCHIVED', RESTORE: 'PENDING' }[action];
      await moderate(review, { status, reason: reason || (action === 'ARCHIVE' ? 'Archived by store team' : action === 'RESTORE' ? 'Restored for moderation' : ''), actor: req.user._id });
      affectedProducts.set(String(review.product), review.storeId);
    }
    await logAudit({ req, action: `REVIEW_BULK_${action}`, entityType: 'Review', entityId: review._id, storeId: review.storeId, before, after: { moderationStatus: normalizedStatus(review), isVisible: review.isVisible, isFeatured: review.isFeatured } });
  }
  await Promise.all([...affectedProducts.entries()].map(([productId, storeId]) => recomputeProductRating(productId, storeId).catch(() => null)));
  res.json({ success: true, affected: reviews.length });
});

exports.sendReviewRequests = asyncHandler(async (req, res) => {
  const scope = managementScope(req);
  const days = Math.min(30, Math.max(1, Number.parseInt(req.body?.daysAfterDelivery, 10) || 3));
  const orders = await Order.find(andFilter({ orderStatus: { $in: REVIEWABLE_ORDER_STATUSES }, deliveredAt: { $lte: new Date(Date.now() - days * 86400000), $gte: new Date(Date.now() - 45 * 86400000) } }, scope)).select('user storeId orderItems invoiceNumber').sort('-deliveredAt').limit(100).lean();
  let sent = 0;
  for (const order of orders) {
    const productIds = [...new Set((order.orderItems || []).map((item) => String(item.product || '')).filter((id) => mongoose.Types.ObjectId.isValid(id)))];
    if (!productIds.length) continue;
    const reviewed = await Review.find(andFilter({ user: order.user, product: { $in: productIds } }, order.storeId ? { storeId: order.storeId } : {})).distinct('product');
    const reviewedIds = new Set(reviewed.map(String));
    const unreviewedProductId = productIds.find((productId) => !reviewedIds.has(productId));
    if (!unreviewedProductId) continue;
    notifyLater({ userId: order.user, storeId: order.storeId, event: 'REVIEW_REQUEST', title: 'How was your order?', message: `Share your experience with order ${order.invoiceNumber || String(order._id).slice(-8).toUpperCase()}.`, metadata: { orderId: String(order._id), productId: unreviewedProductId } });
    sent += 1;
  }
  await logAudit({ req, action: 'REVIEW_REQUESTS_SENT', entityType: 'Review', entityId: 'batch', storeId: req.store?._id, after: { sent, daysAfterDelivery: days } });
  res.json({ success: true, sent, checked: orders.length });
});

exports.deleteReview = asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id, 'review id');
  const review = await Review.findOne(andFilter({ _id: id }, managementScope(req))).select('+moderationNote');
  if (!review) throw notFound('Review not found');
  if (req.query.confirm !== 'PERMANENTLY_DELETE' || normalizedStatus(review) !== 'ARCHIVED') {
    throw new ApiError('VALIDATION_ERROR', 'Archive the review first, then confirm permanent deletion');
  }
  await Promise.all([ReviewVote.deleteMany({ review: review._id }), ReviewReport.deleteMany({ review: review._id }), review.deleteOne()]);
  await syncRating(review);
  await logAudit({ req, action: 'REVIEW_PERMANENTLY_DELETED', entityType: 'Review', entityId: review._id, storeId: review.storeId, before: { rating: review.rating, moderationStatus: normalizedStatus(review), reportCount: review.reportCount } });
  res.json({ success: true, message: 'Review permanently deleted' });
});

exports.recomputeProductRating = recomputeProductRating;
exports.MODERATION_STATUSES = MODERATION_STATUSES;
