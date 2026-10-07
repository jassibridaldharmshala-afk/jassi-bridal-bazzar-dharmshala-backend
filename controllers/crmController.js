const mongoose = require('mongoose');
const Cart = require('../models/Cart');
const Conversation = require('../models/Conversation');
const CustomerCrm = require('../models/CustomerCrm');
const Notification = require('../models/Notification');
const Order = require('../models/Order');
const Product = require('../models/Product');
const ReturnExchange = require('../models/ReturnExchange');
const Shipment = require('../models/Shipment');
const Store = require('../models/Store');
const User = require('../models/User');
const { CONSENT_SOURCES, CUSTOMER_LIFECYCLE_STATUSES, PRIVACY_REQUEST_STATUSES, PRIVACY_REQUEST_TYPES } = require('../models/CustomerCrm');
const { roleAllows } = require('../models/StoreMember');
const { asyncHandler } = require('../middleware/validate');
const { ApiError, forbidden, notFound } = require('../utils/apiError');
const { optionalString, requireArray, requireBoolean, requireEnum, requireObjectId } = require('../utils/validators');
const { CANONICAL_TAGS, DEFAULT_RULES, listCustomerRows, maskEmail, maskPhone, normalizeAcquisition, normalizeRules, normalizeTags } = require('../services/crmService');
const { logAudit } = require('../services/auditService');
const { andFilter } = require('../services/storeService');
const { isMasterOwner } = require('../config/masterOwner');

const SEGMENTS = ['All customers', 'VIP', 'Repeat Customer', 'New Customer', 'At Risk', 'Inactive', 'Abandoned Cart', 'High-value Cart', 'Frequent Return', 'High RTO', 'Checkout Restricted', 'COD Restricted', 'Needs Follow-up', 'No marketing consent', 'Active cart', 'Birthday upcoming', 'Anniversary upcoming', 'Instagram Customer', 'Facebook Customer', 'WhatsApp Customer'];
const SORTS = ['spend', 'orders', 'recent', 'oldest', 'name', 'returns', 'rto'];
const CHANNELS = ['whatsapp', 'sms', 'email'];

function permissions(req) {
  if (!req.storeMember) return { canWrite: true, canViewPii: true, canExport: true, canMarket: true, canManageRules: true, isMaster: isMasterOwner(req.user) };
  const role = req.storeMember.role;
  return {
    canWrite: roleAllows(role, 'crm.write'),
    canViewPii: roleAllows(role, 'crm.pii.read'),
    canExport: roleAllows(role, 'crm.export'),
    canMarket: roleAllows(role, 'marketing.write'),
    canManageRules: roleAllows(role, 'settings.write'), isMaster: false,
  };
}

function requireCapability(req, key, message) {
  if (!permissions(req)[key]) throw forbidden(message);
}

function listOptions(query = {}) {
  const segment = String(query.segment || 'All customers').trim();
  const sort = String(query.sort || 'spend').trim().toLowerCase();
  if (!SEGMENTS.includes(segment)) throw new ApiError('VALIDATION_ERROR', 'Choose a supported customer segment');
  if (!SORTS.includes(sort)) throw new ApiError('VALIDATION_ERROR', 'Choose a supported customer sort');
  return {
    page: Math.max(1, Number.parseInt(query.page, 10) || 1),
    limit: Math.min(100, Math.max(1, Number.parseInt(query.limit, 10) || 24)),
    search: optionalString(query.search, 'search', { max: 100 }), segment, sort,
  };
}

function crmScope(req) {
  if (!req.store?._id) throw new ApiError('STORE_REQUIRED', 'Choose a store before opening customers');
  return { storeId: req.store._id, tenantFilter: req.tenantFilter, rules: req.store.customerRules };
}

async function customerBelongsToStore(req, userId) {
  return (await Promise.all([
    Order.exists(andFilter({ user: userId }, req.tenantFilter)),
    Cart.exists(andFilter({ user: userId }, req.tenantFilter)),
  ])).some(Boolean);
}

