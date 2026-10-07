const mongoose = require('mongoose');
const AnalyticsEvent = require('../models/AnalyticsEvent');
const AuditLog = require('../models/AuditLog');
const Cart = require('../models/Cart');
const Campaign = require('../models/Campaign');
const Coupon = require('../models/Coupon');
const CustomerCrm = require('../models/CustomerCrm');
const InstagramConnection = require('../models/InstagramConnection');
const Notification = require('../models/Notification');
const Order = require('../models/Order');
const Product = require('../models/Product');
const ReturnExchange = require('../models/ReturnExchange');
const Settings = require('../models/Settings');
const User = require('../models/User');
const { buildCustomerRows, listCustomerRows } = require('./crmService');
const { andFilter, defaultStoreFilter } = require('./storeService');
const { ApiError } = require('../utils/apiError');
const { requireObjectId } = require('../utils/validators');

const DAY = 24 * 60 * 60 * 1000;

function scopeFor(store, extra = {}) {
  const tenant = store?.isDefault ? defaultStoreFilter(store._id) : { storeId: store._id };
  return andFilter(extra, tenant);
}

function activeCouponFilter(now = new Date(), extra = {}) {
  return andFilter(extra, {
    isActive: true,
    isArchived: { $ne: true },
    $and: [
      { $or: [{ expiryDate: { $exists: false } }, { expiryDate: null }, { expiryDate: { $gt: now } }] },
      { $or: [{ validFrom: { $exists: false } }, { validFrom: null }, { validFrom: { $lte: now } }] },
      { $or: [{ usageLimit: { $exists: false } }, { usageLimit: null }, { usageLimit: 0 }, { $expr: { $lt: [{ $ifNull: ['$usedCount', 0] }, '$usageLimit'] } }] },
      { $or: [{ totalBudget: { $exists: false } }, { totalBudget: null }, { totalBudget: 0 }, { $expr: { $lt: [{ $ifNull: ['$spentAmount', 0] }, '$totalBudget'] } }] },
    ],
  });
}

