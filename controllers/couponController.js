const mongoose = require('mongoose');
const Coupon = require('../models/Coupon');
const Product = require('../models/Product');
const Category = require('../models/Category');
const User = require('../models/User');
const Order = require('../models/Order');
const CustomerCrm = require('../models/CustomerCrm');
const Cart = require('../models/Cart');
const couponService = require('../services/couponService');
const { asyncHandler } = require('../middleware/validate');
const { ApiError, notFound } = require('../utils/apiError');
const {
  buildPaginatedResponse,
  optionalString,
  readPagination,
  requireBoolean,
  requireCouponCode,
  requireEnum,
  requireObjectId,
  wantsPagination,
} = require('../utils/validators');
const { andFilter } = require('../services/storeService');
const { logAudit } = require('../services/auditService');
const { auditSnapshot } = require('../utils/auditData');
const COUPON_AUDIT_FIELDS = ['code', 'campaignId', 'activationMode', 'benefitType', 'type', 'discountValue', 'buyQuantity', 'getQuantity', 'minOrderAmount', 'minItemQuantity', 'maxDiscountAmount', 'validFrom', 'expiryDate', 'usageLimit', 'customerLimit', 'firstOrderOnly', 'restoreOnFullRefund', 'customerSegment', 'minimumPriorOrders', 'minimumLifetimeSpend', 'inactiveDays', 'priority', 'stackingMode', 'scopeMatchMode', 'minimumRequirementBasis', 'totalBudget', 'isActive', 'isPublic', 'isArchived', 'applicablePaymentMethods', 'applicableProducts', 'applicableCategories', 'applicableCustomers', 'applicablePincodes', 'salesChannels'];

const PAYMENT_METHODS = ['COD', 'UPI', 'CARD', 'NETBANKING', 'WALLET', 'RAZORPAY'];

function livePublicQuery(now = new Date()) {
  return {
    $and: [
      { isActive: true },
      { isArchived: { $ne: true } },
      { isPublic: { $ne: false } },
      { $or: [{ expiryDate: { $exists: false } }, { expiryDate: null }, { expiryDate: { $gte: now } }] },
      { $or: [{ validFrom: { $exists: false } }, { validFrom: null }, { validFrom: { $lte: now } }] },
      {
        $or: [
          { usageLimit: { $exists: false } },
          { usageLimit: null },
          { usageLimit: 0 },
          { $expr: { $lt: ['$usedCount', '$usageLimit'] } },
        ],
      },
      {
        $or: [
          { totalBudget: { $exists: false } },
          { totalBudget: null },
          { totalBudget: 0 },
          { $expr: { $lt: [{ $ifNull: ['$spentAmount', 0] }, '$totalBudget'] } },
        ],
      },
    ],
  };
}

function publicCouponView(coupon, eligibility = {}) {
  const value = typeof coupon?.toObject === 'function' ? coupon.toObject() : { ...(coupon || {}) };
  return {
    _id: value._id,
    code: value.code,
    title: value.title || '',
    description: value.description || '',
    terms: value.terms || '',
    type: value.type,
    discountValue: value.discountValue,
    activationMode: value.activationMode || 'CODE',
    benefitType: value.benefitType || 'DISCOUNT',
    buyQuantity: value.buyQuantity || 1,
    getQuantity: value.getQuantity || 1,
    minOrderAmount: value.minOrderAmount || 0,
    minItemQuantity: value.minItemQuantity || 0,
    maxDiscountAmount: value.maxDiscountAmount || 0,
    validFrom: value.validFrom || null,
    expiryDate: value.expiryDate,
    applicablePaymentMethods: value.applicablePaymentMethods || [],
    applicableProducts: value.applicableProducts || [],
    applicableCategories: value.applicableCategories || [],
    scopeMatchMode: value.scopeMatchMode || 'ALL',
    minimumRequirementBasis: value.minimumRequirementBasis || 'CART',
    applicablePincodes: value.applicablePincodes || [],
    salesChannels: value.salesChannels || [],
    customerSegment: value.customerSegment || 'ALL',
    minimumPriorOrders: value.minimumPriorOrders || 0,
    minimumLifetimeSpend: value.minimumLifetimeSpend || 0,
    inactiveDays: value.inactiveDays || 90,
    customerLimit: value.customerLimit || 0,
    firstOrderOnly: Boolean(value.firstOrderOnly),
    restoreOnFullRefund: Boolean(value.restoreOnFullRefund),
    stackingMode: value.stackingMode || 'ALLOW_PRODUCT_OFFERS',
    ...eligibility,
  };
}

function lifecycleFilter(status, now = new Date()) {
  const usableDates = [
    { $or: [{ validFrom: { $exists: false } }, { validFrom: null }, { validFrom: { $lte: now } }] },
    { $or: [{ expiryDate: { $exists: false } }, { expiryDate: null }, { expiryDate: { $gte: now } }] },
  ];
  const availableCapacity = [
    { $or: [{ usageLimit: { $exists: false } }, { usageLimit: null }, { usageLimit: 0 }, { $expr: { $lt: [{ $ifNull: ['$usedCount', 0] }, '$usageLimit'] } }] },
    { $or: [{ totalBudget: { $exists: false } }, { totalBudget: null }, { totalBudget: 0 }, { $expr: { $lt: [{ $ifNull: ['$spentAmount', 0] }, '$totalBudget'] } }] },
  ];
  if (status === 'live') return { isActive: true, $and: [...usableDates, ...availableCapacity] };
  if (status === 'scheduled') return { isActive: true, validFrom: { $gt: now } };
  if (status === 'expired') return { isActive: true, expiryDate: { $lt: now } };
  if (status === 'paused') return { isActive: false };
  if (status === 'exhausted') return { isActive: true, $and: [...usableDates, { $or: [
    { $and: [{ usageLimit: { $gt: 0 } }, { $expr: { $gte: [{ $ifNull: ['$usedCount', 0] }, '$usageLimit'] } }] },
    { $and: [{ totalBudget: { $gt: 0 } }, { $expr: { $gte: [{ $ifNull: ['$spentAmount', 0] }, '$totalBudget'] } }] },
  ] }] };
  if (status === 'expiring') return { isActive: true, expiryDate: { $gte: now, $lte: new Date(now.getTime() + 7 * 86400000) }, $and: [usableDates[0], ...availableCapacity] };
  return {};
}

