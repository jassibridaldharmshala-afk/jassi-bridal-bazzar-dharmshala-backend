const mongoose = require('mongoose');
const Cart = require('../models/Cart');
const CustomerCrm = require('../models/CustomerCrm');
const Order = require('../models/Order');
const ReturnExchange = require('../models/ReturnExchange');
const Shipment = require('../models/Shipment');
const User = require('../models/User');
const { CRM_TAGS } = require('../models/CustomerCrm');

const DAY = 24 * 60 * 60 * 1000;
const DEFAULT_RULES = Object.freeze({
  vipSpend: 10000,
  repeatOrders: 2,
  inactiveDays: 90,
  frequentReturnCount: 2,
  highRtoMinimumOrders: 2,
  highRtoRate: 0.4,
  highValueCart: 5000,
  newCustomerDays: 30,
});
const CANONICAL_TAGS = [...new Set(CRM_TAGS.filter((tag) => !['Repeat', 'New', 'Instagram'].includes(tag)))];
const TAG_ALIASES = { Repeat: 'Repeat Customer', New: 'New Customer', Instagram: 'Instagram Customer' };
const MEANINGFUL_RETURN_STATUSES = ['Approved', 'Pickup Scheduled', 'Received', 'Exchanged', 'Refunded', 'Closed'];
const RTO_STATUSES = ['RTO_IN_TRANSIT', 'RETURNED'];

const round = (value) => Math.round(Number(value || 0) * 100) / 100;
const idOf = (value) => String(value?._id || value || '');
const uniqueIds = (values = []) => [...new Set(values.map(idOf).filter((id) => mongoose.Types.ObjectId.isValid(id)))];

function normalizeTags(tags = []) {
  return [...new Set(tags.map((tag) => TAG_ALIASES[tag] || tag).filter((tag) => CANONICAL_TAGS.includes(tag)))];
}

function normalizeAcquisition(value = '') {
  const input = String(value || '').trim().replace(/\s+/g, ' ');
  const known = {
    instagram: 'Instagram', facebook: 'Facebook', whatsapp: 'WhatsApp', referral: 'Referral',
    'organic search': 'Organic Search', direct: 'Direct', marketplace: 'Marketplace', other: 'Other',
  };
  return known[input.toLowerCase()] || input.slice(0, 80);
}

function normalizeRules(value = {}) {
  const input = value?.toObject ? value.toObject() : value;
  return {
    vipSpend: Math.max(0, Number(input?.vipSpend ?? DEFAULT_RULES.vipSpend)),
    repeatOrders: Math.max(2, Number(input?.repeatOrders ?? DEFAULT_RULES.repeatOrders)),
    inactiveDays: Math.max(30, Number(input?.inactiveDays ?? DEFAULT_RULES.inactiveDays)),
    frequentReturnCount: Math.max(1, Number(input?.frequentReturnCount ?? DEFAULT_RULES.frequentReturnCount)),
    highRtoMinimumOrders: Math.max(1, Number(input?.highRtoMinimumOrders ?? DEFAULT_RULES.highRtoMinimumOrders)),
    highRtoRate: Math.min(1, Math.max(0.05, Number(input?.highRtoRate ?? DEFAULT_RULES.highRtoRate))),
    highValueCart: Math.max(0, Number(input?.highValueCart ?? DEFAULT_RULES.highValueCart)),
    newCustomerDays: Math.max(1, Number(input?.newCustomerDays ?? DEFAULT_RULES.newCustomerDays)),
  };
}

function maskPhone(phone = '') {
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 4) return digits ? '••••' : '';
  return `${'•'.repeat(Math.max(4, digits.length - 4))}${digits.slice(-4)}`;
}

function maskEmail(email = '') {
  const [name, domain] = String(email).split('@');
  if (!name || !domain) return '';
  return `${name.slice(0, 1)}${'•'.repeat(Math.max(3, name.length - 1))}@${domain}`;
}