function round(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function productImage(product) {
  return product?.primaryImage || product?.images?.find((image) => image?.primary)?.url || product?.images?.[0]?.url || '';
}

async function storeSettings(store) {
  const scoped = await Settings.findOne({ storeId: store._id }).lean();
  if (scoped || !store.isDefault) return scoped || {};
  return (await Settings.findOne({ $or: [{ storeId: null }, { storeId: { $exists: false } }] }).lean()) || {};
}

async function listAbandonedCarts(store, { page = 1, limit = 20, minimumAgeMinutes = 30 } = {}) {
  const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
  const safeLimit = Math.min(50, Math.max(1, Number.parseInt(limit, 10) || 20));
  const ageMinutes = Math.min(10080, Math.max(15, Number.parseInt(minimumAgeMinutes, 10) || 30));
  const products = await Product.find(scopeFor(store, { isArchived: { $ne: true } }))
    .select('name price stock primaryImage images')
    .lean();
  if (!products.length) return { items: [], page: safePage, limit: safeLimit, total: 0, totalPages: 1 };

  const byProduct = new Map(products.map((product) => [String(product._id), product]));
  const cutoff = new Date(Date.now() - ageMinutes * 60 * 1000);
  const retention = new Date(Date.now() - 90 * DAY);
  const carts = await Cart.find(scopeFor(store, {
    'items.product': { $in: products.map((product) => product._id) },
    updatedAt: { $gte: retention, $lte: cutoff },
  })).populate('user', 'name phone email isBlocked').sort('-updatedAt').limit(500).lean();

  const users = carts.map((cart) => cart.user?._id).filter(Boolean);
  const earliest = carts.length ? carts[carts.length - 1].updatedAt : cutoff;
  const completed = users.length
    ? await Order.find(scopeFor(store, { user: { $in: users }, createdAt: { $gte: earliest } })).select('user createdAt').lean()
    : [];
  const ordersByUser = new Map();
  completed.forEach((order) => {
    const key = String(order.user || '');
    const dates = ordersByUser.get(key) || [];
    dates.push(new Date(order.createdAt).getTime());
    ordersByUser.set(key, dates);
  });

  const rows = carts.map((cart) => {
    const lines = (cart.items || []).map((line) => {
      const product = byProduct.get(String(line.product || ''));
      if (!product) return null;
      const quantity = Math.max(1, Number(line.quantity || 1));
      return {
        productId: String(product._id),
        name: product.name,
        image: productImage(product),
        quantity,
        price: round(product.price),
        lineTotal: round(product.price * quantity),
        available: Number(product.stock || 0) > 0,
      };
    }).filter(Boolean);
    const userId = String(cart.user?._id || cart.user || '');
    const converted = (ordersByUser.get(userId) || []).some((time) => time >= new Date(cart.updatedAt).getTime());
    if (!lines.length || converted) return null;
    return {
      id: String(cart._id),
      customer: cart.user && !cart.user.isBlocked ? {
        id: userId,
        name: cart.user.name || 'Customer',
        phone: cart.user.phone || '',
        email: cart.user.email || '',
      } : null,
      items: lines,
      itemCount: lines.reduce((sum, line) => sum + line.quantity, 0),
      value: round(lines.reduce((sum, line) => sum + line.lineTotal, 0)),
      abandonedAt: cart.updatedAt,
      ageMinutes: Math.max(0, Math.round((Date.now() - new Date(cart.updatedAt).getTime()) / 60000)),
    };
  }).filter(Boolean);

  const cartIds = rows.map((row) => row.id);
  const reminderRows = cartIds.length ? await Notification.find({
    storeId: store._id,
    event: { $in: ['ABANDONED_CART_REMINDER', 'ABANDONED_CART_WHATSAPP_PREPARED'] },
    'metadata.cartId': { $in: cartIds },
  }).select('event channel status metadata createdAt').sort('-createdAt').lean() : [];
  const latestByCart = new Map();
  reminderRows.forEach((reminder) => {
    const cartId = String(reminder.metadata?.cartId || '');
    if (cartId && !latestByCart.has(cartId)) latestByCart.set(cartId, reminder);
  });
  rows.forEach((row) => {
    const latest = latestByCart.get(row.id);
    if (!latest) return;
    row.lastReminderAt = latest.createdAt;
    row.lastReminderChannel = latest.channel;
    row.lastReminderStatus = latest.status;
  });

  const start = (safePage - 1) * safeLimit;
  return {
    items: rows.slice(start, start + safeLimit),
    page: safePage,
    limit: safeLimit,
    total: rows.length,
    totalPages: Math.max(1, Math.ceil(rows.length / safeLimit)),
  };
}

async function createRecoveryReminder(store, cartId, { channel = 'IN_APP', couponCode = '' } = {}) {
  requireObjectId(cartId, 'cart id');
  const normalizedChannel = String(channel || '').trim().toUpperCase();
  if (!['IN_APP', 'WHATSAPP_LINK'].includes(normalizedChannel)) {
    throw new ApiError('VALIDATION_ERROR', 'Choose an in-app reminder or WhatsApp message');
  }
  const cart = await Cart.findOne(scopeFor(store, { _id: cartId })).populate('user', 'name phone email isBlocked').lean();
  if (!cart) throw new ApiError('NOT_FOUND', 'Cart not found');
  const productIds = (cart.items || []).map((line) => line.product).filter(Boolean);
  const products = await Product.find(scopeFor(store, { _id: { $in: productIds }, isArchived: { $ne: true } }))
    .select('name price')
    .lean();
  if (!products.length) throw new ApiError('FORBIDDEN', 'This cart does not belong to the active store');
  if (!cart.user?._id || cart.user.isBlocked) throw new ApiError('VALIDATION_ERROR', 'A verified customer account is required for recovery');

  let coupon = null;
  const normalizedCoupon = String(couponCode || '').trim().toUpperCase();
  if (normalizedCoupon) {
    coupon = await Coupon.findOne(scopeFor(store, activeCouponFilter(new Date(), { code: normalizedCoupon }))).select('code').lean();
    if (!coupon) throw new ApiError('INVALID_COUPON', 'Choose an active coupon from this store');
  }

  const names = products.slice(0, 2).map((product) => product.name).join(', ');
  const offer = coupon ? ` Use code ${coupon.code} at checkout.` : '';
  const message = `You left ${names || 'items'} in your bag at ${store.name}.${offer} Complete your order while stock is available.`;
  if (normalizedChannel === 'WHATSAPP_LINK') {
    const phone = String(cart.user.phone || '').replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '');
    if (!/^[6-9]\d{9}$/.test(phone)) throw new ApiError('VALIDATION_ERROR', 'This customer does not have a valid WhatsApp number');
    const consent = await CustomerCrm.findOneAndUpdate({
      storeId: store._id,
      user: cart.user._id,
      marketingConsent: true,
      $or: [
        { lastWhatsAppRecoveryPreparedAt: { $exists: false } },
        { lastWhatsAppRecoveryPreparedAt: null },
        { lastWhatsAppRecoveryPreparedAt: { $lt: new Date(Date.now() - DAY) } },
      ],
    }, { $set: { lastWhatsAppRecoveryPreparedAt: new Date() } }, { new: true }).lean();
    if (!consent) {
      const profile = await CustomerCrm.findOne({ storeId: store._id, user: cart.user._id }).select('marketingConsent').lean();
      if (!profile?.marketingConsent) throw new ApiError('CONSENT_REQUIRED', 'Record customer consent in CRM before preparing a WhatsApp recovery message');
      throw new ApiError('DUPLICATE_REQUEST', 'A WhatsApp recovery message was already prepared for this customer in the last 24 hours');
    }
    await Notification.create({
      storeId: store._id,
      user: cart.user._id,
      event: 'ABANDONED_CART_WHATSAPP_PREPARED',
      title: 'Shopping bag reminder prepared',
      message,
      channel: 'WHATSAPP',
      status: 'QUEUED',
      audience: 'CUSTOMER',
      metadata: { cartId: String(cart._id), couponCode: coupon?.code || '', requiresReview: true },
      dedupeKey: `${store._id}:${cart.user._id}:abandoned-whatsapp:${new Date().toISOString().slice(0, 10)}`,
    });
    return {
      channel: normalizedChannel,
      requiresReview: true,
      url: `https://wa.me/91${phone}?text=${encodeURIComponent(message)}`,
      message,
    };
  }

  const recent = await Notification.findOne({
    storeId: store._id,
    user: cart.user._id,
    event: 'ABANDONED_CART_REMINDER',
    createdAt: { $gte: new Date(Date.now() - DAY) },
  }).select('_id createdAt').lean();
  if (recent) throw new ApiError('DUPLICATE_REQUEST', 'This customer already received a cart reminder in the last 24 hours');
  const reminder = await Notification.create({
    storeId: store._id,
    user: cart.user._id,
    event: 'ABANDONED_CART_REMINDER',
    title: 'Your shopping bag is waiting',
    message,
    channel: 'IN_APP',
    status: 'SENT',
    audience: 'CUSTOMER',
    metadata: { cartId: String(cart._id), couponCode: coupon?.code || '' },
    dedupeKey: `${store._id}:${cart.user._id}:abandoned:${new Date().toISOString().slice(0, 10)}`,
  });
  return { channel: normalizedChannel, sent: true, reminderId: String(reminder._id) };
}