exports.getCoupons = asyncHandler(async (req, res) => {
  const isAdminRequest = (req.user?.role === 'admin'
    && (req.query.admin === 'true' || String(req.baseUrl || '').startsWith('/api/admin')))
    || String(req.baseUrl || '').startsWith('/api/seller');
  const adminFilter = {};
  let adminLifecycle = {};
  if (isAdminRequest) {
    const archive = String(req.query.archive || 'active').toLowerCase();
    if (!['active', 'archived', 'all'].includes(archive)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid coupon archive filter');
    if (archive === 'active') adminFilter.isArchived = { $ne: true };
    if (archive === 'archived') adminFilter.isArchived = true;
    const status = String(req.query.status || '').toLowerCase();
    if (status && !['live', 'scheduled', 'expired', 'paused', 'exhausted', 'expiring'].includes(status)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid coupon status');
    adminLifecycle = lifecycleFilter(status);
    const benefitType = String(req.query.benefitType || '').toUpperCase();
    if (benefitType) adminFilter.benefitType = requireEnum(benefitType, ['DISCOUNT', 'FREE_SHIPPING', 'BUY_X_GET_Y'], 'offer benefit');
    const activationMode = String(req.query.activationMode || '').toUpperCase();
    if (activationMode) adminFilter.activationMode = requireEnum(activationMode, ['CODE', 'AUTOMATIC'], 'activation mode');
    const customerSegment = String(req.query.customerSegment || '').toUpperCase();
    if (customerSegment) adminFilter.customerSegment = requireEnum(customerSegment, ['ALL', 'NEW', 'REPEAT', 'VIP', 'INACTIVE', 'SELECTED'], 'customer segment');
    const search = String(req.query.search || '').trim().slice(0, 80);
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      adminFilter.$or = ['code', 'title', 'description'].map((field) => ({ [field]: { $regex: escaped, $options: 'i' } }));
    }
  }
  const managementFilter = andFilter(adminFilter, adminLifecycle);
  const query = andFilter(isAdminRequest ? managementFilter : livePublicQuery(), req.tenantFilter);
  const adminSorts = {
    newest: { createdAt: -1 },
    ending: { expiryDate: 1, createdAt: -1 },
    usage: { usedCount: -1, createdAt: -1 },
    budget: { spentAmount: -1, createdAt: -1 },
    priority: { priority: -1, createdAt: -1 },
  };
  const sort = isAdminRequest ? (adminSorts[String(req.query.sort || 'priority')] || adminSorts.priority) : { priority: -1, discountValue: -1, expiryDate: 1 };
  const finder = () => Coupon.find(query).sort(sort);
  if (wantsPagination(req.query)) {
    const { page, limit, skip } = readPagination(req.query, { defaultLimit: 24, maxLimit: 100 });
    const [items, total] = await Promise.all([finder().skip(skip).limit(limit), Coupon.countDocuments(query)]);
    return res.json(buildPaginatedResponse(isAdminRequest ? items : items.map((item) => publicCouponView(item)), { page, limit, total }));
  }
  const items = await finder().limit(200);
  return res.json(isAdminRequest ? items : items.map((item) => publicCouponView(item)));
});

exports.getAvailableCoupons = asyncHandler(async (req, res) => {
  const cart = await resolvePreviewCart(req.body, req.tenantFilter);
  const coupons = await Coupon.find(andFilter(livePublicQuery(), req.tenantFilter)).sort({ discountValue: -1, expiryDate: 1 }).limit(200);
  const context = {
    cartTotal: cart.cartTotal,
    items: cart.items,
    paymentMethod: req.body?.paymentMethod,
    userId: req.user?._id,
    tenantFilter: req.tenantFilter,
    pincode: req.body?.pincode || req.body?.shippingAddress?.pincode,
    salesChannel: req.body?.salesChannel || 'STOREFRONT',
    deliveryCharge: Number(req.body?.deliveryCharge || 0),
  };
  context.customerContext = await couponService.prepareCustomerContext(req.user?._id, req.tenantFilter, coupons.map((coupon) => coupon._id));
  const evaluated = await Promise.all(coupons.map(async (coupon) => publicCouponView(coupon, await couponService.evaluateCoupon(coupon, context))));
  evaluated.sort((left, right) => Number(right.eligible) - Number(left.eligible)
    || Number(right.effectiveSaving || right.estimatedDiscount || 0) - Number(left.effectiveSaving || left.estimatedDiscount || 0)
    || String(left.code).localeCompare(String(right.code)));
  res.json({
    items: evaluated,
    cartTotal: cart.cartTotal,
    bestCouponCode: evaluated.find((coupon) => coupon.eligible && Number(coupon.effectiveSaving || coupon.estimatedDiscount || 0) > 0)?.code || null,
  });
});

exports.createCoupon = asyncHandler(async (req, res) => {
  const payload = readCouponPayload(req.body);
  delete payload.storeId;
  if (req.store?._id) payload.storeId = req.store._id;
  await validateCouponReferences(payload, req.tenantFilter);
  const duplicate = await Coupon.exists(andFilter({ code: payload.code }, req.tenantFilter));
  if (duplicate) throw new ApiError('DUPLICATE_REQUEST', 'A coupon with this code already exists');
  try {
    const coupon = await Coupon.create(payload);
    logAudit({ req, action: 'COUPON_CREATE', entityType: 'Coupon', entityId: coupon._id, storeId: coupon.storeId, after: auditSnapshot(coupon, COUPON_AUDIT_FIELDS) });
    res.status(201).json(coupon);
  } catch (error) {
    if (error?.code === 11000) throw new ApiError('DUPLICATE_REQUEST', 'A coupon with this code already exists');
    throw error;
  }
});

exports.updateCoupon = asyncHandler(async (req, res) => {
  const couponId = requireObjectId(req.params.id, 'coupon id');
  const coupon = await Coupon.findOne(andFilter({ _id: couponId }, req.tenantFilter));
  if (!coupon) throw notFound('Coupon not found');
  if (coupon.campaignId) throw new ApiError('VALIDATION_ERROR', 'This coupon is managed by Campaigns. Edit the campaign to keep its banner and offer synchronized.');
  if (coupon.isArchived) throw new ApiError('VALIDATION_ERROR', 'Restore this coupon before editing it');
  if (req.body.revision !== undefined && Number(req.body.revision) !== Number(coupon.revision || 0)) throw new ApiError('CONFLICT', 'This coupon changed in another session. Reload it before saving.', { statusCode: 409 });
  const before = auditSnapshot(coupon, COUPON_AUDIT_FIELDS);
  const payload = readCouponPayload({ ...coupon.toObject(), ...req.body });
  const codeChanged = payload.code !== coupon.code;
  if (codeChanged) {
    const linkedOrder = Number(coupon.usedCount || 0) > 0 || await Order.exists(andFilter({
      $or: [{ 'coupon.couponId': coupon._id }, { 'coupon.code': coupon.code }],
    }, req.tenantFilter));
    if (linkedOrder) throw new ApiError('VALIDATION_ERROR', 'Coupon code cannot be changed after it has been used in an order');
  }
  if (payload.usageLimit && payload.usageLimit < Number(coupon.usedCount || 0)) throw new ApiError('VALIDATION_ERROR', 'Usage limit cannot be lower than existing redemptions');
  if (payload.totalBudget && payload.totalBudget < Number(coupon.spentAmount || 0)) throw new ApiError('VALIDATION_ERROR', 'Campaign budget cannot be lower than the amount already spent');
  await validateCouponReferences(payload, req.tenantFilter);
  Object.assign(coupon, payload);
  coupon.revision = Number(coupon.revision || 0) + 1;
  try {
    await coupon.save();
  } catch (error) {
    if (error?.code === 11000) throw new ApiError('DUPLICATE_REQUEST', 'A coupon with this code already exists');
    throw error;
  }
  logAudit({ req, action: 'COUPON_UPDATE', entityType: 'Coupon', entityId: coupon._id, storeId: coupon.storeId, before, after: auditSnapshot(coupon, COUPON_AUDIT_FIELDS) });
  res.json(coupon);
});

exports.deleteCoupon = asyncHandler(async (req, res) => {
  const couponId = requireObjectId(req.params.id, 'coupon id');
  const coupon = await Coupon.findOne(andFilter({ _id: couponId, isArchived: { $ne: true } }, req.tenantFilter));
  if (!coupon) throw notFound('Coupon not found');
  if (coupon.campaignId) throw new ApiError('VALIDATION_ERROR', 'This coupon is managed by Campaigns. Archive the campaign instead.');
  const before = auditSnapshot(coupon, COUPON_AUDIT_FIELDS);
  if (Number(coupon.usedCount || 0) > 0) {
    coupon.isActive = false;
    coupon.isPublic = false;
    coupon.isArchived = true;
    coupon.archivedAt = new Date();
    coupon.revision = Number(coupon.revision || 0) + 1;
    await coupon.save();
    logAudit({ req, action: 'COUPON_ARCHIVE', entityType: 'Coupon', entityId: coupon._id, storeId: coupon.storeId, before, after: auditSnapshot(coupon, COUPON_AUDIT_FIELDS) });
    return res.json({ success: true, archived: true, message: 'Used coupon archived to preserve redemption history', coupon });
  }
  await coupon.deleteOne();
  logAudit({ req, action: 'COUPON_DELETE', entityType: 'Coupon', entityId: coupon._id, storeId: coupon.storeId, before });
  return res.json({ success: true, archived: false, message: 'Coupon deleted' });
});

exports.applyCoupon = asyncHandler(async (req, res) => {
  const cart = await resolvePreviewCart(req.body, req.tenantFilter);
  const { coupon, discountAmount, savingAmount } = await couponService.validateAndPrice({
    code: req.body?.code,
    cartTotal: cart.cartTotal,
    paymentMethod: req.body?.paymentMethod,
    items: cart.items,
    userId: req.user?._id,
    tenantFilter: req.tenantFilter,
    pincode: req.body?.pincode || req.body?.shippingAddress?.pincode,
    salesChannel: req.body?.salesChannel || 'STOREFRONT',
    deliveryCharge: Number(req.body?.deliveryCharge || 0),
  });

  res.json({
    success: true,
    couponCode: coupon.code,
    discountAmount,
    discount: discountAmount,
    message: coupon.benefitType === 'FREE_SHIPPING' ? `${coupon.code} applied. Delivery benefit will be calculated at checkout.` : `${coupon.code} applied. You saved Rs. ${discountAmount}.`,
    savingAmount,
    coupon: publicCouponView(coupon, { eligible: true, estimatedDiscount: discountAmount, estimatedDeliverySaving: coupon.benefitType === 'FREE_SHIPPING' ? savingAmount : 0, effectiveSaving: savingAmount }),
  });
});

async function resolvePreviewCart(body = {}, tenantFilter = {}) {
  if (Array.isArray(body.items) && body.items.length) {
    const { loadOrderItems } = require('../services/orderPricingService');
    const priced = await loadOrderItems(body.items, { tenantFilter });
    return { items: priced.items, cartTotal: priced.sellingTotal };
  }
  const cartTotal = Number(body.cartTotal || body.amount || 0);
  return { items: [], cartTotal: Number.isFinite(cartTotal) ? cartTotal : 0 };
}

function readObjectIdList(value, field) {
  if (!Array.isArray(value)) return [];
  const ids = value.map((item) => String(item?._id || item || '').trim()).filter(Boolean);
  if (ids.length > 500) throw new ApiError('VALIDATION_ERROR', `${field} can contain at most 500 selections`);
  if (ids.some((id) => !mongoose.Types.ObjectId.isValid(id))) {
    throw new ApiError('VALIDATION_ERROR', `${field} contains an invalid selection`);
  }
  return Array.from(new Set(ids));
}

async function validateCouponReferences(payload, tenantFilter = {}) {
  const checks = [
    [payload.applicableProducts, Product, 'products'],
    [payload.applicableCategories, Category, 'categories'],
  ];
  for (const [ids, Model, label] of checks) {
    if (!ids?.length) continue;
    const count = await Model.countDocuments(andFilter({ _id: { $in: ids } }, tenantFilter));
    if (count !== ids.length) throw new ApiError('VALIDATION_ERROR', `One or more selected ${label} do not belong to this store`);
  }

  const customerIds = payload.applicableCustomers || [];
  if (!customerIds.length) return;
  if (customerIds.length > 200) throw new ApiError('VALIDATION_ERROR', 'Select at most 200 customers');
  if (!tenantFilter || !Object.keys(tenantFilter).length) {
    const count = await User.countDocuments({ _id: { $in: customerIds }, role: 'customer' });
    if (count !== customerIds.length) throw new ApiError('VALIDATION_ERROR', 'One or more selected customers are invalid');
    return;
  }
  const [crmIds, orderIds, cartIds] = await Promise.all([
    CustomerCrm.distinct('user', andFilter({ user: { $in: customerIds } }, tenantFilter)),
    Order.distinct('user', andFilter({ user: { $in: customerIds } }, tenantFilter)),
    Cart.distinct('user', andFilter({ user: { $in: customerIds } }, tenantFilter)),
  ]);
  const allowed = new Set([...crmIds, ...orderIds, ...cartIds].map(String));
  if (customerIds.some((id) => !allowed.has(String(id)))) throw new ApiError('VALIDATION_ERROR', 'One or more selected customers do not belong to this store');
}

function readSelectedOptionIds(value) {
  const ids = String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (ids.length > 500 || ids.some((id) => !mongoose.Types.ObjectId.isValid(id))) {
    throw new ApiError('VALIDATION_ERROR', 'Selected option ids are invalid');
  }
  return Array.from(new Set(ids));
}

function optionSearchFilter(search, fields) {
  if (!search) return {};
  const escaped = String(search).trim().slice(0, 80).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { $or: fields.map((field) => ({ [field]: { $regex: escaped, $options: 'i' } })) };
}

function mergeOptions(selectedItems, searchedItems) {
  const seen = new Set();
  return [...selectedItems, ...searchedItems].filter((item) => {
    const id = String(item._id);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** Lightweight, tenant-scoped search for coupon targeting controls. */
exports.searchCouponOptions = asyncHandler(async (req, res) => {
  const type = requireEnum(String(req.query.type || '').toUpperCase(), ['PRODUCT', 'CATEGORY', 'CUSTOMER'], 'option type');
  const search = String(req.query.search || '').trim().slice(0, 80);
  const selected = readSelectedOptionIds(req.query.selected);
  const requestedLimit = Number.parseInt(req.query.limit, 10);
  const limit = Math.min(100, Math.max(10, Number.isFinite(requestedLimit) ? requestedLimit : 40));

  if (type === 'PRODUCT') {
    const base = { isArchived: { $ne: true } };
    const [selectedItems, searchedItems] = await Promise.all([
      selected.length ? Product.find(andFilter({ ...base, _id: { $in: selected } }, req.tenantFilter)).select('name sku isActive').lean() : [],
      Product.find(andFilter({ ...base, ...optionSearchFilter(search, ['name', 'sku']) }, req.tenantFilter)).select('name sku isActive').sort('name').limit(limit).lean(),
    ]);
    const items = mergeOptions(selectedItems, searchedItems);
    return res.json({ items: items.map((item) => ({ id: String(item._id), label: item.name, subtitle: item.sku || (item.isActive === false ? 'Inactive product' : '') })) });
  }

  if (type === 'CATEGORY') {
    const base = { isArchived: { $ne: true } };
    const [selectedItems, searchedItems] = await Promise.all([
      selected.length ? Category.find(andFilter({ ...base, _id: { $in: selected } }, req.tenantFilter)).select('name slug isActive').lean() : [],
      Category.find(andFilter({ ...base, ...optionSearchFilter(search, ['name', 'slug']) }, req.tenantFilter)).select('name slug isActive').sort('level displayOrder name').limit(limit).lean(),
    ]);
    const items = mergeOptions(selectedItems, searchedItems);
    const productRows = items.length ? await Product.aggregate([
      { $match: andFilter({ category: { $in: items.map((item) => item._id) }, isArchived: { $ne: true }, isActive: { $ne: false } }, req.tenantFilter) },
      { $sort: { name: 1 } },
      { $group: { _id: '$category', count: { $sum: 1 }, names: { $push: '$name' } } },
      { $project: { count: 1, samples: { $slice: ['$names', 2] } } },
    ]) : [];
    const productSummary = new Map(productRows.map((row) => [String(row._id), row]));
    return res.json({ items: items.map((item) => {
      const summary = productSummary.get(String(item._id)) || { count: 0, samples: [] };
      const sampleText = summary.samples.length ? `: ${summary.samples.join(', ')}` : '';
      return {
        id: String(item._id), label: item.name,
        subtitle: item.isActive === false ? 'Inactive category' : `${summary.count} eligible product${summary.count === 1 ? '' : 's'}${sampleText}`,
      };
    }) });
  }

  let allowedCustomerIds;
  if (!req.tenantFilter || !Object.keys(req.tenantFilter).length) {
    allowedCustomerIds = await User.distinct('_id', { role: 'customer' });
  } else {
    const [crmIds, orderIds, cartIds] = await Promise.all([
      CustomerCrm.distinct('user', req.tenantFilter),
      Order.distinct('user', req.tenantFilter),
      Cart.distinct('user', req.tenantFilter),
    ]);
    allowedCustomerIds = Array.from(new Set([...crmIds, ...orderIds, ...cartIds].map(String)));
  }
  const allowed = new Set(allowedCustomerIds.map(String));
  if (selected.some((id) => !allowed.has(id))) throw new ApiError('VALIDATION_ERROR', 'One or more selected customers do not belong to this store');
  const baseCustomer = { _id: { $in: allowedCustomerIds }, role: 'customer' };
  const [selectedItems, searchedItems] = await Promise.all([
    selected.length ? User.find({ ...baseCustomer, _id: { $in: selected } }).select('name phone').lean() : [],
    User.find({ ...baseCustomer, ...optionSearchFilter(search, ['name', 'phone', 'email']) }).select('name phone').sort('name').limit(limit).lean(),
  ]);
  const items = mergeOptions(selectedItems, searchedItems);
  return res.json({ items: items.map((item) => ({
    id: String(item._id), label: item.name || 'Customer',
    subtitle: item.phone ? `Mobile ending ${String(item.phone).replace(/\D/g, '').slice(-4)}` : '',
  })) });
});

function readOptionalLimit(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new ApiError('VALIDATION_ERROR', `${field} must be a whole number of 0 or more`);
  return parsed || undefined;
}

function readCouponPayload(body = {}) {
  const payload = {
    code: requireCouponCode(body.code),
    title: optionalString(body.title, 'title', { max: 120 }),
    description: optionalString(body.description, 'description', { max: 500 }),
    terms: optionalString(body.terms, 'terms', { max: 1200 }),
    activationMode: requireEnum(body.activationMode || 'CODE', ['CODE', 'AUTOMATIC'], 'activation mode'),
    benefitType: requireEnum(body.benefitType || 'DISCOUNT', ['DISCOUNT', 'FREE_SHIPPING', 'BUY_X_GET_Y'], 'offer benefit'),
    type: requireEnum(body.type, ['Percentage', 'Flat'], 'type'),
  };

  const discountValue = Number(body.discountValue);
  if (!Number.isFinite(discountValue) || (payload.benefitType === 'DISCOUNT' ? discountValue <= 0 : discountValue < 0)) throw new ApiError('VALIDATION_ERROR', 'Discount value must be positive');
  if (payload.type === 'Percentage' && discountValue > 100) throw new ApiError('VALIDATION_ERROR', 'Percentage discount cannot exceed 100');
  payload.discountValue = discountValue;
  payload.buyQuantity = readPositiveQuantity(body.buyQuantity, 'Buy quantity');
  payload.getQuantity = readPositiveQuantity(body.getQuantity, 'Free quantity');

  const minOrderAmount = Number(body.minOrderAmount || 0);
  if (!Number.isFinite(minOrderAmount) || minOrderAmount < 0) throw new ApiError('VALIDATION_ERROR', 'Minimum order amount cannot be negative');
  payload.minOrderAmount = minOrderAmount;

  payload.minItemQuantity = readOptionalLimit(body.minItemQuantity, 'Minimum item quantity') || 0;

  const maxDiscountAmount = Number(body.maxDiscountAmount || 0);
  if (!Number.isFinite(maxDiscountAmount) || maxDiscountAmount < 0) throw new ApiError('VALIDATION_ERROR', 'Maximum discount cannot be negative');
  payload.maxDiscountAmount = maxDiscountAmount || undefined;

  payload.validFrom = body.validFrom ? new Date(body.validFrom) : undefined;
  if (payload.validFrom && Number.isNaN(payload.validFrom.getTime())) throw new ApiError('VALIDATION_ERROR', 'Start date is invalid');
  payload.expiryDate = body.expiryDate ? new Date(body.expiryDate) : undefined;
  if (payload.expiryDate && Number.isNaN(payload.expiryDate.getTime())) throw new ApiError('VALIDATION_ERROR', 'Expiry date is invalid');
  if (payload.validFrom && payload.expiryDate && payload.expiryDate <= payload.validFrom) throw new ApiError('VALIDATION_ERROR', 'Expiry date must be after the start date');

  payload.usageLimit = readOptionalLimit(body.usageLimit, 'Usage limit');
  payload.customerLimit = readOptionalLimit(body.customerLimit, 'Per-customer limit');

  const methods = Array.isArray(body.applicablePaymentMethods) ? body.applicablePaymentMethods : [];
  payload.applicablePaymentMethods = Array.from(new Set(methods.map((method) => String(method || '').toUpperCase()).filter(Boolean)));
  if (payload.applicablePaymentMethods.some((method) => !PAYMENT_METHODS.includes(method))) {
    throw new ApiError('VALIDATION_ERROR', 'Applicable payment methods contain an unsupported option');
  }
  payload.applicableProducts = readObjectIdList(body.applicableProducts, 'Applicable products');
  payload.applicableCategories = readObjectIdList(body.applicableCategories, 'Applicable categories');
  payload.scopeMatchMode = requireEnum(body.scopeMatchMode || 'ALL', ['ANY', 'ALL'], 'scope match mode');
  payload.minimumRequirementBasis = requireEnum(body.minimumRequirementBasis || 'CART', ['CART', 'ELIGIBLE_ITEMS'], 'minimum requirement basis');
  payload.applicableCustomers = readObjectIdList(body.applicableCustomers, 'Applicable customers');
  payload.applicablePincodes = readPincodes(body.applicablePincodes);
  payload.salesChannels = readStringEnumList(body.salesChannels, ['STOREFRONT', 'ADMIN', 'SOCIAL'], 'sales channels');
  payload.customerSegment = requireEnum(body.customerSegment || 'ALL', ['ALL', 'NEW', 'REPEAT', 'VIP', 'INACTIVE', 'SELECTED'], 'customer segment');
  payload.minimumPriorOrders = readOptionalLimit(body.minimumPriorOrders, 'Minimum previous orders') || 0;
  payload.minimumLifetimeSpend = readMoneyLimit(body.minimumLifetimeSpend, 'Minimum lifetime spend') || 0;
  payload.inactiveDays = readOptionalLimit(body.inactiveDays, 'Inactive period') || 90;
  if (payload.inactiveDays > 3650) throw new ApiError('VALIDATION_ERROR', 'Inactive period cannot exceed 3650 days');
  if (payload.customerSegment === 'SELECTED' && !payload.applicableCustomers.length) throw new ApiError('VALIDATION_ERROR', 'Select at least one customer for this audience');
  payload.totalBudget = readMoneyLimit(body.totalBudget, 'Campaign budget');
  payload.priority = readPriority(body.priority);
  payload.stackingMode = requireEnum(body.stackingMode || 'ALLOW_PRODUCT_OFFERS', ['EXCLUSIVE', 'ALLOW_PRODUCT_OFFERS'], 'stacking mode');
  payload.firstOrderOnly = requireBoolean(body.firstOrderOnly ?? false, 'firstOrderOnly');
  payload.restoreOnFullRefund = requireBoolean(body.restoreOnFullRefund ?? false, 'restoreOnFullRefund');
  payload.isPublic = requireBoolean(body.isPublic ?? true, 'isPublic');
  payload.isActive = requireBoolean(body.isActive ?? true, 'isActive');
  payload.isArchived = false;
  return payload;
}

function readMoneyLimit(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new ApiError('VALIDATION_ERROR', `${field} must be 0 or more`);
  return parsed || undefined;
}

function readPriority(value) {
  const parsed = Number(value || 0);
  if (!Number.isInteger(parsed) || parsed < -1000 || parsed > 1000) throw new ApiError('VALIDATION_ERROR', 'Priority must be a whole number between -1000 and 1000');
  return parsed;
}

function readPincodes(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(/[\s,]+/);
  const result = Array.from(new Set(values.map((item) => String(item).trim()).filter(Boolean)));
  if (result.some((item) => !/^\d{6}$/.test(item))) throw new ApiError('VALIDATION_ERROR', 'PIN codes must contain exactly 6 digits');
  return result.slice(0, 500);
}

function readStringEnumList(value, allowed, field) {
  const items = Array.from(new Set((Array.isArray(value) ? value : []).map((item) => String(item).toUpperCase()).filter(Boolean)));
  if (items.some((item) => !allowed.includes(item))) throw new ApiError('VALIDATION_ERROR', `${field} contain an unsupported option`);
  return items;
}

function couponLifecycle(coupon, now = Date.now()) {
  if (coupon.isArchived) return 'archived';
  if (!coupon.isActive) return 'paused';
  if (coupon.validFrom && new Date(coupon.validFrom).getTime() > now) return 'scheduled';
  if (coupon.expiryDate && new Date(coupon.expiryDate).getTime() < now) return 'expired';
  if ((coupon.usageLimit && Number(coupon.usedCount || 0) >= Number(coupon.usageLimit))
    || (coupon.totalBudget && Number(coupon.spentAmount || 0) >= Number(coupon.totalBudget))) return 'exhausted';
  if (coupon.expiryDate && new Date(coupon.expiryDate).getTime() <= now + 7 * 86400000) return 'expiring';
  return 'live';
}

exports.getCouponStats = asyncHandler(async (req, res) => {
  const coupons = await Coupon.find(andFilter({}, req.tenantFilter))
    .select('isActive isArchived validFrom expiryDate usageLimit usedCount totalBudget spentAmount')
    .lean();
  const stats = { total: 0, live: 0, scheduled: 0, expiring: 0, expired: 0, paused: 0, exhausted: 0, archived: 0, redemptions: 0, spentAmount: 0 };
  coupons.forEach((coupon) => {
    const state = couponLifecycle(coupon);
    if (!coupon.isArchived) stats.total += 1;
    stats[state] += 1;
    if (state === 'expiring') stats.live += 1;
    stats.redemptions += Number(coupon.usedCount || 0);
    stats.spentAmount += Number(coupon.spentAmount || 0);
  });
  stats.spentAmount = Math.round(stats.spentAmount * 100) / 100;
  res.json({ ...stats, timezone: req.store?.timezone || 'Asia/Kolkata' });
});

exports.checkCouponCode = asyncHandler(async (req, res) => {
  const code = requireCouponCode(req.query.code);
  const excludeId = req.query.excludeId ? requireObjectId(req.query.excludeId, 'coupon id') : null;
  const exists = await Coupon.exists(andFilter({ code, ...(excludeId ? { _id: { $ne: excludeId } } : {}) }, req.tenantFilter));
  res.json({ code, available: !exists });
});

function couponOrderFilter(coupon) {
  return { $or: [{ 'coupon.couponId': coupon._id }, { 'coupon.code': coupon.code }] };
}

exports.getCouponInsights = asyncHandler(async (req, res) => {
  const coupon = await Coupon.findOne(andFilter({ _id: requireObjectId(req.params.id, 'coupon id') }, req.tenantFilter)).lean();
  if (!coupon) throw notFound('Coupon not found');
  const days = [7, 30, 90, 365].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
  const from = new Date(Date.now() - days * 86400000);
  const orderFilter = andFilter({ ...couponOrderFilter(coupon), createdAt: { $gte: from } }, req.tenantFilter);
  const [summaryRows, daily, recentOrders] = await Promise.all([
    Order.aggregate([
      { $match: orderFilter },
      { $group: {
        _id: null,
        orders: { $sum: 1 },
        customers: { $addToSet: '$user' },
        paidOrders: { $sum: { $cond: [{ $eq: ['$paymentStatus', 'Paid'] }, 1, 0] } },
        paidRevenue: { $sum: { $cond: [{ $eq: ['$paymentStatus', 'Paid'] }, { $ifNull: ['$finalAmount', 0] }, 0] } },
        saving: { $sum: { $ifNull: ['$coupon.savingAmount', { $ifNull: ['$couponDiscount', 0] }] } },
        cancelled: { $sum: { $cond: [{ $eq: ['$orderStatus', 'Cancelled'] }, 1, 0] } },
        returned: { $sum: { $cond: [{ $in: ['$orderStatus', ['Return Requested', 'Returned', 'Refunded']] }, 1, 0] } },
      } },
    ]),
    Order.aggregate([
      { $match: orderFilter },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: req.store?.timezone || 'Asia/Kolkata' } }, orders: { $sum: 1 }, revenue: { $sum: { $cond: [{ $eq: ['$paymentStatus', 'Paid'] }, { $ifNull: ['$finalAmount', 0] }, 0] } }, saving: { $sum: { $ifNull: ['$coupon.savingAmount', { $ifNull: ['$couponDiscount', 0] }] } } } },
      { $sort: { _id: 1 } },
    ]),
    Order.find(orderFilter).select('invoiceNumber user finalAmount coupon paymentStatus orderStatus createdAt').populate('user', 'name phone email').sort({ createdAt: -1 }).limit(25).lean(),
  ]);
  const raw = summaryRows[0] || {};
  const paidOrders = Number(raw.paidOrders || 0);
  res.json({
    coupon,
    days,
    summary: {
      orders: Number(raw.orders || 0), uniqueCustomers: (raw.customers || []).filter(Boolean).length,
      paidOrders, paidRevenue: Number(raw.paidRevenue || 0), averageOrderValue: paidOrders ? Number(raw.paidRevenue || 0) / paidOrders : 0,
      saving: Number(raw.saving || 0), cancelled: Number(raw.cancelled || 0), returned: Number(raw.returned || 0),
      remainingUses: coupon.usageLimit ? Math.max(0, Number(coupon.usageLimit) - Number(coupon.usedCount || 0)) : null,
      remainingBudget: coupon.totalBudget ? Math.max(0, Number(coupon.totalBudget) - Number(coupon.spentAmount || 0)) : null,
    },
    daily: daily.map((row) => ({ date: row._id, orders: row.orders, revenue: row.revenue, saving: row.saving })),
    recentOrders: recentOrders.map((order) => ({
      id: order._id, invoiceNumber: order.invoiceNumber || '', customer: order.user ? { id: order.user._id, name: order.user.name || '', phone: order.user.phone || '', email: order.user.email || '' } : null,
      finalAmount: order.finalAmount || 0, saving: order.coupon?.savingAmount ?? order.couponDiscount ?? 0,
      paymentStatus: order.paymentStatus, orderStatus: order.orderStatus, createdAt: order.createdAt,
    })),
  });
});