async function requireStoreCustomer(req, userId) {
  const user = await User.findById(userId).select('name email phone isPhoneVerified isEmailVerified birthDate createdAt wishlist');
  if (!user || !(await customerBelongsToStore(req, userId))) throw notFound('Customer not found in this store');
  return user;
}

function cleanProfile(profile = {}) {
  const value = profile?.toObject ? profile.toObject() : profile;
  const manualTags = normalizeTags(value.tags);
  return {
    manualTags, tags: manualTags, notes: value.notes || '', acquisition: value.acquisition || '',
    lifecycleStatus: value.lifecycleStatus || 'ACTIVE', followUpAt: value.followUpAt || null, anniversaryDate: value.anniversaryDate || null,
    followUpNote: value.followUpNote || '', marketingConsent: value.marketingConsent === true,
    marketingConsentSource: value.marketingConsentSource || '', marketingConsentAt: value.marketingConsentAt || null,
    channelConsents: value.channelConsents || {}, restrictions: value.restrictions || {}, privacyRequests: value.privacyRequests || [], revision: Number(value.revision || 0),
  };
}

exports.list = asyncHandler(async (req, res) => {
  const result = await listCustomerRows(crmScope(req), listOptions(req.query));
  if (req.query.page === undefined && req.query.format !== 'workspace') return res.json(result.items);
  const items = result.items.map(({ notes: _notes, ...item }) => item);
  res.json({ ...result, items, segments: SEGMENTS, tags: CANONICAL_TAGS, capabilities: permissions(req) });
});