async function createCustomerOffer(store, payload = {}) {
  const customerIds = [...new Set((Array.isArray(payload.customerIds) ? payload.customerIds : [])
    .map((value) => String(value || '').trim()).filter(Boolean))];
  if (!customerIds.length || customerIds.length > 100 || customerIds.some((id) => !mongoose.Types.ObjectId.isValid(id))) {
    throw new ApiError('VALIDATION_ERROR', 'Choose between 1 and 100 customers from this store');
  }
  const channel = String(payload.channel || 'IN_APP').trim().toUpperCase();
  if (!['IN_APP', 'WHATSAPP_LINK'].includes(channel)) throw new ApiError('VALIDATION_ERROR', 'Choose in-app or WhatsApp review');
  if (channel === 'WHATSAPP_LINK' && customerIds.length > 10) throw new ApiError('VALIDATION_ERROR', 'Prepare WhatsApp messages for at most 10 customers at a time');

  const title = String(payload.title || 'A special offer for you').trim();
  const customMessage = String(payload.message || '').trim();
  if (!title || title.length > 100 || customMessage.length > 500) throw new ApiError('VALIDATION_ERROR', 'Keep the offer title under 100 characters and message under 500 characters');
  const couponCode = String(payload.couponCode || '').trim().toUpperCase();
  let coupon = null;
  if (couponCode) {
    coupon = await Coupon.findOne(scopeFor(store, activeCouponFilter(new Date(), { code: couponCode }))).select('code').lean();
    if (!coupon) throw new ApiError('INVALID_COUPON', 'Choose an active coupon from this store');
  }

  const customerResult = await listCustomerRows({ storeId: store._id, tenantFilter: scopeFor(store), rules: store.customerRules }, { limit: 5000, exportAll: true });
  const allowed = new Set(customerResult.items.map((row) => row.userId));
  if (customerIds.some((id) => !allowed.has(id))) throw new ApiError('FORBIDDEN', 'Every selected customer must belong to the active store');
  const customers = await User.find({ _id: { $in: customerIds }, isBlocked: { $ne: true } }).select('name phone').lean();
  const byId = new Map(customers.map((customer) => [String(customer._id), customer]));
  const offerText = customMessage || `We selected a special offer for you at ${store.name}.`;
  const message = `${offerText}${coupon ? ` Use code ${coupon.code} at checkout.` : ''}`;

  if (channel === 'WHATSAPP_LINK') {
    const profiles = await CustomerCrm.find({ storeId: store._id, user: { $in: customerIds } })
      .select('user marketingConsent channelConsents restrictions lastWhatsAppOfferPreparedAt').lean();
    const profileByUser = new Map(profiles.map((profile) => [String(profile.user), profile]));
    const cutoff = new Date(Date.now() - 7 * DAY);
    const items = await Promise.all(customerIds.map(async (id) => {
      const customer = byId.get(id);
      const phone = String(customer?.phone || '').replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '');
      const profile = profileByUser.get(id);
      const restrictionActive = !profile?.restrictions?.expiresAt || new Date(profile.restrictions.expiresAt) > new Date();
      if (restrictionActive && profile?.restrictions?.marketingSuppressed) return { customerId: id, name: customer?.name || 'Customer', available: false, reason: 'Marketing is suppressed for this customer' };
      const whatsappConsent = profile?.channelConsents?.whatsapp?.granted === true || profile?.marketingConsent === true;
      if (!whatsappConsent) return { customerId: id, name: customer?.name || 'Customer', available: false, reason: 'WhatsApp marketing consent is not recorded' };
      if (!customer || !/^[6-9]\d{9}$/.test(phone)) return { customerId: id, name: customer?.name || 'Customer', available: false, reason: 'Valid WhatsApp number unavailable' };
      if (profile.lastWhatsAppOfferPreparedAt && new Date(profile.lastWhatsAppOfferPreparedAt) >= cutoff) {
        return { customerId: id, name: customer.name || 'Customer', available: false, reason: 'A WhatsApp offer was prepared in the last 7 days' };
      }
      const reserved = await CustomerCrm.findOneAndUpdate({
        _id: profile._id,
        $and: [
          { $or: [{ 'channelConsents.whatsapp.granted': true }, { marketingConsent: true }] },
          { $or: [
            { lastWhatsAppOfferPreparedAt: { $exists: false } },
            { lastWhatsAppOfferPreparedAt: null },
            { lastWhatsAppOfferPreparedAt: { $lt: cutoff } },
          ] },
          { $or: [
            { 'restrictions.marketingSuppressed': { $ne: true } },
            { 'restrictions.expiresAt': { $lte: new Date() } },
          ] },
        ],
      }, { $set: { lastWhatsAppOfferPreparedAt: new Date() } }, { new: true }).lean();
      if (!reserved) return { customerId: id, name: customer.name || 'Customer', available: false, reason: 'A recent WhatsApp offer is already pending review' };
      return { customerId: id, name: customer.name || 'Customer', available: true, url: `https://wa.me/91${phone}?text=${encodeURIComponent(message)}` };
    }));
    return {
      channel,
      requiresReview: true,
      message,
      items,
      prepared: items.filter((item) => item.available).length,
      skipped: items.filter((item) => !item.available).length,
    };
  }

  const suppressedProfiles = await CustomerCrm.find({
    storeId: store._id, user: { $in: customerIds }, 'restrictions.marketingSuppressed': true,
    $or: [{ 'restrictions.expiresAt': { $exists: false } }, { 'restrictions.expiresAt': null }, { 'restrictions.expiresAt': { $gt: new Date() } }],
  }).select('user').lean();
  const suppressed = new Set(suppressedProfiles.map((profile) => String(profile.user)));
  const recentCutoff = new Date(Date.now() - 7 * DAY);
  const recent = await Notification.find({
    storeId: store._id, user: { $in: customerIds }, event: 'CRM_OFFER',
    'metadata.couponCode': coupon?.code || '', createdAt: { $gte: recentCutoff },
  }).select('user').lean();
  const alreadySent = new Set(recent.map((item) => String(item.user)));
  const recipients = customerIds.filter((id) => byId.has(id) && !alreadySent.has(id) && !suppressed.has(id));
  if (recipients.length) {
    await Notification.insertMany(recipients.map((userId) => ({
      storeId: store._id, user: userId, event: 'CRM_OFFER', title, message,
      channel: 'IN_APP', status: 'SENT', audience: 'CUSTOMER',
      metadata: { couponCode: coupon?.code || '', source: 'CRM' },
    })));
  }
  return { channel, sent: recipients.length, skipped: customerIds.length - recipients.length, message };
}