exports.exportCouponRedemptions = asyncHandler(async (req, res) => {
  const coupon = await Coupon.findOne(andFilter({ _id: requireObjectId(req.params.id, 'coupon id') }, req.tenantFilter)).lean();
  if (!coupon) throw notFound('Coupon not found');
  const orders = await Order.find(andFilter(couponOrderFilter(coupon), req.tenantFilter))
    .select('invoiceNumber user finalAmount couponDiscount coupon paymentStatus orderStatus createdAt')
    .populate('user', 'name phone email').sort({ createdAt: -1 }).limit(5000).lean();
  res.json({
    code: coupon.code,
    rows: orders.map((order) => ({
      orderId: String(order._id), invoiceNumber: order.invoiceNumber || '', customer: order.user?.name || '', phone: order.user?.phone || '', email: order.user?.email || '',
      amount: Number(order.finalAmount || 0), saving: Number(order.coupon?.savingAmount ?? order.couponDiscount ?? 0), paymentStatus: order.paymentStatus || '', orderStatus: order.orderStatus || '', createdAt: order.createdAt,
    })),
  });
});

exports.simulateCoupon = asyncHandler(async (req, res) => {
  const coupon = await Coupon.findOne(andFilter({ _id: requireObjectId(req.params.id, 'coupon id') }, req.tenantFilter));
  if (!coupon) throw notFound('Coupon not found');
  const customerId = req.body?.customerId ? requireObjectId(req.body.customerId, 'customer id') : undefined;
  if (customerId) await validateCouponReferences({ applicableCustomers: [customerId] }, req.tenantFilter);
  const cart = await resolvePreviewCart(req.body, req.tenantFilter);
  const result = await couponService.evaluateCoupon(coupon, {
    cartTotal: cart.cartTotal, items: cart.items, paymentMethod: req.body?.paymentMethod,
    userId: customerId, tenantFilter: req.tenantFilter, pincode: req.body?.pincode,
    salesChannel: req.body?.salesChannel || 'STOREFRONT', deliveryCharge: Number(req.body?.deliveryCharge || 0),
  });
  res.json({ code: coupon.code, ...result });
});