exports.get = asyncHandler(async (req, res) => {
  const userId = requireObjectId(req.params.userId, 'user id');
  const user = await requireStoreCustomer(req, userId);
  const access = permissions(req);
  const orderFilter = andFilter({ user: userId }, req.tenantFilter);
  const [metricResult, orders, returns, cart, profile, conversations, notifications] = await Promise.all([
    listCustomerRows(crmScope(req), { userId, limit: 1 }),
    Order.find(orderFilter).select('invoiceNumber orderItems shippingAddress paymentMethod paymentStatus paymentState orderStatus finalAmount refundedAmount createdAt deliveredAt shipment').sort('-createdAt').limit(50).lean(),
    ReturnExchange.find(andFilter({ user: userId }, req.tenantFilter)).select('order product type reason status quantity createdAt updatedAt').sort('-createdAt').limit(30).lean(),
    Cart.findOne(andFilter({ user: userId }, req.tenantFilter)).populate('items.product', 'name images primaryImage price stock category').lean(),
    CustomerCrm.findOne({ storeId: req.store._id, user: userId }).lean(),
    Conversation.find(andFilter({ customer: userId }, req.tenantFilter)).select('channel status subject order returnRequest assignedTo lastMessageAt createdAt').sort('-lastMessageAt').limit(20).lean(),
    Notification.find(andFilter({ user: userId, audience: 'CUSTOMER' }, req.tenantFilter)).select('event title message channel status readAt metadata createdAt').sort('-createdAt').limit(30).lean(),
  ]);
  const orderIds = orders.map((order) => order._id);
  const shipments = orderIds.length ? await Shipment.find(andFilter({ order: { $in: orderIds } }, req.tenantFilter)).select('order provider courierName awb trackingNumber status expectedDeliveryAt updatedAt').lean() : [];
  const shipmentByOrder = new Map(shipments.map((shipment) => [String(shipment.order), shipment]));
  const productCounts = new Map(); const sizeCounts = new Map(); const colorCounts = new Map(); const categoryCounts = new Map();
  for (const order of orders) {
    if (order.orderStatus === 'Cancelled' || order.paymentStatus === 'Failed') continue;
    for (const line of order.orderItems || []) {
      const quantity = Math.max(1, Number(line.quantity || 1));
      const productId = String(line.product || '');
      if (productId) productCounts.set(productId, (productCounts.get(productId) || 0) + quantity);
      if (line.size) sizeCounts.set(line.size, (sizeCounts.get(line.size) || 0) + quantity);
      if (line.color) colorCounts.set(line.color, (colorCounts.get(line.color) || 0) + quantity);
      if (line.categoryName) categoryCounts.set(line.categoryName, (categoryCounts.get(line.categoryName) || 0) + quantity);
    }
  }
  const productIds = [...productCounts.keys()].filter((id) => mongoose.Types.ObjectId.isValid(id));
  const products = productIds.length ? await Product.find(andFilter({ _id: { $in: productIds } }, req.tenantFilter)).select('name images primaryImage category').populate('category', 'name').lean() : [];
  const productById = new Map(products.map((product) => [String(product._id), product]));
  const favoriteProducts = [...productCounts.entries()].map(([id, quantity]) => ({ product: productById.get(id), quantity })).filter((item) => item.product).sort((a, b) => b.quantity - a.quantity).slice(0, 5);
  if (!categoryCounts.size) for (const item of favoriteProducts) {
    const category = item.product.category?.name;
    if (category) categoryCounts.set(category, (categoryCounts.get(category) || 0) + item.quantity);
  }
  const addresses = [];
  for (const order of orders) {
    const address = order.shippingAddress || {};
    const key = [address.houseNo, address.area, address.city, address.state, address.pincode].filter(Boolean).join('|').toLowerCase();
    if (key && !addresses.some((item) => item.key === key)) addresses.push({ key, ...address });
  }
  const wishlistIds = Array.isArray(user.wishlist) ? user.wishlist : [];
  const wishlist = wishlistIds.length ? await Product.find(andFilter({ _id: { $in: wishlistIds } }, req.tenantFilter)).select('name images primaryImage price stock').limit(20).lean() : [];
  const row = metricResult.items[0] || {};
  res.json({
    customer: {
      id: String(user._id), name: user.name || 'Customer',
      ...(access.canViewPii ? { phone: user.phone || '', email: user.email || '' } : { phone: maskPhone(user.phone), email: maskEmail(user.email) }),
      isPhoneVerified: Boolean(user.isPhoneVerified), isEmailVerified: Boolean(user.isEmailVerified), birthDate: user.birthDate || null, customerSince: user.createdAt,
    },
    metrics: row, profile: cleanProfile(profile || {}),
    orders: orders.map((order) => ({ ...order, shipment: shipmentByOrder.get(String(order._id)) || null, shippingAddress: undefined })),
    returns,
    cart: cart ? { updatedAt: cart.updatedAt, items: cart.items || [] } : null,
    addresses: access.canViewPii ? addresses.map(({ key, ...address }) => address) : [],
    wishlist,
    insights: {
      favoriteProducts,
      preferredSizes: [...sizeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([value, count]) => ({ value, count })),
      preferredColors: [...colorCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([value, count]) => ({ value, count })),
      favoriteCategories: [...categoryCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([value, count]) => ({ value, count })),
    },
    conversations, notifications, capabilities: access,
  });
});

function readDate(value, field) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new ApiError('VALIDATION_ERROR', `${field} must be a valid date`);
  return date;
}

function readChannelConsents(input, actor, existing = {}) {
  if (input === undefined) return undefined;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError('VALIDATION_ERROR', 'Channel consent details are invalid');
  const result = {};
  for (const channel of CHANNELS) {
    if (input[channel] === undefined) continue;
    const item = input[channel] || {};
    const granted = requireBoolean(item.granted, `${channel} consent`);
    const source = granted ? requireEnum(item.source || 'MANUAL', CONSENT_SOURCES.filter(Boolean), `${channel} consent source`) : '';
    const reference = optionalString(item.reference, `${channel} consent reference`, { max: 240 });
    const previous = existing?.[channel]?.toObject?.() || existing?.[channel] || {};
    const unchanged = Boolean(previous.granted) === granted && String(previous.source || '') === source && String(previous.reference || '') === reference;
    result[channel] = unchanged ? previous : {
      granted, source, reference,
      recordedAt: granted ? new Date() : previous.recordedAt,
      revokedAt: granted ? undefined : new Date(), capturedBy: actor,
    };
  }
  return result;
}