function parseBusinessRange(query = {}) {
  const key = String(query.range || '30d').toLowerCase();
  const days = { '7d': 7, '30d': 30, '90d': 90 }[key];
  const end = new Date();
  let start;
  let label;
  if (days) {
    start = new Date(end.getTime() - days * DAY);
    label = `Last ${days} days`;
  } else if (key === 'custom' && query.from && query.to) {
    start = new Date(`${String(query.from).slice(0, 10)}T00:00:00.000Z`);
    const requestedEnd = new Date(`${String(query.to).slice(0, 10)}T23:59:59.999Z`);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(requestedEnd.getTime()) || start > requestedEnd) {
      throw new ApiError('VALIDATION_ERROR', 'Choose a valid business report date range');
    }
    if (requestedEnd.getTime() - start.getTime() > 365 * DAY) throw new ApiError('VALIDATION_ERROR', 'Business reports support up to 365 days at a time');
    if (requestedEnd < end) end.setTime(requestedEnd.getTime());
    label = `${String(query.from).slice(0, 10)} to ${String(query.to).slice(0, 10)}`;
  } else {
    throw new ApiError('VALIDATION_ERROR', 'Choose 7d, 30d, 90d or a valid custom range');
  }
  const duration = Math.max(DAY, end.getTime() - start.getTime());
  const previousEnd = new Date(start.getTime() - 1);
  const previousStart = new Date(previousEnd.getTime() - duration);
  return { key, label, start, end, previousStart, previousEnd };
}

function emptyOrderPeriod() {
  return { orders: 0, paidRevenue: 0, bookedRevenue: 0, delivered: 0, cancelled: 0, averageOrderValue: 0 };
}

function orderPayable(order) {
  return Number(order?.adjustedFinalAmount ?? order?.finalAmount ?? 0);
}

function orderNetRevenue(order) {
  const base = String(order?.paymentMethod || '').toUpperCase() === 'COD'
    ? orderPayable(order)
    : Number(order?.finalAmount || 0);
  return Math.max(0, base - Number(order?.refundedAmount || 0));
}

async function orderPerformance(store, range) {
  const rows = await Order.aggregate([
    { $match: scopeFor(store, { createdAt: { $gte: range.previousStart, $lte: range.end } }) },
    { $project: {
      period: { $cond: [{ $gte: ['$createdAt', range.start] }, 'current', 'previous'] },
      finalAmount: { $ifNull: ['$finalAmount', 0] },
      payableAmount: { $ifNull: ['$adjustedFinalAmount', { $ifNull: ['$finalAmount', 0] }] },
      collectedBase: { $cond: [{ $eq: ['$paymentMethod', 'COD'] }, { $ifNull: ['$adjustedFinalAmount', { $ifNull: ['$finalAmount', 0] }] }, { $ifNull: ['$finalAmount', 0] }] },
      refundedAmount: { $ifNull: ['$refundedAmount', 0] }, paymentStatus: 1, orderStatus: 1,
    } },
    { $group: {
      _id: '$period',
      total: { $sum: 1 },
      orders: { $sum: { $cond: [{ $not: [{ $in: ['$orderStatus', ['Cancelled', 'Returned', 'Refunded']] }] }, 1, 0] } },
      paidRevenue: { $sum: { $cond: [{ $and: [{ $eq: ['$paymentStatus', 'Paid'] }, { $not: [{ $in: ['$orderStatus', ['Cancelled', 'Returned', 'Refunded']] }] }] }, { $max: [0, { $subtract: ['$collectedBase', '$refundedAmount'] }] }, 0] } },
      bookedRevenue: { $sum: { $cond: [{ $not: [{ $in: ['$orderStatus', ['Cancelled', 'Returned', 'Refunded']] }] }, '$payableAmount', 0] } },
      delivered: { $sum: { $cond: [{ $eq: ['$orderStatus', 'Delivered'] }, 1, 0] } },
      cancelled: { $sum: { $cond: [{ $eq: ['$orderStatus', 'Cancelled'] }, 1, 0] } },
    } },
  ]);
  const periods = { current: emptyOrderPeriod(), previous: emptyOrderPeriod() };
  rows.forEach((row) => {
    const value = {
      orders: Number(row.orders || 0),
      totalOrders: Number(row.total || 0),
      paidRevenue: round(row.paidRevenue),
      bookedRevenue: round(row.bookedRevenue),
      delivered: Number(row.delivered || 0),
      cancelled: Number(row.cancelled || 0),
    };
    value.averageOrderValue = value.orders ? round(value.bookedRevenue / value.orders) : 0;
    value.cancellationRate = value.totalOrders ? round((value.cancelled / value.totalOrders) * 100) : 0;
    periods[row._id] = value;
  });
  const compare = (key) => periods.previous[key]
    ? round(((periods.current[key] - periods.previous[key]) / periods.previous[key]) * 100)
    : periods.current[key] ? null : 0;
  return { ...periods, change: { orders: compare('orders'), paidRevenue: compare('paidRevenue'), bookedRevenue: compare('bookedRevenue'), averageOrderValue: compare('averageOrderValue') } };
}