exports.bulkCouponAction = asyncHandler(async (req, res) => {
  const ids = Array.from(new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(String)));
  if (!ids.length || ids.length > 100 || ids.some((id) => !mongoose.Types.ObjectId.isValid(id))) throw new ApiError('VALIDATION_ERROR', 'Select between 1 and 100 valid coupons');
  const action = requireEnum(String(req.body?.action || '').toUpperCase(), ['ACTIVATE', 'PAUSE', 'ARCHIVE', 'RESTORE'], 'bulk action');
  const coupons = await Coupon.find(andFilter({ _id: { $in: ids } }, req.tenantFilter));
  if (coupons.length !== ids.length) throw new ApiError('VALIDATION_ERROR', 'One or more coupons do not belong to this store');
  if (coupons.some((coupon) => coupon.campaignId)) throw new ApiError('VALIDATION_ERROR', 'Campaign-managed coupons must be changed from Campaigns. Remove them from this bulk action.');
  const changed = [];
  for (const coupon of coupons) {
    const before = auditSnapshot(coupon, COUPON_AUDIT_FIELDS);
    if (action === 'ACTIVATE' && !coupon.isArchived) coupon.isActive = true;
    if (action === 'PAUSE' && !coupon.isArchived) coupon.isActive = false;
    if (action === 'ARCHIVE') { coupon.isArchived = true; coupon.isActive = false; coupon.isPublic = false; coupon.archivedAt = new Date(); }
    if (action === 'RESTORE' && coupon.isArchived) { coupon.isArchived = false; coupon.isActive = false; coupon.archivedAt = undefined; }
    coupon.revision = Number(coupon.revision || 0) + 1;
    await coupon.save();
    changed.push(coupon);
    logAudit({ req, action: `COUPON_${action}`, entityType: 'Coupon', entityId: coupon._id, storeId: coupon.storeId, before, after: auditSnapshot(coupon, COUPON_AUDIT_FIELDS) });
  }
  res.json({ success: true, count: changed.length, items: changed });
});