exports.update = asyncHandler(async (req, res) => {
  requireCapability(req, 'canWrite', 'You do not have permission to edit customer profiles');
  const userId = requireObjectId(req.params.userId, 'user id');
  const user = await requireStoreCustomer(req, userId);
  const existing = await CustomerCrm.findOne({ storeId: req.store._id, user: userId });
  const suppliedRevision = Number(req.body?.revision ?? 0);
  if (!Number.isInteger(suppliedRevision) || suppliedRevision < 0) throw new ApiError('VALIDATION_ERROR', 'A valid customer profile revision is required');
  if (suppliedRevision !== Number(existing?.revision || 0)) throw new ApiError('CUSTOMER_CHANGED', 'This customer profile changed in another session. Reload it before saving.', { statusCode: 409 });
  const tags = req.body?.manualTags !== undefined || req.body?.tags !== undefined
    ? normalizeTags(requireArray(req.body.manualTags ?? req.body.tags, 'tags', { min: 0, max: 20 }).map((tag) => requireEnum(tag, CANONICAL_TAGS, 'tag')))
    : undefined;
  const notes = req.body?.notes !== undefined ? optionalString(req.body.notes, 'notes', { max: 2000 }) : undefined;
  const acquisition = req.body?.acquisition !== undefined ? normalizeAcquisition(optionalString(req.body.acquisition, 'acquisition', { max: 80 })) : undefined;
  const lifecycleStatus = req.body?.lifecycleStatus !== undefined ? requireEnum(req.body.lifecycleStatus, CUSTOMER_LIFECYCLE_STATUSES, 'lifecycle status') : undefined;
  const followUpAt = readDate(req.body?.followUpAt, 'follow up date');
  const anniversaryDate = readDate(req.body?.anniversaryDate, 'anniversary date');
  const followUpNote = req.body?.followUpNote !== undefined ? optionalString(req.body.followUpNote, 'follow up note', { max: 500 }) : undefined;
  const channelConsents = readChannelConsents(req.body?.channelConsents, req.user?._id, existing?.channelConsents);
  const legacyConsent = req.body?.marketingConsent !== undefined ? requireBoolean(req.body.marketingConsent, 'marketing consent') : undefined;
  const effectiveWhatsapp = channelConsents?.whatsapp?.granted ?? legacyConsent;
  const set = {
    ...(tags !== undefined ? { tags } : {}), ...(notes !== undefined ? { notes } : {}), ...(acquisition !== undefined ? { acquisition } : {}),
    ...(lifecycleStatus !== undefined ? { lifecycleStatus } : {}), ...(followUpAt !== undefined ? { followUpAt } : {}), ...(anniversaryDate !== undefined ? { anniversaryDate } : {}),
    ...(followUpNote !== undefined ? { followUpNote } : {}), ...(channelConsents !== undefined ? { channelConsents: { ...(existing?.channelConsents?.toObject?.() || existing?.channelConsents || {}), ...channelConsents } } : {}),
    ...(effectiveWhatsapp !== undefined ? { marketingConsent: effectiveWhatsapp, marketingConsentSource: effectiveWhatsapp ? (channelConsents?.whatsapp?.source || existing?.marketingConsentSource || 'MANUAL') : '', marketingConsentAt: effectiveWhatsapp ? (existing?.marketingConsent === effectiveWhatsapp ? existing.marketingConsentAt : new Date()) : null } : {}),
  };
  const filter = { storeId: req.store._id, user: userId, ...(existing ? { revision: suppliedRevision } : { $or: [{ revision: 0 }, { revision: { $exists: false } }] }) };
  let profile;
  try {
    profile = await CustomerCrm.findOneAndUpdate(filter, { $set: set, $inc: { revision: 1 } }, { new: true, upsert: !existing, setDefaultsOnInsert: true, runValidators: true });
  } catch (error) {
    if (error?.code === 11000) throw new ApiError('CUSTOMER_CHANGED', 'This customer profile changed in another session. Reload it before saving.', { statusCode: 409 });
    throw error;
  }
  if (!profile) throw new ApiError('CUSTOMER_CHANGED', 'This customer profile changed in another session. Reload it before saving.', { statusCode: 409 });
  await logAudit({ req, action: 'CRM_UPDATE', entityType: 'CustomerCrm', entityId: profile._id, storeId: req.store._id, before: existing ? { tags: normalizeTags(existing.tags), lifecycleStatus: existing.lifecycleStatus, followUpAt: existing.followUpAt, marketingConsent: existing.marketingConsent } : {}, after: { tags: normalizeTags(profile.tags), lifecycleStatus: profile.lifecycleStatus, followUpAt: profile.followUpAt, marketingConsent: profile.marketingConsent }, summary: `Customer profile updated for ${user.name || user.phone || userId}` });
  res.json({ userId, ...cleanProfile(profile) });
});