async function funnelPerformance(store, range) {
  const rows = await AnalyticsEvent.aggregate([
    { $match: scopeFor(store, { createdAt: { $gte: range.previousStart, $lte: range.end }, name: { $in: ['STORE_VIEW', 'PRODUCT_VIEW', 'ADD_TO_CART', 'BEGIN_CHECKOUT', 'PURCHASE'] } }) },
    { $group: { _id: { period: { $cond: [{ $gte: ['$createdAt', range.start] }, 'current', 'previous'] }, name: '$name' }, count: { $sum: 1 } } },
  ]);
  const result = { current: {}, previous: {} };
  rows.forEach((row) => { result[row._id.period][row._id.name] = Number(row.count || 0); });
  for (const period of ['current', 'previous']) {
    const views = result[period].STORE_VIEW || 0;
    result[period].conversionRate = views ? round(((result[period].PURCHASE || 0) / views) * 100) : 0;
  }
  return result;
}

async function recoveryPerformance(store, range) {
  const reminders = await Notification.find({
    storeId: store._id,
    event: 'ABANDONED_CART_REMINDER',
    status: 'SENT',
    createdAt: { $gte: range.start, $lte: range.end },
  }).select('user createdAt').lean();
  const users = [...new Set(reminders.map((item) => String(item.user || '')).filter(Boolean))];
  if (!users.length) return { remindersSent: 0, customersContacted: 0, recoveredOrders: 0, recoveredRevenue: 0 };
  const firstReminder = new Map();
  reminders.forEach((item) => {
    const id = String(item.user);
    const time = new Date(item.createdAt).getTime();
    if (!firstReminder.has(id) || time < firstReminder.get(id)) firstReminder.set(id, time);
  });
  const orders = await Order.find(scopeFor(store, {
    user: { $in: users }, createdAt: { $gte: range.start, $lte: new Date(range.end.getTime() + 7 * DAY) },
    orderStatus: { $nin: ['Cancelled', 'Returned', 'Refunded'] },
  })).select('user finalAmount adjustedFinalAmount createdAt').lean();
  const recovered = orders.filter((order) => {
    const reminderAt = firstReminder.get(String(order.user || ''));
    const orderedAt = new Date(order.createdAt).getTime();
    return reminderAt && orderedAt >= reminderAt && orderedAt <= reminderAt + 7 * DAY;
  });
  return {
    remindersSent: reminders.length,
    customersContacted: users.length,
    recoveredOrders: recovered.length,
    recoveredRevenue: round(recovered.reduce((sum, order) => sum + orderPayable(order), 0)),
  };
}

async function campaignPerformance(store, range) {
  const unified = await Campaign.find(scopeFor(store, { state: { $ne: 'ARCHIVED' } })).select('key offer.code state startsAt endsAt').limit(2000).lean();
  const legacy = store.festivalCampaign || {};
  const campaignKeys = new Set(unified.map((campaign) => String(campaign.key || '').toLowerCase()).filter(Boolean));
  const couponCodes = new Set(unified.map((campaign) => String(campaign.offer?.code || '').toUpperCase()).filter(Boolean));
  if (!unified.length) {
    const legacyCode = String(legacy.couponCode || '').toUpperCase();
    const legacyKey = String(legacy.campaignKey || legacy.preset || '').toLowerCase();
    if (legacyCode) couponCodes.add(legacyCode);
    if (legacyKey) campaignKeys.add(legacyKey);
  }
  if (!couponCodes.size && !campaignKeys.size) return { campaigns: unified.length, liveCampaigns: 0, orders: 0, revenue: 0, couponUses: 0 };
  const orders = await Order.find(scopeFor(store, {
    createdAt: { $gte: range.start, $lte: range.end },
    orderStatus: { $nin: ['Cancelled', 'Returned', 'Refunded'] },
  })).select('finalAmount adjustedFinalAmount refundedAmount paymentMethod paymentStatus orderStatus coupon attribution createdAt').lean();
  const byKey = new Map(unified.map((campaign) => [String(campaign.key || '').toLowerCase(), campaign]));
  const byCode = new Map(unified.map((campaign) => [String(campaign.offer?.code || '').toUpperCase(), campaign]).filter(([code]) => code));
  const matched = orders.filter((order) => {
    const orderCoupon = String(order.coupon?.code || '').toUpperCase();
    const attribution = String(order.attribution?.campaign || '').toLowerCase();
    if (!unified.length) return couponCodes.has(orderCoupon) || campaignKeys.has(attribution);
    const campaign = byKey.get(attribution) || byCode.get(orderCoupon);
    if (!campaign) return false;
    const orderedAt = new Date(order.createdAt).getTime();
    const startsAt = campaign.startsAt ? new Date(campaign.startsAt).getTime() : -Infinity;
    const attributionEndsAt = campaign.endsAt ? new Date(campaign.endsAt).getTime() + (7 * DAY) : Infinity;
    return orderedAt >= startsAt && orderedAt <= attributionEndsAt;
  });
  const now = Date.now();
  const paid = matched.filter((order) => order.paymentStatus === 'Paid'
    || (String(order.paymentMethod || '').toUpperCase() === 'COD' && order.orderStatus === 'Delivered'));
  return {
    campaigns: unified.length,
    liveCampaigns: unified.filter((campaign) => campaign.state === 'PUBLISHED'
      && (!campaign.startsAt || new Date(campaign.startsAt).getTime() <= now)
      && (!campaign.endsAt || new Date(campaign.endsAt).getTime() > now)).length,
    orders: matched.length,
    revenue: round(paid.reduce((sum, order) => sum + orderNetRevenue(order), 0)),
    couponUses: matched.filter((order) => couponCodes.has(String(order.coupon?.code || '').toUpperCase())).length,
  };
}

