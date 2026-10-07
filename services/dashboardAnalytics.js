const { ApiError } = require('../utils/apiError');
const { andFilter } = require('./storeService');

const DAY = 86400000;
const OFFSET = 330 * 60000;
const TIMEZONE = 'Asia/Kolkata';
const ORDER_STATUSES = ['Pending', 'Confirmed', 'Packed', 'Shipped', 'Out for Delivery', 'Delivered', 'Cancelled', 'Return Requested', 'Exchange Requested', 'Returned', 'Refunded'];
const PAYMENT_STATUSES = ['Pending', 'Paid', 'Failed', 'Refunded'];
const CLOSED = ['Cancelled', 'Returned', 'Refunded'];
// An unpaid online checkout is not a sale or an order ready to fulfil.
const BOOKED = { orderStatus: { $nin: CLOSED }, paymentStatus: { $nin: ['Failed', 'Refunded'] }, $or: [{ paymentMethod: 'COD' }, { paymentStatus: 'Paid' }] };
const ATTENTION = {
  pending: andFilter(BOOKED, { orderStatus: 'Pending' }),
  packing: andFilter(BOOKED, { orderStatus: 'Confirmed' }),
  dispatch: andFilter(BOOKED, { orderStatus: 'Packed' }),
  transit: { orderStatus: { $in: ['Shipped', 'Out for Delivery'] } },
  cod: { orderStatus: { $nin: CLOSED }, paymentMethod: 'COD', codConfirmationStatus: 'PENDING', paymentStatus: 'Pending' },
  collection: { orderStatus: 'Delivered', paymentMethod: 'COD', paymentStatus: 'Pending' },
  resolution: { $or: [{ 'cancellationRefund.status': { $in: ['FAILED', 'MANUAL_REQUIRED'] } }, { itemCancellationRefunds: { $elemMatch: { status: { $in: ['FAILED', 'MANUAL_REQUIRED'] } } } }, { 'rto.refundStatus': { $in: ['FAILED', 'MANUAL_REQUIRED'] } }] },
  rto: { 'rto.status': { $in: ['IN_TRANSIT', 'RECEIVED', 'QC_PENDING', 'RESTOCKED', 'QUARANTINED', 'DAMAGED', 'MISSING', 'REFUND_PENDING'] } },
};
// A COD order is collected at its post-cancellation payable value. Online
// payments were captured at the original total and are reduced through the
// refund ledger, so their collected base remains finalAmount.
const payableAmount = { $ifNull: ['$adjustedFinalAmount', { $ifNull: ['$finalAmount', 0] }] };
const collectedBase = { $cond: [{ $eq: ['$paymentMethod', 'COD'] }, payableAmount, { $ifNull: ['$finalAmount', 0] }] };
const netPaidAmount = { $max: [0, { $subtract: [collectedBase, { $ifNull: ['$refundedAmount', 0] }] }] };
const activeItemQuantity = { $max: [0, { $subtract: [{ $ifNull: ['$orderItems.quantity', 1] }, { $ifNull: ['$orderItems.cancelledQuantity', 0] }] }] };
const dateKey = (date) => new Date(date.getTime() + OFFSET).toISOString().slice(0, 10);

function calendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid date (YYYY-MM-DD).');
  const date = new Date(`${value}T00:00:00+05:30`);
  if (!Number.isFinite(date.getTime()) || dateKey(date) !== value) throw new ApiError('VALIDATION_ERROR', 'Choose a valid calendar date.');
  return date;
}

function dashboardRange(query = {}, now = new Date()) {
  const today = calendarDate(dateKey(now));
  const preset = query.from || query.to ? 'custom' : (query.range || '30d');
  let from; let to = new Date(now.getTime() + 1);
  if (preset === 'custom') {
    from = calendarDate(query.from);
    const end = calendarDate(query.to);
    if (end < from || end > today) throw new ApiError('VALIDATION_ERROR', 'Choose an end date on or after the start date, up to today.');
    to = new Date(Math.min(end.getTime() + DAY, to.getTime()));
  } else if (preset === 'month') {
    from = calendarDate(`${dateKey(now).slice(0, 7)}-01`);
  } else {
    const days = { today: 1, '7d': 7, '30d': 30, '90d': 90 }[preset];
    if (!days) throw new ApiError('VALIDATION_ERROR', 'Choose a supported dashboard period.');
    from = new Date(today.getTime() - (days - 1) * DAY);
  }
  if (to - from > 366 * DAY) throw new ApiError('VALIDATION_ERROR', 'Choose a period of 366 days or less.');
  const days = Math.round((calendarDate(dateKey(new Date(to - 1))) - from) / DAY) + 1;
  const previousFrom = new Date(from.getTime() - (to - from));
  return { preset, from, to, previousFrom, days, granularity: days > 90 ? 'month' : 'day', timezone: TIMEZONE };
}