exports.updateCouponStatus = asyncHandler(async (req, res) => {
  const coupon = await Coupon.findOne(andFilter({ _id: requireObjectId(req.params.id, 'coupon id'), isArchived: { $ne: true } }, req.tenantFilter));
  if (!coupon) throw notFound('Coupon not found');
  if (coupon.campaignId) throw new ApiError('VALIDATION_ERROR', 'This coupon is managed by Campaigns. Pause or publish the campaign instead.');
  const before = auditSnapshot(coupon, COUPON_AUDIT_FIELDS);
  coupon.isActive = requireBoolean(req.body.isActive, 'isActive');
  coupon.revision = Number(coupon.revision || 0) + 1;
  await coupon.save();
  logAudit({ req, action: coupon.isActive ? 'COUPON_ACTIVATE' : 'COUPON_PAUSE', entityType: 'Coupon', entityId: coupon._id, storeId: coupon.storeId, before, after: auditSnapshot(coupon, COUPON_AUDIT_FIELDS) });
  res.json(coupon);
});

exports.archiveCoupon = asyncHandler(async (req, res) => {
  const coupon = await Coupon.findOne(andFilter({ _id: requireObjectId(req.params.id, 'coupon id'), isArchived: { $ne: true } }, req.tenantFilter));
  if (!coupon) throw notFound('Coupon not found');
  if (coupon.campaignId) throw new ApiError('VALIDATION_ERROR', 'This coupon is managed by Campaigns. Archive the campaign instead.');
  const before = auditSnapshot(coupon, COUPON_AUDIT_FIELDS);
  coupon.isArchived = true; coupon.isActive = false; coupon.isPublic = false; coupon.archivedAt = new Date(); coupon.revision = Number(coupon.revision || 0) + 1;
  await coupon.save();
  logAudit({ req, action: 'COUPON_ARCHIVE', entityType: 'Coupon', entityId: coupon._id, storeId: coupon.storeId, before, after: auditSnapshot(coupon, COUPON_AUDIT_FIELDS) });
  res.json({ success: true, archived: true, coupon });
});