async function assistantHistory(store) {
  const rows = await AuditLog.find({ storeId: store._id, action: 'BUSINESS_ASSISTANT_QUERY', outcome: 'SUCCESS' })
    .select('summary after createdAt').sort('-createdAt').limit(5).lean();
  return rows.map((row) => ({
    id: String(row._id), question: row.after?.question || row.summary || '', answer: row.after?.answer || '',
    actions: Array.isArray(row.after?.actions) ? row.after.actions : [], generatedAt: row.createdAt,
  }));
}

async function buildBusinessHealth(store, query = {}) {
  const range = parseBusinessRange(query);
  const now = new Date();
  const [products, settings, performance, periodReturns, openReturns, instagram, abandoned, activeCoupons, fulfilmentOrders, funnel, recovery, history] = await Promise.all([
    Product.find(scopeFor(store, { isArchived: { $ne: true } })).select('name stock lowStockAlert images primaryImage metaTitle metaDescription isActive').lean(),
    storeSettings(store),
    orderPerformance(store, range),
    ReturnExchange.countDocuments(scopeFor(store, { createdAt: { $gte: range.start, $lte: range.end } })),
    ReturnExchange.countDocuments(scopeFor(store, { status: { $in: ['Requested', 'Approved'] } })),
    InstagramConnection.findOne({ storeId: store._id }).select('status username').lean(),
    listAbandonedCarts(store, { page: 1, limit: 1 }),
    Coupon.find(scopeFor(store, activeCouponFilter(now))).select('code title type discountValue benefitType expiryDate').sort('expiryDate').limit(50).lean(),
    Order.find(scopeFor(store, { orderStatus: { $in: ['Pending', 'Confirmed', 'Packed'] } })).select('finalAmount adjustedFinalAmount orderStatus').limit(500).lean(),
    funnelPerformance(store, range),
    recoveryPerformance(store, range),
    assistantHistory(store),
  ]);
  const activeProducts = products.filter((product) => product.isActive !== false);
  const withImages = activeProducts.filter((product) => product.primaryImage || product.images?.length).length;
  const withSeo = activeProducts.filter((product) => product.metaTitle && product.metaDescription).length;
  const lowStock = activeProducts.filter((product) => Number(product.stock || 0) <= Number(product.lowStockAlert ?? 5)).length;
  const checks = [
    healthCheck('identity', 'Store identity', 12, Boolean(store.name && (store.logo || settings.logoUrl) && (store.supportPhone || store.whatsappNumber || settings.contactPhone || settings.whatsappNumber)), 'Add your logo and a customer contact number.', 'settings'),
    healthCheck('catalog', 'Live catalogue', 18, activeProducts.length > 0 && withImages === activeProducts.length, 'Publish at least one product and add a clear photo to every live product.', 'products'),
    healthCheck('seo', 'Product discovery', 10, activeProducts.length > 0 && withSeo / activeProducts.length >= 0.7, 'Add search titles and descriptions to your live products.', 'products'),
    healthCheck('payments', 'Payments', 14, Boolean(store.paymentReady || settings.razorpayEnabled || settings.codEnabled), 'Confirm at least one payment method before taking orders.', 'settings'),
    healthCheck('shipping', 'Shipping and pickup', 14, Boolean((store.shippingReady || settings.shippingProvider) && (store.pickupAddress?.pincode || settings.shippingPickup?.pincode)), 'Complete the pickup address and shipping setup.', 'settings'),
    healthCheck('inventory', 'Inventory readiness', 10, activeProducts.length > 0 && lowStock / activeProducts.length <= 0.25, 'Restock low-stock products before promoting them.', 'inventory'),
    healthCheck('growth', 'Growth channels', 8, instagram?.status === 'CONNECTED' || Boolean(store.whatsappNumber || settings.whatsappNumber), 'Connect Instagram or add WhatsApp for assisted selling.', 'social'),
    healthCheck('recovery', 'Checkout recovery', 6, abandoned.total === 0, 'Review abandoned carts and send one respectful reminder.', 'business'),
    healthCheck('marketing', 'Active offer', 4, activeCoupons.length > 0, 'Create a targeted coupon or automatic offer.', 'offers'),
    healthCheck('engagement', 'Customer engagement', 4, performance.current.orders > 0, 'Promote a product and bring the first customer into your CRM.', 'crm'),
  ];
  const score = checks.reduce((sum, check) => sum + check.earned, 0);
  const campaign = await campaignPerformance(store, range);
  const priorities = [
    { id: 'fulfilment', title: 'Prepare customer orders', count: fulfilmentOrders.length, severity: fulfilmentOrders.length ? 'urgent' : 'complete', detail: fulfilmentOrders.length ? `${fulfilmentOrders.length} orders are waiting to be confirmed, packed or shipped.` : 'No orders are waiting for fulfilment.', route: 'orders' },
    { id: 'returns', title: 'Review return requests', count: openReturns, severity: openReturns ? 'attention' : 'complete', detail: openReturns ? `${openReturns} return or exchange requests need a decision.` : 'No return requests need a decision.', route: 'returns' },
    { id: 'inventory', title: 'Protect product availability', count: lowStock, severity: lowStock ? 'attention' : 'complete', detail: lowStock ? `${lowStock} live products are at or below their low-stock threshold.` : 'Live product stock is above its alert threshold.', route: 'inventory' },
    { id: 'recovery', title: 'Recover shopping bags', count: abandoned.total, severity: abandoned.total ? 'opportunity' : 'complete', detail: abandoned.total ? `${abandoned.total} signed-in shopping bags are eligible for a reminder.` : 'No eligible shopping bags are waiting.', route: 'business' },
  ];
  return {
    score,
    grade: score >= 85 ? 'Ready to grow' : score >= 70 ? 'Mostly ready' : score >= 50 ? 'Needs attention' : 'Setup required',
    checks,
    period: { key: range.key, label: range.label, from: range.start, to: range.end },
    performance: {
      ...performance,
      current: { ...performance.current, returns: periodReturns, returnRate: performance.current.orders ? round((periodReturns / performance.current.orders) * 100) : 0, conversionRate: funnel.current.conversionRate },
      previous: { ...performance.previous, conversionRate: funnel.previous.conversionRate },
      funnel: funnel.current,
    },
    priorities,
    recovery,
    campaign,
    assistantHistory: history,
    activeCoupons: activeCoupons.map((coupon) => ({ id: String(coupon._id), code: coupon.code, title: coupon.title || '', type: coupon.type, benefitType: coupon.benefitType, discountValue: coupon.discountValue, expiryDate: coupon.expiryDate })),
    metrics: {
      products: products.length,
      activeProducts: activeProducts.length,
      lowStock,
      orders30Days: performance.current.orders,
      paidRevenue30Days: performance.current.paidRevenue,
      openReturns,
      abandonedCarts: abandoned.total,
      activeCoupons: activeCoupons.length,
    },
    generatedAt: new Date(),
  };
}