function periodFilter(range) { return { createdAt: { $gte: range.from, $lt: range.to } }; }
function metric(value = 0, previous = 0) {
  return { value, previous, delta: previous > 0 ? Math.round((value - previous) / previous * 1000) / 10 : value > 0 ? null : 0 };
}

function buildSeries(range, rows) {
  const map = new Map(rows.map(row => [row._id, row]));
  const keys = [];
  for (let date = new Date(range.from); date < range.to; date = new Date(date.getTime() + DAY)) {
    const key = dateKey(date).slice(0, range.granularity === 'month' ? 7 : 10);
    if (keys[keys.length - 1] !== key) keys.push(key);
  }
  return keys.map(key => ({ key, label: key, value: Number(map.get(key)?.value || 0), orders: Number(map.get(key)?.orders || 0) }));
}

// Alerts respect each product's configured threshold and active size/colour variants.
const activeVariants = { $filter: { input: { $ifNull: ['$variants', []] }, as: 'variant', cond: { $ne: ['$$variant.isActive', false] } } };
const availableStock = { $cond: [{ $gt: [{ $size: { $ifNull: ['$variants', []] } }, 0] }, { $sum: { $map: { input: activeVariants, as: 'variant', in: { $max: [0, { $ifNull: ['$$variant.stock', 0] }] } } } }, { $ifNull: ['$stock', 0] }] };
const stockWarning = { $or: [
  { $lte: [availableStock, { $ifNull: ['$lowStockAlert', 5] }] },
  { $anyElementTrue: [{ $map: { input: activeVariants, as: 'variant', in: { $lte: [{ $ifNull: ['$$variant.stock', 0] }, { $ifNull: ['$$variant.lowStockAlert', { $ifNull: ['$lowStockAlert', 5] }] }] } } }] },
] };