exports.updateRestrictions = asyncHandler(async (req, res) => {
  requireCapability(req, 'canWrite', 'You do not have permission to change customer restrictions');
  const userId = requireObjectId(req.params.userId, 'user id');
  const user = await requireStoreCustomer(req, userId);
  const existing = await CustomerCrm.findOne({ storeId: req.store._id, user: userId });
  const suppliedRevision = Number(req.body?.revision ?? 0);
  if (suppliedRevision !== Number(existing?.revision || 0)) throw new ApiError('CUSTOMER_CHANGED', 'This customer profile changed in another session. Reload it before saving.', { statusCode: 409 });
  const restrictions = {
    checkoutRestricted: requireBoolean(req.body?.checkoutRestricted ?? false, 'checkout restriction'),
    codRestricted: requireBoolean(req.body?.codRestricted ?? false, 'COD restriction'),
    marketingSuppressed: requireBoolean(req.body?.marketingSuppressed ?? false, 'marketing suppression'),
    supportWatchlist: requireBoolean(req.body?.supportWatchlist ?? false, 'support watchlist'),
    reason: optionalString(req.body?.reason, 'restriction reason', { max: 500 }), expiresAt: readDate(req.body?.expiresAt, 'restriction expiry'),
    updatedBy: req.user?._id, updatedAt: new Date(),
  };
  if ((restrictions.checkoutRestricted || restrictions.codRestricted || restrictions.marketingSuppressed || restrictions.supportWatchlist) && !restrictions.reason) throw new ApiError('VALIDATION_ERROR', 'Add a reason before applying a customer restriction');
  const filter = { storeId: req.store._id, user: userId, ...(existing ? { revision: suppliedRevision } : {}) };
  const profile = await CustomerCrm.findOneAndUpdate(filter, { $set: { restrictions }, $inc: { revision: 1 } }, { new: true, upsert: !existing, setDefaultsOnInsert: true, runValidators: true });
  if (!profile) throw new ApiError('CUSTOMER_CHANGED', 'This customer profile changed in another session. Reload it before saving.', { statusCode: 409 });
  await logAudit({ req, action: 'CUSTOMER_RESTRICTIONS_UPDATE', entityType: 'CustomerCrm', entityId: profile._id, storeId: req.store._id, before: existing?.restrictions || {}, after: restrictions, summary: `Store restrictions updated for ${user.name || user.phone || userId}` });
  res.json({ userId, restrictions: profile.restrictions, revision: profile.revision });
});