function healthCheck(id, label, weight, passed, recommendation, route) {
  const sellerRoutes = {
    settings: '/seller/settings', products: '/seller/products', inventory: '/seller/inventory', social: '/seller/social',
    business: '/seller/business', offers: '/seller/offers', crm: '/seller/crm',
  };
  return { id, label, weight, earned: passed ? weight : 0, passed, recommendation: passed ? '' : recommendation, route: sellerRoutes[route] || '/seller/settings', routeKey: route };
}

async function answerBusinessQuestion(store, rawQuestion) {
  const question = String(rawQuestion || '').trim();
  if (question.length < 3 || question.length > 500) throw new ApiError('VALIDATION_ERROR', 'Ask a business question between 3 and 500 characters');
  const now = Date.now();
  const [products, orders, customers, abandoned] = await Promise.all([
    Product.find(scopeFor(store, { isArchived: { $ne: true } })).select('name stock lowStockAlert price isActive').lean(),
    Order.find(scopeFor(store, { createdAt: { $gte: new Date(now - 60 * DAY) }, orderStatus: { $ne: 'Cancelled' } })).select('orderItems finalAmount adjustedFinalAmount refundedAmount paymentMethod paymentStatus createdAt').lean(),
    buildCustomerRows(store._id),
    listAbandonedCarts(store, { page: 1, limit: 5 }),
  ]);
  const last30 = orders.filter((order) => new Date(order.createdAt).getTime() >= now - 30 * DAY);
  const previous30 = orders.filter((order) => {
    const time = new Date(order.createdAt).getTime();
    return time < now - 30 * DAY && time >= now - 60 * DAY;
  });
  const paid = (items) => round(items.filter((order) => order.paymentStatus === 'Paid').reduce((sum, order) => sum + orderNetRevenue(order), 0));
  const sold = new Map();
  last30.forEach((order) => (order.orderItems || []).forEach((line) => {
    const name = line.name || line.productName || 'Product';
    sold.set(name, (sold.get(name) || 0) + Math.max(0, Number(line.quantity || 1) - Number(line.cancelledQuantity || 0)));
  }));
  const ranked = [...sold.entries()].sort((a, b) => b[1] - a[1]);
  const facts = {
    revenueLast30Days: paid(last30),
    revenuePrevious30Days: paid(previous30),
    ordersLast30Days: last30.length,
    activeProducts: products.filter((item) => item.isActive !== false).length,
    lowStockProducts: products.filter((item) => Number(item.stock || 0) <= Number(item.lowStockAlert ?? 5)).map((item) => item.name).slice(0, 5),
    bestSellers: ranked.slice(0, 5).map(([name, units]) => ({ name, units })),
    productsWithoutSales: products.filter((item) => item.isActive !== false && !sold.has(item.name)).map((item) => item.name).slice(0, 8),
    abandonedCarts: abandoned.total,
    customers: customers.length,
    vipCustomers: customers.filter((item) => item.tags?.includes('VIP')).length,
    repeatCustomers: customers.filter((item) => item.tags?.includes('Repeat Customer')).length,
  };
  const comparison = facts.revenuePrevious30Days > 0
    ? round(((facts.revenueLast30Days - facts.revenuePrevious30Days) / facts.revenuePrevious30Days) * 100)
    : null;
  const lower = question.toLowerCase();
  let answer;
  let actions;
  if (/low|down|decreas|sale/.test(lower)) {
    answer = comparison === null
      ? `The store recorded Rs. ${facts.revenueLast30Days} in paid revenue during the last 30 days. There is not enough previous-period revenue for a reliable percentage comparison.`
      : `Paid revenue for the last 30 days is Rs. ${facts.revenueLast30Days}, ${Math.abs(comparison)}% ${comparison >= 0 ? 'higher' : 'lower'} than the previous 30 days.`;
    actions = buildActions(facts);
  } else if (/best|top|selling/.test(lower)) {
    answer = facts.bestSellers.length ? `The leading product is ${facts.bestSellers[0].name} with ${facts.bestSellers[0].units} units ordered in the last 30 days.` : 'No product sales were recorded in the last 30 days.';
    actions = facts.bestSellers.slice(0, 3).map((item) => `${item.name}: ${item.units} units`);
  } else if (/not sell|slow|dead/.test(lower)) {
    answer = facts.productsWithoutSales.length ? `${facts.productsWithoutSales.length} live products in this view have no recorded sales in the last 30 days.` : 'Every live product in this view has at least one recorded sale in the last 30 days.';
    actions = facts.productsWithoutSales.slice(0, 5);
  } else if (/stock|restock|inventory/.test(lower)) {
    answer = facts.lowStockProducts.length ? `${facts.lowStockProducts.length} products need an inventory review.` : 'No live product is currently at or below its low-stock threshold.';
    actions = facts.lowStockProducts;
  } else if (/customer|vip|repeat|target/.test(lower)) {
    answer = `This store has ${facts.customers} customers with orders: ${facts.vipCustomers} VIP and ${facts.repeatCustomers} repeat customers.`;
    actions = ['Use CRM tags to review a segment before creating an offer.', 'Avoid contacting customers who have not consented to an external channel.'];
  } else if (/cart|abandon|checkout/.test(lower)) {
    answer = `${facts.abandonedCarts} eligible carts are currently waiting for review.`;
    actions = ['Review item availability before sending a reminder.', 'Send no more than one in-app reminder per customer in 24 hours.'];
  } else {
    answer = `In the last 30 days this store recorded ${facts.ordersLast30Days} orders and Rs. ${facts.revenueLast30Days} in paid revenue across ${facts.activeProducts} live products.`;
    actions = buildActions(facts);
  }
  return { question, answer, actions: actions.filter(Boolean).slice(0, 5), facts, source: 'live_store_data', generatedAt: new Date() };
}