async function adminOrderFilter(query = {}, tenantFilter) {
  const OrderUser = require('../models/User');
  const Shipment = require('../models/Shipment');
  const filters = [];
  if (query.status) {
    if (!ORDER_STATUSES.includes(query.status)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid order status.');
    filters.push({ orderStatus: query.status });
  }
  if (query.payment) {
    if (!PAYMENT_STATUSES.includes(query.payment)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid payment status.');
    filters.push({ paymentStatus: query.payment });
  }
  if (query.paymentMethod) {
    const value = String(query.paymentMethod).toUpperCase();
    if (!['COD', 'ONLINE'].includes(value)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid payment method.');
    filters.push(value === 'COD' ? { paymentMethod: 'COD' } : { paymentMethod: { $ne: 'COD' } });
  }
  if (query.city) {
    if (typeof query.city !== 'string' || query.city.length > 100) throw new ApiError('VALIDATION_ERROR', 'City must be 100 characters or less.');
    const city = query.city.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (city) filters.push({ 'shippingAddress.city': { $regex: city, $options: 'i' } });
  }
  if (query.pincode) {
    const pincode = String(query.pincode).replace(/\D/g, '');
    if (!/^\d{6}$/.test(pincode)) throw new ApiError('VALIDATION_ERROR', 'PIN code must contain 6 digits.');
    filters.push({ 'shippingAddress.pincode': pincode });
  }
  if (query.provider) {
    const provider = String(query.provider).toLowerCase();
    if (!['manual', 'bluedart', 'shiprocket', 'delhivery', 'xpressbees'].includes(provider)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid delivery provider.');
    const shipments = await Shipment.find(andFilter({ provider }, tenantFilter)).select('_id').lean();
    filters.push({ shipment: { $in: shipments.map(item => item._id) } });
  }
  if (query.attention) {
    if (!ATTENTION[query.attention]) throw new ApiError('VALIDATION_ERROR', 'Choose a valid order task.');
    filters.push(ATTENTION[query.attention]);
  }
  if (query.returnOpen) {
    if (query.returnOpen !== '1') throw new ApiError('VALIDATION_ERROR', 'Choose a valid return queue filter.');
    filters.push({ orderStatus: { $in: ['Return Requested', 'Exchange Requested'] } });
  }
  if (query.from || query.to || query.range) filters.push(periodFilter(dashboardRange(query)));
  if (query.search) {
    if (typeof query.search !== 'string' || query.search.length > 100) throw new ApiError('VALIDATION_ERROR', 'Search must be 100 characters or less.');
    const text = query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!text) return andFilter(filters.length ? { $and: filters } : {}, tenantFilter);
    const regex = new RegExp(text, 'i');
    const [users, shipments] = await Promise.all([
      OrderUser.find({ $or: [{ name: regex }, { email: regex }, { phone: regex }] }).select('_id').lean(),
      Shipment.find(andFilter({ $or: [{ awb: regex }, { trackingNumber: regex }, { courierName: regex }] }, tenantFilter)).select('_id').lean(),
    ]);
    filters.push({ $or: [
      { user: { $in: users.map(user => user._id) } }, { invoiceNumber: regex },
      { 'shippingAddress.fullName': regex }, { 'shippingAddress.mobile': regex },
      { 'orderItems.name': regex }, { 'orderItems.sku': regex },
      { shipment: { $in: shipments.map(item => item._id) } },
      { $expr: { $regexMatch: { input: { $toString: '$_id' }, regex: text, options: 'i' } } },
    ] });
  }
  return andFilter(filters.length ? { $and: filters } : {}, tenantFilter);
}

async function dashboardOverview(query = {}, tenantFilter) {
  const Order = require('../models/Order');
  const Product = require('../models/Product');
  const ReturnExchange = require('../models/ReturnExchange');
  const range = dashboardRange(query);
  const attentionScope = query.attentionScope || 'period';
  if (!['period', 'all'].includes(attentionScope)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid task period.');
  const scoped = (filter = {}) => andFilter(filter, tenantFilter);
  const current = periodFilter(range);
  const previous = { createdAt: { $gte: range.previousFrom, $lt: range.from } };
  const attentionDates = attentionScope === 'period' ? current : {};
  const catalog = { isArchived: { $ne: true } };
  const activeCatalog = { ...catalog, isActive: true };
  const summary = (filter) => [
    { $match: filter },
    { $facet: {
      orders: [{ $count: 'value' }],
      paid: [{ $match: { paymentStatus: 'Paid' } }, { $group: { _id: null, value: { $sum: netPaidAmount } } }],
      booked: [{ $match: BOOKED }, { $group: { _id: null, value: { $sum: payableAmount }, count: { $sum: 1 } } }],
      customers: [{ $match: BOOKED }, { $group: { _id: '$user' } }, { $count: 'value' }],
    } },
  ];
  // Facets cannot nest. Keep the two period summaries as independent bounded queries.
  const [currentRows, previousRows, detailsRows, inventoryRows, operationsRows, returns] = await Promise.all([
    Order.aggregate([{ $match: scoped(current) }, ...summary({})]),
    Order.aggregate([{ $match: scoped(previous) }, ...summary({})]),
    Order.aggregate([
      { $match: scoped(current) },
      { $facet: {
        statuses: [{ $group: { _id: '$orderStatus', value: { $sum: 1 } } }],
        series: [{ $group: { _id: { $dateToString: { date: '$createdAt', format: range.granularity === 'month' ? '%Y-%m' : '%Y-%m-%d', timezone: TIMEZONE } }, value: { $sum: { $cond: [{ $eq: ['$paymentStatus', 'Paid'] }, netPaidAmount, 0] } }, orders: { $sum: 1 } } }],
        products: [{ $match: BOOKED }, { $sort: { createdAt: -1 } }, { $unwind: '$orderItems' }, { $group: {
          _id: { $ifNull: ['$orderItems.product', '$orderItems.name'] },
          productId: { $first: '$orderItems.product' }, name: { $first: '$orderItems.name' }, image: { $first: '$orderItems.image' },
          sold: { $sum: activeItemQuantity },
          revenue: { $sum: { $multiply: [{ $ifNull: ['$orderItems.price', 0] }, activeItemQuantity] } },
        } }, { $sort: { sold: -1, revenue: -1, _id: 1 } }, { $limit: 10 }],
      } },
    ]),
    Product.aggregate([{ $match: scoped() }, { $facet: {
      added: [{ $match: current }, { $count: 'value' }],
      previousAdded: [{ $match: previous }, { $count: 'value' }],
      total: [{ $match: catalog }, { $count: 'value' }],
      active: [{ $match: activeCatalog }, { $count: 'value' }],
      alerts: [{ $match: { ...activeCatalog, $expr: stockWarning } }, { $count: 'value' }],
      out: [{ $match: { ...activeCatalog, $expr: { $lte: [availableStock, 0] } } }, { $count: 'value' }],
      products: [{ $match: { ...activeCatalog, $expr: stockWarning } }, { $addFields: { availableStock } }, { $sort: { availableStock: 1, _id: 1 } }, { $limit: 6 }, { $project: { name: 1, sku: 1, availableStock: 1, lowStockAlert: 1 } }],
    } }]),
    Order.aggregate([{ $match: scoped(attentionDates) }, { $facet: Object.fromEntries(Object.entries(ATTENTION).map(([key, filter]) => [key, [{ $match: filter }, { $group: { _id: null, value: { $sum: 1 }, amount: { $sum: payableAmount } } }]])) }]),
    ReturnExchange.countDocuments(scoped({ ...attentionDates, status: 'Requested' })),
  ]);
  const c = currentRows[0] || {}; const p = previousRows[0] || {};
  const value = (row, key) => Number(row[key]?.[0]?.value || 0);
  const average = row => row.booked?.[0]?.count ? value(row, 'booked') / row.booked[0].count : 0;
  const details = detailsRows[0] || {}; const inventory = inventoryRows[0] || {};
  const orderPage = Math.min(100000, Math.max(1, parseInt(query.orderPage, 10) || 1));
  const orderLimit = [5, 10, 20].includes(Number(query.orderLimit)) ? Number(query.orderLimit) : 5;
  const total = value(c, 'orders'); const totalPages = Math.max(1, Math.ceil(total / orderLimit));
  const page = Math.min(orderPage, totalPages);
  const recentOrders = await Order.find(scoped(current)).select('user shippingAddress.fullName invoiceNumber createdAt finalAmount adjustedFinalAmount orderStatus paymentStatus paymentMethod orderItems.quantity orderItems.cancelledQuantity')
    .populate('user', 'name').sort({ createdAt: -1, _id: -1 }).skip((page - 1) * orderLimit).limit(orderLimit).lean();
  return {
    schemaVersion: 2,
    generatedAt: new Date(), range: { ...range, fromDate: dateKey(range.from), toDate: dateKey(new Date(range.to - 1)) },
    scopes: { performance: 'period', attention: attentionScope, inventory: 'live' },
    stats: { sales: metric(value(c, 'booked'), value(p, 'booked')), revenue: metric(value(c, 'paid'), value(p, 'paid')), orders: metric(total, value(p, 'orders')), customers: metric(value(c, 'customers'), value(p, 'customers')), average: metric(average(c), average(p)), products: metric(value(inventory, 'added'), value(inventory, 'previousAdded')) },
    salesOverview: buildSeries(range, details.series || []),
    orderOverview: ORDER_STATUSES.map(label => ({ label, value: details.statuses?.find(row => row._id === label)?.value || 0 })).filter(row => row.value),
    topProducts: (details.products || []).map(row => ({ ...row, id: row.productId ? String(row.productId) : '', key: String(row._id) })),
    recentOrders: recentOrders.map(order => ({ ...order, displayAmount: Number(order.adjustedFinalAmount ?? order.finalAmount ?? 0), itemsCount: order.orderItems?.reduce((sum, item) => sum + Math.max(0, Number(item.quantity || 0) - Number(item.cancelledQuantity || 0)), 0) || 0 })),
    recentPagination: { page, limit: orderLimit, total, totalPages },
    inventory: { total: value(inventory, 'total'), active: value(inventory, 'active'), alerts: value(inventory, 'alerts'), out: value(inventory, 'out'), products: inventory.products || [] },
    attention: { ...Object.fromEntries(Object.keys(ATTENTION).map(key => [key, operationsRows[0]?.[key]?.[0] || { value: 0, amount: 0 }])), returns: { value: returns } },
  };
}

module.exports = { dashboardOverview, dashboardRange, calendarDate, periodFilter, buildSeries, metric, adminOrderFilter, ATTENTION, BOOKED, stockWarning, availableStock, payableAmount, collectedBase, netPaidAmount };