exports.restoreCoupon = asyncHandler(async (req, res) => {
  const coupon = await Coupon.findOne(andFilter({ _id: requireObjectId(req.params.id, 'coupon id'), isArchived: true }, req.tenantFilter));
  if (!coupon) throw notFound('Archived coupon not found');
  if (coupon.campaignId) throw new ApiError('VALIDATION_ERROR', 'This coupon is managed by Campaigns. Restore the campaign instead.');
  coupon.isArchived = false; coupon.archivedAt = undefined; coupon.isActive = false; coupon.revision = Number(coupon.revision || 0) + 1;
  await coupon.save();
  logAudit({ req, action: 'COUPON_RESTORE', entityType: 'Coupon', entityId: coupon._id, storeId: coupon.storeId, after: auditSnapshot(coupon, COUPON_AUDIT_FIELDS) });
  res.json(coupon);
});

exports.duplicateCoupon = asyncHandler(async (req, res) => {
  const source = await Coupon.findOne(andFilter({ _id: requireObjectId(req.params.id, 'coupon id') }, req.tenantFilter)).lean();
  if (!source) throw notFound('Coupon not found');
  const copy = { ...source };
  delete copy._id; delete copy.__v; delete copy.createdAt; delete copy.updatedAt; delete copy.archivedAt; delete copy.campaignId;
  const suffix = String(Date.now()).slice(-4);
  copy.code = `${String(source.code).slice(0, 27)}_${suffix}`;
  copy.title = `${source.title || source.code} copy`.slice(0, 120);
  copy.isActive = false; copy.isArchived = false; copy.usedCount = 0; copy.spentAmount = 0; copy.revision = 0;
  const coupon = await Coupon.create(copy);
  logAudit({ req, action: 'COUPON_DUPLICATE', entityType: 'Coupon', entityId: coupon._id, storeId: coupon.storeId, after: auditSnapshot(coupon, COUPON_AUDIT_FIELDS) });
  res.status(201).json(coupon);
});

function readPositiveQuantity(value, field) {
  const number = Number(value ?? 1);
  if (!Number.isInteger(number) || number < 1 || number > 100) throw new ApiError('VALIDATION_ERROR', `${field} must be a whole number between 1 and 100`);
  return number;
}

exports.livePublicQuery = livePublicQuery;
exports.publicCouponView = publicCouponView;
exports.readCouponPayload = readCouponPayload;
exports.validateCouponReferences = validateCouponReferences;