function storeScope(storeId, tenantFilter) {
  return tenantFilter && Object.keys(tenantFilter).length ? tenantFilter : { storeId };
}

function validOrderExpression() {
  return { $and: [{ $ne: ['$orderStatus', 'Cancelled'] }, { $ne: ['$paymentStatus', 'Failed'] }, { $ne: ['$paymentState', 'FAILED'] }] };
}

function revenueOrderExpression() {
  return {
    $or: [
      { $in: ['$paymentState', ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED']] },
      { $in: ['$paymentStatus', ['Paid', 'Refunded']] },
      { $and: [{ $eq: [{ $toUpper: { $ifNull: ['$paymentMethod', ''] } }, 'COD'] }, { $eq: ['$orderStatus', 'Delivered'] }] },
    ],
  };
}

function refundExpression() {
  return {
    $max: [
      { $ifNull: ['$refundedAmount', 0] },
      {
        $sum: {
          $map: {
            input: { $filter: { input: { $ifNull: ['$refunds', []] }, as: 'refund', cond: { $eq: ['$$refund.status', 'PROCESSED'] } } },
            as: 'refund', in: { $ifNull: ['$$refund.amount', 0] },
          },
        },
      },
    ],
  };
}

async function aggregateOrderMetrics(scope, userIds) {
  if (!userIds.length) return [];
  const ids = userIds.map((id) => new mongoose.Types.ObjectId(id));
  const valid = validOrderExpression();
  const revenue = revenueOrderExpression();
  const refund = refundExpression();
  return Order.aggregate([
    { $match: { $and: [scope, { user: { $in: ids } }] } },
    { $sort: { createdAt: 1 } },
    {
      $group: {
        _id: '$user', orderIds: { $push: '$_id' },
        orders: { $sum: { $cond: [valid, 1, 0] } }, placedOrders: { $sum: 1 },
        paidOrders: { $sum: { $cond: [revenue, 1, 0] } },
        deliveredOrders: { $sum: { $cond: [{ $eq: ['$orderStatus', 'Delivered'] }, 1, 0] } },
        cancelledOrders: { $sum: { $cond: [{ $eq: ['$orderStatus', 'Cancelled'] }, 1, 0] } },
        grossSpend: { $sum: { $cond: [revenue, { $ifNull: ['$finalAmount', 0] }, 0] } },
        refunded: { $sum: { $cond: [revenue, refund, 0] } },
        firstOrderAt: { $min: '$createdAt' },
        lastOrderAt: { $max: '$createdAt' },
        codOrders: { $sum: { $cond: [{ $and: [valid, { $eq: [{ $toUpper: { $ifNull: ['$paymentMethod', ''] } }, 'COD'] }] }, 1, 0] } },
        prepaidOrders: { $sum: { $cond: [{ $and: [valid, { $ne: [{ $toUpper: { $ifNull: ['$paymentMethod', ''] } }, 'COD'] }] }, 1, 0] } },
        latestAcquisition: { $last: '$attribution.source' },
      },
    },
  ]);
}

async function aggregateReturns(scope, userIds) {
  if (!userIds.length) return [];
  return ReturnExchange.aggregate([
    { $match: { $and: [scope, { user: { $in: userIds.map((id) => new mongoose.Types.ObjectId(id)) } }, { status: { $in: MEANINGFUL_RETURN_STATUSES } }] } },
    { $group: { _id: '$user', returns: { $sum: { $cond: [{ $eq: ['$type', 'return'] }, 1, 0] } }, exchanges: { $sum: { $cond: [{ $eq: ['$type', 'exchange'] }, 1, 0] } } } },
  ]);
}

async function aggregateCarts(scope, userIds) {
  if (!userIds.length) return [];
  return Cart.aggregate([
    { $match: { $and: [scope, { user: { $in: userIds.map((id) => new mongoose.Types.ObjectId(id)) } }] } },
    {
      $project: {
        user: 1, updatedAt: 1,
        itemCount: { $sum: { $map: { input: { $ifNull: ['$items', []] }, as: 'item', in: { $ifNull: ['$$item.quantity', 1] } } } },
        cartValue: { $sum: { $map: { input: { $ifNull: ['$items', []] }, as: 'item', in: { $multiply: [{ $ifNull: ['$$item.price', 0] }, { $ifNull: ['$$item.quantity', 1] }] } } } },
      },
    },
  ]);
}

function smartTagsFor(row, rules, now = Date.now()) {
  const tags = [];
  const firstAge = row.firstOrderAt ? now - new Date(row.firstOrderAt).getTime() : Infinity;
  const idleAge = row.lastOrderAt ? now - new Date(row.lastOrderAt).getTime() : 0;
  if (row.orders === 1 && firstAge <= rules.newCustomerDays * DAY) tags.push('New Customer');
  if (row.orders >= rules.repeatOrders) tags.push('Repeat Customer');
  if (row.netSpend >= rules.vipSpend) tags.push('VIP');
  if (row.orders && idleAge > rules.inactiveDays * DAY) tags.push('Inactive');
  else if (row.orders && idleAge > Math.max(30, Math.floor(rules.inactiveDays * 0.65)) * DAY) tags.push('At Risk');
  if (row.returns >= rules.frequentReturnCount) tags.push('Frequent Return');
  if (row.orders >= rules.highRtoMinimumOrders && row.rtoCount / Math.max(1, row.orders) >= rules.highRtoRate) tags.push('High RTO');
  if (row.isAbandonedCart) tags.push('Abandoned Cart');
  if (row.cartValue >= rules.highValueCart && row.cartItems > 0) tags.push('High-value Cart');
  const source = String(row.acquisition || '').toLowerCase();
  if (source.includes('instagram')) tags.push('Instagram Customer');
  if (source.includes('facebook')) tags.push('Facebook Customer');
  if (source.includes('whatsapp')) tags.push('WhatsApp Customer');
  if (row.restrictions?.checkoutRestricted) tags.push('Checkout Restricted');
  if (row.restrictions?.codRestricted) tags.push('COD Restricted');
  if (row.followUpAt && new Date(row.followUpAt) <= new Date()) tags.push('Needs Follow-up');
  if (row.birthdayUpcoming) tags.push('Birthday Upcoming');
  if (row.anniversaryUpcoming) tags.push('Anniversary Upcoming');
  return [...new Set(tags)];
}

function segmentMatches(row, segment) {
  if (!segment || segment === 'All customers') return true;
  if (segment === 'No marketing consent') return !row.marketingConsent;
  if (segment === 'Active cart') return row.cartItems > 0;
  if (segment === 'Birthday upcoming') return row.birthdayUpcoming;
  if (segment === 'Anniversary upcoming') return row.anniversaryUpcoming;
  return row.tags.includes(segment);
}

function compareRows(sort) {
  const descending = (field) => (a, b) => Number(b[field] || 0) - Number(a[field] || 0);
  if (sort === 'orders') return descending('orders');
  if (sort === 'returns') return descending('returns');
  if (sort === 'rto') return descending('rtoCount');
  if (sort === 'oldest') return (a, b) => new Date(a.lastOrderAt || 0) - new Date(b.lastOrderAt || 0);
  if (sort === 'name') return (a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'en');
  if (sort === 'recent') return (a, b) => new Date(b.lastOrderAt || b.cartUpdatedAt || 0) - new Date(a.lastOrderAt || a.cartUpdatedAt || 0);
  return descending('netSpend');
}

function annualDateIsUpcoming(date, now = new Date()) {
  if (!date) return false;
  const birth = new Date(date);
  if (!Number.isFinite(birth.getTime())) return false;
  let next = new Date(now.getFullYear(), birth.getMonth(), birth.getDate());
  if (next < new Date(now.getFullYear(), now.getMonth(), now.getDate())) next = new Date(now.getFullYear() + 1, birth.getMonth(), birth.getDate());
  return next.getTime() - now.getTime() <= 30 * DAY;
}

function emptySummary() {
  return { total: 0, newCustomers: 0, repeat: 0, vip: 0, atRisk: 0, followUps: 0, netRevenue: 0 };
}

async function listCustomerRows({ storeId, tenantFilter, rules: rawRules } = {}, options = {}) {
  const scope = storeScope(storeId, tenantFilter);
  const rules = normalizeRules(rawRules);
  const [orderUserIds, cartUserIds] = await Promise.all([
    Order.distinct('user', scope), Cart.distinct('user', { $and: [scope, { user: { $ne: null } }] }),
  ]);
  let userIds = uniqueIds([...orderUserIds, ...cartUserIds]);
  if (options.userId) userIds = userIds.filter((id) => id === String(options.userId));
  if (!userIds.length) return { items: [], total: 0, page: 1, limit: Number(options.limit) || 24, totalPages: 1, summary: emptySummary(), rules };

  const userFilter = { _id: { $in: userIds.map((id) => new mongoose.Types.ObjectId(id)) } };
  const search = String(options.search || '').trim().slice(0, 100);
  if (search) {
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    userFilter.$or = [{ name: new RegExp(escaped, 'i') }, { email: new RegExp(escaped, 'i') }, { phone: new RegExp(escaped, 'i') }];
  }
  const users = await User.find(userFilter).select('name email phone isPhoneVerified isEmailVerified birthDate createdAt').lean();
  userIds = users.map(idOf);
  if (!userIds.length) return { items: [], total: 0, page: 1, limit: Number(options.limit) || 24, totalPages: 1, summary: emptySummary(), rules };

  const [orderMetrics, returnMetrics, carts, profiles] = await Promise.all([
    aggregateOrderMetrics(scope, userIds), aggregateReturns(scope, userIds), aggregateCarts(scope, userIds),
    CustomerCrm.find({ storeId, user: { $in: userIds } }).lean(),
  ]);
  const orderByUser = new Map(orderMetrics.map((item) => [idOf(item._id), item]));
  const returnsByUser = new Map(returnMetrics.map((item) => [idOf(item._id), item]));
  const cartByUser = new Map(carts.map((item) => [idOf(item.user), item]));
  const profileByUser = new Map(profiles.map((item) => [idOf(item.user), item]));
  const allOrderIds = orderMetrics.flatMap((item) => item.orderIds || []);
  const shipments = allOrderIds.length ? await Shipment.find({ $and: [scope, { order: { $in: allOrderIds } }, { status: { $in: RTO_STATUSES } }] }).select('order').lean() : [];
  const orderOwner = new Map(orderMetrics.flatMap((item) => (item.orderIds || []).map((orderId) => [idOf(orderId), idOf(item._id)])));
  const rtoByUser = new Map();
  for (const shipment of shipments) {
    const userId = orderOwner.get(idOf(shipment.order));
    if (userId) rtoByUser.set(userId, (rtoByUser.get(userId) || 0) + 1);
  }

  const now = Date.now();
  let rows = users.map((user) => {
    const userId = idOf(user);
    const orders = orderByUser.get(userId) || {};
    const returned = returnsByUser.get(userId) || {};
    const cart = cartByUser.get(userId) || {};
    const profile = profileByUser.get(userId) || {};
    const grossSpend = round(orders.grossSpend);
    const refunded = round(Math.min(grossSpend, Number(orders.refunded || 0)));
    const netSpend = round(Math.max(0, grossSpend - refunded));
    const restrictionExpiry = profile.restrictions?.expiresAt ? new Date(profile.restrictions.expiresAt) : null;
    const restrictions = restrictionExpiry && restrictionExpiry <= new Date() ? {} : (profile.restrictions || {});
    const row = {
      userId, name: user.name || 'Customer', phoneMasked: maskPhone(user.phone), emailMasked: maskEmail(user.email),
      isPhoneVerified: Boolean(user.isPhoneVerified), isEmailVerified: Boolean(user.isEmailVerified), customerSince: user.createdAt,
      orders: Number(orders.orders || 0), placedOrders: Number(orders.placedOrders || 0), paidOrders: Number(orders.paidOrders || 0),
      deliveredOrders: Number(orders.deliveredOrders || 0), cancelledOrders: Number(orders.cancelledOrders || 0),
      grossSpend, refunded, netSpend, spend: netSpend, aov: orders.paidOrders ? round(netSpend / orders.paidOrders) : 0,
      firstOrderAt: orders.firstOrderAt || null, lastOrderAt: orders.lastOrderAt || null,
      codOrders: Number(orders.codOrders || 0), prepaidOrders: Number(orders.prepaidOrders || 0),
      returns: Number(returned.returns || 0), exchanges: Number(returned.exchanges || 0), rtoCount: Number(rtoByUser.get(userId) || 0),
      cartItems: Number(cart.itemCount || 0), cartValue: round(cart.cartValue), cartUpdatedAt: cart.updatedAt || null,
      isAbandonedCart: Number(cart.itemCount || 0) > 0 && now - new Date(cart.updatedAt || now).getTime() >= 30 * 60 * 1000,
      acquisition: normalizeAcquisition(profile.acquisition || orders.latestAcquisition), manualTags: normalizeTags(profile.tags),
      notes: String(profile.notes || ''), notesPreview: String(profile.notes || '').slice(0, 140),
      marketingConsent: restrictions.marketingSuppressed ? false : profile.marketingConsent === true,
      channelConsents: profile.channelConsents || {}, restrictions, lifecycleStatus: profile.lifecycleStatus || 'ACTIVE',
      followUpAt: profile.followUpAt || null, followUpNote: profile.followUpNote || '', revision: Number(profile.revision || 0),
      birthdayUpcoming: annualDateIsUpcoming(user.birthDate), anniversaryUpcoming: annualDateIsUpcoming(profile.anniversaryDate),
    };
    row.smartTags = smartTagsFor(row, rules, now);
    row.tags = [...new Set([...row.manualTags, ...row.smartTags])];
    row.returnRate = row.deliveredOrders ? round(row.returns / row.deliveredOrders * 100) : 0;
    row.rtoRate = row.orders ? round(row.rtoCount / row.orders * 100) : 0;
    return row;
  });

  rows = rows.filter((row) => segmentMatches(row, String(options.segment || 'All customers')));
  rows.sort(compareRows(String(options.sort || 'spend')));
  const summary = rows.reduce((value, row) => {
    value.total += 1;
    value.newCustomers += row.smartTags.includes('New Customer') ? 1 : 0;
    value.repeat += row.tags.includes('Repeat Customer') ? 1 : 0;
    value.vip += row.tags.includes('VIP') ? 1 : 0;
    value.atRisk += row.tags.includes('At Risk') || row.tags.includes('Inactive') ? 1 : 0;
    value.followUps += row.tags.includes('Needs Follow-up') ? 1 : 0;
    value.netRevenue = round(value.netRevenue + row.netSpend);
    return value;
  }, emptySummary());
  const total = rows.length;
  const page = Math.max(1, Number(options.page) || 1);
  const limit = Math.min(options.exportAll ? 5000 : 100, Math.max(1, Number(options.limit) || 24));
  const start = (page - 1) * limit;
  return { items: rows.slice(start, start + limit), total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)), summary, rules };
}

async function buildCustomerRows(storeId) {
  const result = await listCustomerRows({ storeId, tenantFilter: { storeId } }, { limit: 5000 });
  return result.items;
}

module.exports = { CANONICAL_TAGS, CRM_TAGS, DEFAULT_RULES, MEANINGFUL_RETURN_STATUSES, RTO_STATUSES, buildCustomerRows, listCustomerRows, maskEmail, maskPhone, normalizeAcquisition, normalizeRules, normalizeTags };