async function createPrivacyRequest({ req, userId, source }) {
  const type = requireEnum(req.body?.type, PRIVACY_REQUEST_TYPES, 'privacy request type');
  const reason = optionalString(req.body?.reason, 'privacy request reason', { max: 500 });
  const profile = await CustomerCrm.findOneAndUpdate(
    { storeId: req.store._id, user: userId },
    { $setOnInsert: { storeId: req.store._id, user: userId } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
  const active = profile.privacyRequests.some((item) => item.type === type && ['OPEN', 'IN_PROGRESS'].includes(item.status));
  if (active) throw new ApiError('CUSTOMER_CHANGED', 'An active request of this type already exists.', { statusCode: 409 });
  profile.privacyRequests.push({ type, source, reason, requestedBy: req.user?._id, dueAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) });
  profile.revision = Number(profile.revision || 0) + 1;
  await profile.save();
  const created = profile.privacyRequests[profile.privacyRequests.length - 1];
  await logAudit({ req, action: 'CUSTOMER_PRIVACY_REQUEST_CREATE', entityType: 'CustomerCrm', entityId: profile._id, storeId: req.store._id, after: { requestId: created._id, type, status: created.status, source } });
  return created;
}

exports.createPrivacyRequest = asyncHandler(async (req, res) => {
  requireCapability(req, 'canWrite', 'You do not have permission to manage privacy requests');
  const userId = requireObjectId(req.params.userId, 'user id');
  await requireStoreCustomer(req, userId);
  res.status(201).json(await createPrivacyRequest({ req, userId, source: 'STAFF' }));
});

exports.updatePrivacyRequest = asyncHandler(async (req, res) => {
  requireCapability(req, 'canWrite', 'You do not have permission to manage privacy requests');
  const userId = requireObjectId(req.params.userId, 'user id');
  const requestId = requireObjectId(req.params.requestId, 'privacy request id');
  await requireStoreCustomer(req, userId);
  const profile = await CustomerCrm.findOne({ storeId: req.store._id, user: userId });
  const privacyRequest = profile?.privacyRequests?.id(requestId);
  if (!privacyRequest) throw notFound('Privacy request not found');
  const status = requireEnum(req.body?.status, PRIVACY_REQUEST_STATUSES, 'privacy request status');
  const resolution = optionalString(req.body?.resolution, 'privacy request resolution', { max: 500 });
  if (['COMPLETED', 'REJECTED'].includes(status) && !resolution) throw new ApiError('VALIDATION_ERROR', 'Add a resolution before closing this privacy request');
  const previousStatus = privacyRequest.status;
  privacyRequest.status = status;
  privacyRequest.resolution = resolution;
  privacyRequest.handledBy = req.user?._id;
  privacyRequest.completedAt = ['COMPLETED', 'REJECTED', 'CANCELLED'].includes(status) ? new Date() : undefined;
  profile.revision = Number(profile.revision || 0) + 1;
  await profile.save();
  await logAudit({ req, action: 'CUSTOMER_PRIVACY_REQUEST_UPDATE', entityType: 'CustomerCrm', entityId: profile._id, storeId: req.store._id, before: { requestId, status: previousStatus }, after: { requestId, type: privacyRequest.type, status } });
  res.json(privacyRequest);
});

exports.listOwnPrivacyRequests = asyncHandler(async (req, res) => {
  if (!req.store?._id || !(await customerBelongsToStore(req, req.user._id))) throw notFound('No customer relationship was found for this store');
  const profile = await CustomerCrm.findOne({ storeId: req.store._id, user: req.user._id }).select('privacyRequests').lean();
  res.json(profile?.privacyRequests || []);
});

exports.createOwnPrivacyRequest = asyncHandler(async (req, res) => {
  if (!req.store?._id || !(await customerBelongsToStore(req, req.user._id))) throw notFound('No customer relationship was found for this store');
  res.status(201).json(await createPrivacyRequest({ req, userId: req.user._id, source: 'CUSTOMER' }));
});

exports.bulkTags = asyncHandler(async (req, res) => {
  requireCapability(req, 'canWrite', 'You do not have permission to update customer tags');
  const customerIds = requireArray(req.body?.customerIds, 'customers', { min: 1, max: 100 }).map((id) => requireObjectId(id, 'customer id'));
  const add = normalizeTags((req.body?.add || []).map((tag) => requireEnum(tag, CANONICAL_TAGS, 'tag')));
  const remove = normalizeTags((req.body?.remove || []).map((tag) => requireEnum(tag, CANONICAL_TAGS, 'tag')));
  if (!add.length && !remove.length) throw new ApiError('VALIDATION_ERROR', 'Choose at least one tag to add or remove');
  const allowed = new Set((await listCustomerRows(crmScope(req), { limit: 5000, exportAll: true })).items.map((item) => item.userId));
  if (customerIds.some((id) => !allowed.has(id))) throw forbidden('Every selected customer must belong to the active store');
  if (add.length) {
    await CustomerCrm.updateMany({ storeId: req.store._id, user: { $in: customerIds } }, { $addToSet: { tags: { $each: add } }, $inc: { revision: 1 } }, { upsert: false });
    for (const userId of customerIds) if (!await CustomerCrm.exists({ storeId: req.store._id, user: userId })) await CustomerCrm.create({ storeId: req.store._id, user: userId, tags: add, revision: 1 });
  }
  if (remove.length) await CustomerCrm.updateMany({ storeId: req.store._id, user: { $in: customerIds } }, { $pull: { tags: { $in: remove } }, $inc: { revision: 1 } });
  await logAudit({ req, action: 'CRM_BULK_TAGS', entityType: 'CustomerCrm', entityId: req.store._id, storeId: req.store._id, after: { customerCount: customerIds.length, add, remove } });
  res.json({ success: true, updated: customerIds.length });
});

exports.exportCustomers = asyncHandler(async (req, res) => {
  requireCapability(req, 'canExport', 'You do not have permission to export customer data');
  const options = { ...listOptions(req.query), page: 1, limit: 5000, exportAll: true };
  const result = await listCustomerRows(crmScope(req), options);
  const users = await User.find({ _id: { $in: result.items.map((row) => row.userId) } }).select('phone email').lean();
  const contactByUser = new Map(users.map((user) => [String(user._id), user]));
  res.json({
    filename: `customers-${req.store.slug || 'store'}-${new Date().toISOString().slice(0, 10)}.csv`,
    rows: result.items.map((row) => ({
      Name: row.name, Phone: contactByUser.get(row.userId)?.phone || '', Email: contactByUser.get(row.userId)?.email || '', Orders: row.orders, PaidOrders: row.paidOrders,
      NetSpend: row.netSpend, Refunds: row.refunded, AOV: row.aov, Returns: row.returns, RTO: row.rtoCount,
      LastOrder: row.lastOrderAt || '', Acquisition: row.acquisition, Tags: row.tags.join(' | '), BirthdayUpcoming: row.birthdayUpcoming ? 'Yes' : 'No', AnniversaryUpcoming: row.anniversaryUpcoming ? 'Yes' : 'No', MarketingConsent: row.marketingConsent ? 'Yes' : 'No',
    })),
  });
});

exports.updateRules = asyncHandler(async (req, res) => {
  requireCapability(req, 'canManageRules', 'You do not have permission to change customer rules');
  const requested = normalizeRules(req.body || {});
  const rules = {
    vipSpend: Math.min(100000000, requested.vipSpend), repeatOrders: Math.min(100, requested.repeatOrders),
    inactiveDays: Math.min(730, requested.inactiveDays), frequentReturnCount: Math.min(100, requested.frequentReturnCount),
    highRtoMinimumOrders: Math.min(100, requested.highRtoMinimumOrders), highRtoRate: requested.highRtoRate,
    highValueCart: Math.min(100000000, requested.highValueCart), newCustomerDays: Math.min(180, requested.newCustomerDays),
  };
  const previous = normalizeRules(req.store.customerRules || DEFAULT_RULES);
  const store = await Store.findByIdAndUpdate(req.store._id, { $set: { customerRules: rules } }, { new: true, runValidators: true }).select('customerRules');
  await logAudit({ req, action: 'CRM_RULES_UPDATE', entityType: 'Store', entityId: req.store._id, storeId: req.store._id, before: previous, after: rules });
  res.json(normalizeRules(store.customerRules));
});

exports.SEGMENTS = SEGMENTS;