function buildActions(facts) {
  const actions = [];
  if (facts.abandonedCarts) actions.push(`Review ${facts.abandonedCarts} abandoned carts.`);
  if (facts.lowStockProducts.length) actions.push(`Restock ${facts.lowStockProducts.slice(0, 2).join(' and ')}.`);
  if (facts.productsWithoutSales.length) actions.push(`Review photos, price and visibility for ${facts.productsWithoutSales.slice(0, 2).join(' and ')}.`);
  if (!actions.length) actions.push('Keep the catalogue and stock levels current before the next campaign.');
  return actions;
}

async function updateFestivalCampaign(store, payload = {}) {
  const existing = typeof store.festivalCampaign?.toObject === 'function' ? store.festivalCampaign.toObject() : (store.festivalCampaign || {});
  const now = new Date();
  const enabled = Boolean(payload.enabled);
  const allowed = ['', 'diwali', 'wedding', 'eid', 'christmas', 'valentines', 'black-friday', 'new-year', 'holi'];
  const preset = String(payload.preset || '').trim().toLowerCase();
  if (!allowed.includes(preset)) throw new ApiError('VALIDATION_ERROR', 'Choose a supported campaign preset');
  const title = String(payload.title || '').trim();
  const badgeText = String(payload.badgeText || '').trim();
  const couponCode = String(payload.couponCode || '').trim().toUpperCase();
  const campaignKey = String(payload.campaignKey || (existing.preset === preset ? existing.campaignKey : '') || preset).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 80);
  if (title.length > 100 || badgeText.length > 60 || couponCode.length > 40) throw new ApiError('VALIDATION_ERROR', 'Campaign text is too long');
  if (enabled && (!preset || !title)) throw new ApiError('VALIDATION_ERROR', 'Choose a campaign preset and enter a title');
  let startsAt;
  if (payload.startsAt) {
    startsAt = new Date(payload.startsAt);
    if (!Number.isFinite(startsAt.getTime())) throw new ApiError('VALIDATION_ERROR', 'Choose a valid campaign start time');
  }
  let countdownEndsAt;
  if (payload.countdownEndsAt) {
    countdownEndsAt = new Date(payload.countdownEndsAt);
    if (!Number.isFinite(countdownEndsAt.getTime()) || (enabled && countdownEndsAt <= now)) throw new ApiError('VALIDATION_ERROR', 'Choose a future campaign end time');
  }
  if (startsAt && countdownEndsAt && startsAt >= countdownEndsAt) throw new ApiError('VALIDATION_ERROR', 'Campaign end time must be after its start time');
  if (couponCode) {
    const coupon = await Coupon.findOne(scopeFor(store, activeCouponFilter(now, { code: couponCode }))).select('_id').lean();
    if (!coupon) throw new ApiError('INVALID_COUPON', 'Choose an active coupon from this store');
  }
  store.festivalCampaign = {
    enabled, campaignKey, preset, title, badgeText, couponCode, startsAt, countdownEndsAt,
    effects: Boolean(payload.effects),
    publishedAt: enabled ? (existing.enabled && existing.publishedAt ? existing.publishedAt : now) : existing.publishedAt,
    pausedAt: !enabled && existing.enabled ? now : existing.pausedAt,
    updatedAt: now,
  };
  await store.save();
  return store.festivalCampaign;
}

module.exports = {
  answerBusinessQuestion,
  buildBusinessHealth,
  createCustomerOffer,
  createRecoveryReminder,
  listAbandonedCarts,
  scopeFor,
  updateFestivalCampaign,
};
