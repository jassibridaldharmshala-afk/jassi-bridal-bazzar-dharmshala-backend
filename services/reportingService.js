const mongoose = require('mongoose');
const AnalyticsEvent = require('../models/AnalyticsEvent');
const Category = require('../models/Category');
const Coupon = require('../models/Coupon');
const Order = require('../models/Order');
const Product = require('../models/Product');
const ReturnExchange = require('../models/ReturnExchange');
const Shipment = require('../models/Shipment');
const Store = require('../models/Store');
const User = require('../models/User');
const { BOOKED, availableStock } = require('./dashboardAnalytics');
const { andFilter } = require('./storeService');
const { ApiError } = require('../utils/apiError');

const DAY = 86400000;
const CLOSED = ['Cancelled', 'Returned', 'Refunded'];
const PAYMENT_METHODS = ['COD', 'UPI', 'CARD', 'Card', 'NETBANKING', 'WALLET', 'Razorpay'];
const ORDER_STATUSES = ['Pending', 'Confirmed', 'Packed', 'Shipped', 'Out for Delivery', 'Delivered', 'Cancelled', 'Return Requested', 'Exchange Requested', 'Returned', 'Refunded'];
const SECTIONS = ['summary', 'products', 'customers', 'marketing', 'fulfillment', 'traffic'];

const round = (value) => Math.round(Number(value || 0) * 100) / 100;
const number = (value) => Number(value || 0);
const metric = (value = 0, previous = 0) => ({
  value: round(value), previous: round(previous),
  delta: previous > 0 ? round(((value - previous) / previous) * 100) : value > 0 ? null : 0,
});

function safeTimezone(value) {
  const timezone = String(value || 'Asia/Kolkata').trim().slice(0, 60);
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date()); return timezone; }
  catch { return 'Asia/Kolkata'; }
}

function dateParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((item) => item.type !== 'literal').map((item) => [item.type, Number(item.value)]));
}

function dateKey(date, timezone) {
  const parts = dateParts(date, timezone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function calendarDate(value, timezone) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid report date (YYYY-MM-DD).');
  const nominal = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(nominal.getTime()) || nominal.toISOString().slice(0, 10) !== value) throw new ApiError('VALIDATION_ERROR', 'Choose a valid calendar date.');
  let result = nominal;
  for (let index = 0; index < 2; index += 1) {
    const parts = dateParts(result, timezone);
    const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    result = new Date(result.getTime() - (represented - nominal.getTime()));
  }
  if (dateKey(result, timezone) !== value) throw new ApiError('VALIDATION_ERROR', 'Choose a valid calendar date.');
  return result;
}

function reportRange(query = {}, timezone = 'Asia/Kolkata', now = new Date()) {
  const zone = safeTimezone(timezone);
  const todayKey = dateKey(now, zone);
  const today = calendarDate(todayKey, zone);
  const preset = query.from || query.to ? 'custom' : String(query.range || '30d').toLowerCase();
  let from;
  let to = new Date(now.getTime() + 1);
  if (preset === 'custom') {
    if (!query.from || !query.to) throw new ApiError('VALIDATION_ERROR', 'Choose both report start and end dates.');
    from = calendarDate(String(query.from), zone);
    const end = calendarDate(String(query.to), zone);
    if (end < from || end > today) throw new ApiError('VALIDATION_ERROR', 'Choose an end date on or after the start date, up to today.');
    to = new Date(Math.min(end.getTime() + DAY, to.getTime()));
  } else if (preset === 'yesterday') {
    from = new Date(today.getTime() - DAY);
    to = today;
  } else if (preset === 'month') {
    from = calendarDate(`${todayKey.slice(0, 7)}-01`, zone);
  } else {
    const days = { today: 1, '7d': 7, '30d': 30, '90d': 90 }[preset];
    if (!days) throw new ApiError('VALIDATION_ERROR', 'Choose today, 7d, 30d, month, 90d or a custom range.');
    from = new Date(today.getTime() - ((days - 1) * DAY));
  }
  if (to - from > 366 * DAY) throw new ApiError('VALIDATION_ERROR', 'Reports support a maximum range of 366 days.');
  const previousFrom = new Date(from.getTime() - (to.getTime() - from.getTime()));
  const days = Math.max(1, Math.round((calendarDate(dateKey(new Date(to - 1), zone), zone) - from) / DAY) + 1);
  return {
    preset, from, to, previousFrom, days, timezone: zone,
    granularity: days > 120 ? 'month' : 'day',
    fromDate: dateKey(from, zone), toDate: dateKey(new Date(to - 1), zone),
  };
}

function regex(value) {
  return new RegExp(String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

function objectId(value, field) {
  if (!value) return null;
  if (!mongoose.isValidObjectId(value)) throw new ApiError('VALIDATION_ERROR', `Choose a valid ${field}.`);
  return new mongoose.Types.ObjectId(value);
}

function cleanFilter(value, max = 120) { return String(value || '').trim().slice(0, max); }

async function reportFilters(query = {}, tenantFilter = {}) {
  const filters = [];
  if (tenantFilter && Object.keys(tenantFilter).length) filters.push(tenantFilter);
  const status = cleanFilter(query.status, 40);
  if (status) {
    if (!ORDER_STATUSES.includes(status)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid order status.');
    filters.push({ orderStatus: status });
  }
  const paymentMethod = cleanFilter(query.paymentMethod, 30);
  if (paymentMethod) {
    if (!PAYMENT_METHODS.includes(paymentMethod)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid payment method.');
    filters.push({ paymentMethod });
  }
  const product = objectId(query.product, 'product');
  const category = objectId(query.category, 'category');
  if (product || category) filters.push({ orderItems: { $elemMatch: { ...(product ? { product } : {}), ...(category ? { category } : {}) } } });
  const coupon = cleanFilter(query.coupon, 40).toUpperCase();
  if (coupon) filters.push({ 'coupon.code': coupon });
  const campaign = cleanFilter(query.campaign, 80);
  if (campaign) filters.push({ 'attribution.campaign': campaign });
  const source = cleanFilter(query.source, 80);
  if (source) filters.push({ 'attribution.source': source });
  const city = cleanFilter(query.city, 80);
  if (city) filters.push({ 'shippingAddress.city': regex(city) });
  const pincode = cleanFilter(query.pincode, 6);
  if (pincode) {
    if (!/^\d{6}$/.test(pincode)) throw new ApiError('VALIDATION_ERROR', 'PIN code must contain 6 digits.');
    filters.push({ 'shippingAddress.pincode': pincode });
  }
  const provider = cleanFilter(query.provider, 40).toLowerCase();
  if (provider) {
    const shipmentOrderIds = await Shipment.find(andFilter({ provider }, tenantFilter)).distinct('order');
    filters.push({ _id: { $in: shipmentOrderIds } });
  }
  return filters.length > 1 ? { $and: filters } : filters[0] || {};
}

function dated(filter, from, to) { return andFilter(filter, { createdAt: { $gte: from, $lt: to } }); }
function valid(filter) { return andFilter(filter, BOOKED); }
function paidLikeExpression() {
  return { $or: [
    { $in: ['$paymentState', ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED']] },
    { $in: ['$paymentStatus', ['Paid', 'Refunded']] },
  ] };
}
function collectedPaymentExpression() {
  return { $and: [
    { $ne: ['$orderStatus', 'Cancelled'] },
    { $ne: ['$paymentStatus', 'Failed'] },
    paidLikeExpression(),
  ] };
}
function bookedExpression() {
  return { $and: [
    { $not: [{ $in: ['$orderStatus', CLOSED] }] },
    { $not: [{ $in: ['$paymentStatus', ['Failed', 'Refunded']] }] },
    { $or: [{ $eq: ['$paymentMethod', 'COD'] }, { $eq: ['$paymentStatus', 'Paid'] }] },
  ] };
}
function payableAmountExpression() {
  return { $ifNull: ['$adjustedFinalAmount', { $ifNull: ['$finalAmount', 0] }] };
}
function collectedBaseExpression() {
  return { $cond: [{ $eq: ['$paymentMethod', 'COD'] }, payableAmountExpression(), { $ifNull: ['$finalAmount', 0] }] };
}
function netRevenueExpression() {
  return { $max: [0, { $subtract: [collectedBaseExpression(), { $ifNull: ['$refundedAmount', 0] }] }] };
}
function activeQuantity(variable = '$$item') {
  return { $max: [0, { $subtract: [{ $ifNull: [`${variable}.quantity`, 1] }, { $ifNull: [`${variable}.cancelledQuantity`, 0] }] }] };
}
function sumItems(field, fallback = 0) {
  return { $sum: { $map: { input: { $ifNull: ['$orderItems', []] }, as: 'item', in: { $multiply: [{ $ifNull: [`$$item.${field}`, fallback] }, activeQuantity()] } } } };
}
function itemUnits() {
  return { $sum: { $map: { input: { $ifNull: ['$orderItems', []] }, as: 'item', in: activeQuantity() } } };
}
function costCoveredUnits() {
  return { $sum: { $map: {
    input: { $ifNull: ['$orderItems', []] }, as: 'item',
    in: { $cond: [{ $ne: [{ $ifNull: ['$$item.costPrice', null] }, null] }, activeQuantity(), 0] },
  } } };
}

async function aggregateSummary(match) {
  const booked = bookedExpression();
  const paid = paidLikeExpression();
  const collected = collectedPaymentExpression();
  const [row = {}] = await Order.aggregate([
    { $match: match },
    { $group: {
      _id: null,
      allOrders: { $sum: 1 },
      orders: { $sum: { $cond: [booked, 1, 0] } },
      paidOrders: { $sum: { $cond: [{ $and: [booked, paid] }, 1, 0] } },
      cancelled: { $sum: { $cond: [{ $eq: ['$orderStatus', 'Cancelled'] }, 1, 0] } },
      grossSales: { $sum: { $cond: [booked, { $ifNull: ['$totalMRP', '$finalAmount'] }, 0] } },
      merchandiseSales: { $sum: { $cond: [booked, sumItems('price'), 0] } },
      productDiscount: { $sum: { $cond: [booked, { $ifNull: ['$productDiscount', 0] }, 0] } },
      couponDiscount: { $sum: { $cond: [booked, { $ifNull: ['$couponDiscount', 0] }, 0] } },
      prepaidDiscount: { $sum: { $cond: [booked, { $ifNull: ['$prepaidDiscount', 0] }, 0] } },
      deliveryCharge: { $sum: { $cond: [booked, { $ifNull: ['$deliveryCharge', 0] }, 0] } },
      codCharge: { $sum: { $cond: [booked, { $ifNull: ['$codCharge', 0] }, 0] } },
      platformFee: { $sum: { $cond: [booked, { $ifNull: ['$platformFee', 0] }, 0] } },
      tax: { $sum: { $cond: [booked, { $ifNull: ['$taxAmount', 0] }, 0] } },
      bookedValue: { $sum: { $cond: [booked, payableAmountExpression(), 0] } },
      paymentCollected: { $sum: { $cond: [collected, collectedBaseExpression(), 0] } },
      refunds: { $sum: { $cond: [collected, { $ifNull: ['$refundedAmount', 0] }, 0] } },
      recognizedRevenue: { $sum: { $cond: [{ $and: [booked, paid] }, netRevenueExpression(), 0] } },
      units: { $sum: { $cond: [booked, itemUnits(), 0] } },
      cost: { $sum: { $cond: [booked, sumItems('costPrice'), 0] } },
      costCoveredUnits: { $sum: { $cond: [booked, costCoveredUnits(), 0] } },
    } },
  ]);
  const orders = number(row.orders);
  const discounts = number(row.productDiscount) + number(row.couponDiscount) + number(row.prepaidDiscount);
  const netCollected = Math.max(0, number(row.paymentCollected) - number(row.refunds));
  const estimatedProfit = number(row.merchandiseSales) - number(row.couponDiscount) - number(row.prepaidDiscount) - number(row.cost);
  return {
    allOrders: number(row.allOrders), orders, paidOrders: number(row.paidOrders), cancelled: number(row.cancelled),
    grossSales: round(row.grossSales), merchandiseSales: round(row.merchandiseSales), discounts: round(discounts),
    productDiscount: round(row.productDiscount), couponDiscount: round(row.couponDiscount), prepaidDiscount: round(row.prepaidDiscount),
    deliveryCharge: round(row.deliveryCharge), codCharge: round(row.codCharge), platformFee: round(row.platformFee), tax: round(row.tax),
    bookedValue: round(row.bookedValue), paymentCollected: round(row.paymentCollected), refunds: round(row.refunds), netCollected: round(netCollected),
    recognizedRevenue: round(row.recognizedRevenue), units: number(row.units), averageOrderValue: orders ? round(number(row.bookedValue) / orders) : 0,
    cancellationRate: number(row.allOrders) ? round((number(row.cancelled) / number(row.allOrders)) * 100) : 0,
    cost: round(row.cost), costCoveredUnits: number(row.costCoveredUnits), costCoverage: number(row.units) ? round((number(row.costCoveredUnits) / number(row.units)) * 100) : 100,
    estimatedProfit: round(estimatedProfit), estimatedMargin: number(row.merchandiseSales) ? round((estimatedProfit / number(row.merchandiseSales)) * 100) : 0,
  };
}

async function distinctCustomers(match) {
  const rows = await Order.aggregate([{ $match: valid(match) }, { $match: { user: { $ne: null } } }, { $group: { _id: '$user' } }, { $count: 'value' }]);
  return number(rows[0]?.value);
}

function fillSeries(range, rows) {
  const map = new Map(rows.map((row) => [row._id, row]));
  const keys = [];
  for (let date = new Date(range.from); date < range.to; date = new Date(date.getTime() + DAY)) {
    const key = dateKey(date, range.timezone).slice(0, range.granularity === 'month' ? 7 : 10);
    if (keys[keys.length - 1] !== key) keys.push(key);
  }
  return keys.map((key) => ({
    key, label: key, orders: number(map.get(key)?.orders),
    revenue: round(map.get(key)?.revenue), refunds: round(map.get(key)?.refunds),
    net: round(number(map.get(key)?.revenue) - number(map.get(key)?.refunds)),
  }));
}

async function summaryReport(context) {
  const { range, orderFilter } = context;
  const currentMatch = dated(orderFilter, range.from, range.to);
  const previousMatch = dated(orderFilter, range.previousFrom, range.from);
  const [current, previous, customers, previousCustomers, seriesRows, statusRows, paymentRows, couponRows] = await Promise.all([
    aggregateSummary(currentMatch), aggregateSummary(previousMatch), distinctCustomers(currentMatch), distinctCustomers(previousMatch),
    Order.aggregate([
      { $match: currentMatch },
      { $group: { _id: { $dateToString: { date: '$createdAt', format: range.granularity === 'month' ? '%Y-%m' : '%Y-%m-%d', timezone: range.timezone } }, orders: { $sum: { $cond: [bookedExpression(), 1, 0] } }, revenue: { $sum: { $cond: [collectedPaymentExpression(), collectedBaseExpression(), 0] } }, refunds: { $sum: { $cond: [collectedPaymentExpression(), { $ifNull: ['$refundedAmount', 0] }, 0] } } } },
      { $sort: { _id: 1 } },
    ]),
    Order.aggregate([{ $match: currentMatch }, { $group: { _id: '$orderStatus', value: { $sum: 1 }, amount: { $sum: payableAmountExpression() } } }, { $sort: { value: -1 } }]),
    Order.aggregate([{ $match: valid(currentMatch) }, { $group: { _id: '$paymentMethod', value: { $sum: 1 }, amount: { $sum: payableAmountExpression() } } }, { $sort: { value: -1 } }]),
    Order.aggregate([{ $match: valid(andFilter(currentMatch, { 'coupon.code': { $exists: true, $nin: ['', null] } })) }, { $group: { _id: '$coupon.code', value: { $sum: 1 }, discount: { $sum: { $ifNull: ['$couponDiscount', 0] } }, revenue: { $sum: netRevenueExpression() } } }, { $sort: { value: -1 } }, { $limit: 20 }]),
  ]);
  current.customers = customers; previous.customers = previousCustomers;
  const keys = ['grossSales', 'discounts', 'bookedValue', 'paymentCollected', 'refunds', 'netCollected', 'recognizedRevenue', 'orders', 'paidOrders', 'units', 'averageOrderValue', 'customers', 'estimatedProfit'];
  return {
    metrics: Object.fromEntries(keys.map((key) => [key, metric(current[key], previous[key])])),
    current, previous,
    series: fillSeries(range, seriesRows),
    statusBreakdown: statusRows.map((row) => ({ label: row._id || 'Pending', value: number(row.value), amount: round(row.amount) })),
    paymentBreakdown: paymentRows.map((row) => ({ label: row._id || 'COD', value: number(row.value), amount: round(row.amount) })),
    couponBreakdown: couponRows.map((row) => ({ label: row._id, value: number(row.value), discount: round(row.discount), revenue: round(row.revenue) })),
    definitions: {
      bookedValue: 'Valid COD and paid online orders, excluding cancelled, returned, refunded and failed orders.',
      paymentCollected: 'Successful non-cancelled payment captures before refunds, based on the order date.',
      refunds: 'Recorded refunds on non-cancelled paid orders, based on the original order date.',
      netCollected: 'Successful non-cancelled payments collected minus recorded refunds, based on the order date.',
      recognizedRevenue: 'Net paid value from valid orders after recorded partial refunds.',
      estimatedProfit: 'Merchandise selling value less order discounts and recorded product cost. Accuracy depends on cost coverage.',
    },
  };
}

async function productsReport(context) {
  const { range, orderFilter, tenantFilter, query } = context;
  // Keep paid returned/refunded orders in the product cohort so their refund and
  // return performance remains visible. Uncollected returned COD orders are not sales.
  const match = andFilter(dated(orderFilter, range.from, range.to), {
    orderStatus: { $ne: 'Cancelled' },
    paymentStatus: { $ne: 'Failed' },
    $or: [
      { $and: [{ orderStatus: { $nin: ['Returned', 'Refunded'] } }, { $or: [{ paymentMethod: 'COD' }, { paymentStatus: 'Paid' }] }] },
      { paymentState: { $in: ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'] } },
      { paymentStatus: { $in: ['Paid', 'Refunded'] } },
    ],
  });
  const lineMatch = {};
  if (query.product) lineMatch['orderItems.product'] = objectId(query.product, 'product');
  if (query.category) lineMatch['orderItems.category'] = objectId(query.category, 'category');
  const salesRows = await Order.aggregate([
    { $match: match },
    { $set: { reportMerchandiseValue: sumItems('price') } },
    { $unwind: '$orderItems' },
    { $set: {
      reportLineValue: { $multiply: [{ $ifNull: ['$orderItems.price', 0] }, { $ifNull: ['$orderItems.quantity', 1] }] },
      reportAllocationRatio: { $cond: [{ $gt: ['$reportMerchandiseValue', 0] }, { $divide: [{ $multiply: [{ $ifNull: ['$orderItems.price', 0] }, { $ifNull: ['$orderItems.quantity', 1] }] }, '$reportMerchandiseValue'] }, 0] },
    } },
    ...(Object.keys(lineMatch).length ? [{ $match: lineMatch }] : []),
    { $group: {
      _id: { $ifNull: ['$orderItems.product', '$orderItems.name'] }, productId: { $first: '$orderItems.product' },
      name: { $first: '$orderItems.name' }, sku: { $first: '$orderItems.sku' }, image: { $first: '$orderItems.image' },
      categoryId: { $first: '$orderItems.category' }, category: { $first: '$orderItems.categoryName' },
      units: { $sum: { $ifNull: ['$orderItems.quantity', 1] } }, orders: { $addToSet: '$_id' }, customers: { $addToSet: '$user' },
      refundedUnits: { $sum: { $cond: [{ $or: [
        { $eq: ['$orderStatus', 'Refunded'] }, { $eq: ['$paymentStatus', 'Refunded'] },
        { $and: [{ $gt: [{ $ifNull: ['$finalAmount', 0] }, 0] }, { $gte: [{ $ifNull: ['$refundedAmount', 0] }, { $ifNull: ['$finalAmount', 0] }] }] },
      ] }, { $ifNull: ['$orderItems.quantity', 1] }, 0] } },
      grossItemRevenue: { $sum: '$reportLineValue' },
      allocatedDiscount: { $sum: { $multiply: ['$reportAllocationRatio', { $add: [{ $ifNull: ['$couponDiscount', 0] }, { $ifNull: ['$prepaidDiscount', 0] }] }] } },
      allocatedRefund: { $sum: { $multiply: ['$reportAllocationRatio', { $ifNull: ['$refundedAmount', 0] }] } },
      snapshotCost: { $sum: { $multiply: [{ $ifNull: ['$orderItems.costPrice', 0] }, { $ifNull: ['$orderItems.quantity', 1] }] } },
      costCoveredUnits: { $sum: { $cond: [{ $ne: [{ $ifNull: ['$orderItems.costPrice', null] }, null] }, { $ifNull: ['$orderItems.quantity', 1] }, 0] } },
    } }, { $sort: { units: -1, itemRevenue: -1 } }, { $limit: 100 },
  ]);
  const productIds = salesRows.map((row) => row.productId).filter(Boolean);
  const [products, returns, inventoryRows, outProducts] = await Promise.all([
    Product.find(andFilter({ _id: { $in: productIds } }, tenantFilter)).select('name sku costPrice price category').lean(),
    ReturnExchange.aggregate([{ $match: andFilter({ createdAt: { $gte: range.from, $lt: range.to }, product: { $in: productIds }, status: { $nin: ['Rejected', 'Cancelled'] } }, tenantFilter) }, { $group: { _id: '$product', quantity: { $sum: '$quantity' }, cases: { $sum: 1 }, refunded: { $sum: { $ifNull: ['$financial.refundedAmount', 0] } } } }]),
    Product.aggregate([{ $match: andFilter({ isArchived: { $ne: true } }, tenantFilter) }, { $addFields: { available: availableStock } }, { $group: { _id: null, products: { $sum: 1 }, active: { $sum: { $cond: ['$isActive', 1, 0] } }, units: { $sum: '$available' }, valueAtCost: { $sum: { $multiply: ['$available', { $ifNull: ['$costPrice', 0] }] } }, valueAtRetail: { $sum: { $multiply: ['$available', { $ifNull: ['$price', 0] }] } }, outOfStock: { $sum: { $cond: [{ $and: ['$isActive', { $lte: ['$available', 0] }] }, 1, 0] } }, lowStock: { $sum: { $cond: [{ $and: ['$isActive', { $gt: ['$available', 0] }, { $lte: ['$available', { $ifNull: ['$lowStockAlert', 5] }] }] }, 1, 0] } }, agedProducts: { $sum: { $cond: [{ $and: [{ $gt: ['$available', 0] }, { $lte: [{ $ifNull: ['$lastInventoryChangeAt', '$createdAt'] }, new Date(Date.now() - 90 * DAY)] }] }, 1, 0] } }, agedUnits: { $sum: { $cond: [{ $and: [{ $gt: ['$available', 0] }, { $lte: [{ $ifNull: ['$lastInventoryChangeAt', '$createdAt'] }, new Date(Date.now() - 90 * DAY)] }] }, '$available', 0] } } } }]),
    Product.aggregate([{ $match: andFilter({ isActive: true, isArchived: { $ne: true } }, tenantFilter) }, { $addFields: { available: availableStock } }, { $match: { available: { $lte: 0 } } }, { $project: { name: 1, sku: 1, price: 1 } }, { $limit: 500 }]),
  ]);
  const productMap = new Map(products.map((item) => [String(item._id), item]));
  const returnMap = new Map(returns.map((item) => [String(item._id), item]));
  const items = salesRows.map((row) => {
    const id = String(row.productId || row._id || ''); const product = productMap.get(id); const returned = returnMap.get(id) || {};
    const units = number(row.units); const covered = number(row.costCoveredUnits);
    const estimatedCost = number(row.snapshotCost) + Math.max(0, units - covered) * number(product?.costPrice);
    const grossItemRevenue = number(row.grossItemRevenue);
    const allocatedDiscount = number(row.allocatedDiscount);
    const allocatedRefund = number(row.allocatedRefund);
    const itemRevenue = Math.max(0, grossItemRevenue - allocatedDiscount - allocatedRefund);
    const profit = itemRevenue - estimatedCost;
    const returnedUnits = number(returned.quantity);
    const refundedUnits = number(row.refundedUnits);
    return {
      id, name: row.name || product?.name || 'Removed product', sku: row.sku || product?.sku || '', image: row.image || '',
      category: row.category || '', units, orders: row.orders.length, customers: row.customers.filter(Boolean).length,
      grossItemRevenue: round(grossItemRevenue), allocatedDiscount: round(allocatedDiscount), allocatedRefund: round(allocatedRefund), itemRevenue: round(itemRevenue),
      estimatedCost: round(estimatedCost), estimatedProfit: round(profit),
      estimatedMargin: itemRevenue ? round((profit / itemRevenue) * 100) : 0,
      costCoverage: units ? round((covered / units) * 100) : 100,
      netUnits: Math.max(0, units - Math.max(returnedUnits, refundedUnits)), refundedUnits, returnedUnits, returnCases: number(returned.cases), refunded: round(returned.refunded),
      returnRate: units ? round((returnedUnits / units) * 100) : 0,
    };
  });
  items.sort((left, right) => right.netUnits - left.netUnits || right.itemRevenue - left.itemRevenue || right.units - left.units);
  const soldIds = new Set(items.map((item) => item.id));
  const slowMoving = await Product.aggregate([{ $match: andFilter({ isActive: true, isArchived: { $ne: true }, _id: { $nin: [...soldIds].filter(mongoose.isValidObjectId).map((id) => new mongoose.Types.ObjectId(id)) } }, tenantFilter) }, { $addFields: { available: availableStock } }, { $match: { available: { $gt: 0 } } }, { $sort: { available: -1 } }, { $limit: 20 }, { $project: { name: 1, sku: 1, available: 1, price: 1, costPrice: 1, lastInventoryChangeAt: 1 } }]);
  const outIds = outProducts.map((item) => item._id);
  const exposureRows = outIds.length ? await AnalyticsEvent.aggregate([{ $match: andFilter({ productId: { $in: outIds }, name: 'PRODUCT_VIEW', createdAt: { $gte: range.from, $lt: range.to } }, tenantFilter) }, { $group: { _id: '$productId', views: { $sum: 1 } } }, { $sort: { views: -1 } }, { $limit: 20 }]) : [];
  const outMap = new Map(outProducts.map((item) => [String(item._id), item]));
  return {
    items, inventory: inventoryRows[0] || { products: 0, active: 0, units: 0, valueAtCost: 0, valueAtRetail: 0, outOfStock: 0, lowStock: 0, agedProducts: 0, agedUnits: 0 },
    slowMoving: slowMoving.map((item) => ({ id: String(item._id), ...item })),
    stockoutExposure: exposureRows.map((row) => ({ id: String(row._id), name: outMap.get(String(row._id))?.name || 'Product', sku: outMap.get(String(row._id))?.sku || '', views: row.views })),
    definitions: { itemRevenue: 'Product selling value after proportional coupon, prepaid discount and recorded refund allocation. Delivery, COD, platform fees and tax are excluded.', profit: 'Estimated net product value less checkout-time product cost where available and current cost for legacy orders.' },
  };
}

async function customersReport(context) {
  const { range, orderFilter, tenantFilter } = context;
  const current = valid(dated(orderFilter, range.from, range.to));
  const rows = await Order.aggregate([
    { $match: current }, { $match: { user: { $ne: null } } },
    { $group: { _id: '$user', orders: { $sum: 1 }, spend: { $sum: netRevenueExpression() }, units: { $sum: itemUnits() }, lastOrderAt: { $max: '$createdAt' } } },
    { $sort: { spend: -1 } },
  ]);
  const ids = rows.map((row) => row._id);
  const priorUsers = ids.length ? await Order.distinct('user', valid(andFilter(tenantFilter, { user: { $in: ids }, createdAt: { $lt: range.from } }))) : [];
  const prior = new Set(priorUsers.map(String));
  const [users, lifetimeRows] = ids.length ? await Promise.all([
    User.find({ _id: { $in: ids } }).select('name').lean(),
    Order.aggregate([{ $match: valid(andFilter(tenantFilter, { user: { $in: ids } })) }, { $group: { _id: '$user', orders: { $sum: 1 }, netSpend: { $sum: netRevenueExpression() } } }]),
  ]) : [[], []];
  const names = new Map(users.map((user) => [String(user._id), user.name || 'Customer']));
  const lifetime = new Map(lifetimeRows.map((row) => [String(row._id), row]));
  const newCustomers = rows.filter((row) => !prior.has(String(row._id))).length;
  const returningCustomers = rows.length - newCustomers;
  const locationRows = await Order.aggregate([{ $match: current }, { $group: { _id: { city: '$shippingAddress.city', state: '$shippingAddress.state', pincode: '$shippingAddress.pincode' }, orders: { $sum: 1 }, revenue: { $sum: netRevenueExpression() }, customers: { $addToSet: '$user' } } }, { $sort: { orders: -1 } }, { $limit: 30 }]);
  const totalSpend = rows.reduce((sum, row) => sum + number(row.spend), 0);
  return {
    summary: { buyingCustomers: rows.length, newCustomers, returningCustomers, repeatRate: rows.length ? round((returningCustomers / rows.length) * 100) : 0, averageCustomerValue: rows.length ? round(totalSpend / rows.length) : 0 },
    topCustomers: rows.slice(0, 30).map((row) => {
      const allTime = lifetime.get(String(row._id)) || {};
      return { id: String(row._id), name: names.get(String(row._id)) || 'Customer', orders: row.orders, units: row.units, netSpend: round(row.spend), averageOrderValue: row.orders ? round(row.spend / row.orders) : 0, lifetimeOrders: number(allTime.orders), lifetimeValue: round(allTime.netSpend), type: prior.has(String(row._id)) ? 'Returning' : 'New', lastOrderAt: row.lastOrderAt };
    }),
    locations: locationRows.map((row) => ({ city: row._id.city || 'Unknown', state: row._id.state || '', pincode: row._id.pincode || '', orders: row.orders, customers: row.customers.filter(Boolean).length, revenue: round(row.revenue) })),
  };
}

async function marketingReport(context) {
  const { range, orderFilter, tenantFilter, query } = context;
  const eventFilter = andFilter(tenantFilter, { createdAt: { $gte: range.from, $lt: range.to } });
  const eventFilters = [eventFilter];
  if (query.source) eventFilters.push({ source: cleanFilter(query.source, 80) });
  if (query.campaign) eventFilters.push({ campaign: cleanFilter(query.campaign, 80) });
  if (query.product) eventFilters.push({ productId: objectId(query.product, 'product') });
  const eventsMatch = eventFilters.length > 1 ? { $and: eventFilters } : eventFilters[0];
  const validOrders = valid(dated(orderFilter, range.from, range.to));
  const [eventRows, sourceRows, attributedRows, couponRows, bannerRows, homeRows] = await Promise.all([
    AnalyticsEvent.aggregate([{ $match: eventsMatch }, { $group: { _id: '$name', value: { $sum: 1 }, sessions: { $addToSet: '$sessionId' } } }]),
    AnalyticsEvent.aggregate([{ $match: andFilter(eventsMatch, { source: { $exists: true, $nin: ['', null] } }) }, { $group: { _id: '$source', events: { $sum: 1 }, sessions: { $addToSet: '$sessionId' } } }, { $sort: { events: -1 } }, { $limit: 20 }]),
    Order.aggregate([{ $match: andFilter(validOrders, { 'attribution.source': { $exists: true, $nin: ['', null] } }) }, { $group: { _id: { source: '$attribution.source', campaign: '$attribution.campaign', reelId: '$attribution.reelId' }, orders: { $sum: 1 }, revenue: { $sum: netRevenueExpression() }, customers: { $addToSet: '$user' } } }, { $sort: { revenue: -1 } }, { $limit: 40 }]),
    Order.aggregate([{ $match: andFilter(validOrders, { 'coupon.code': { $exists: true, $nin: ['', null] } }) }, { $group: { _id: '$coupon.code', orders: { $sum: 1 }, customers: { $addToSet: '$user' }, discount: { $sum: { $ifNull: ['$couponDiscount', 0] } }, revenue: { $sum: netRevenueExpression() } } }, { $sort: { revenue: -1 } }, { $limit: 30 }]),
    AnalyticsEvent.aggregate([{ $match: andFilter(eventsMatch, { name: { $in: ['BANNER_IMPRESSION', 'BANNER_CLICK'] } }) }, { $group: { _id: { bannerId: '$metadata.bannerId', campaign: '$campaign' }, impressions: { $sum: { $cond: [{ $eq: ['$name', 'BANNER_IMPRESSION'] }, 1, 0] } }, clicks: { $sum: { $cond: [{ $eq: ['$name', 'BANNER_CLICK'] }, 1, 0] } } } }, { $sort: { impressions: -1 } }, { $limit: 30 }]),
    AnalyticsEvent.aggregate([
      { $match: andFilter(eventsMatch, { name: { $in: ['HOME_SECTION_VIEW', 'HOME_PRODUCT_CLICK', 'HOME_CATEGORY_CLICK', 'HOME_VIEW_ALL', 'HOME_SCROLL'] } }) },
      { $group: { _id: { name: '$name', sectionId: '$metadata.sectionId', categoryId: '$metadata.categoryId', categoryName: '$metadata.categoryName', action: '$metadata.action', milestone: '$metadata.milestone' }, value: { $sum: 1 } } },
      { $sort: { value: -1 } },
      { $limit: 100 },
    ]),
  ]);
  const eventMap = Object.fromEntries(eventRows.map((row) => [row._id, number(row.value)]));
  const steps = ['STORE_VIEW', 'PRODUCT_VIEW', 'ADD_TO_CART', 'BEGIN_CHECKOUT', 'PAYMENT_SUCCESS', 'PURCHASE'].map((name, index, all) => ({
    name, value: eventMap[name] || 0, rateFromPrevious: index && (eventMap[all[index - 1]] || 0) ? round(((eventMap[name] || 0) / eventMap[all[index - 1]]) * 100) : index ? 0 : 100,
  }));
  return {
    funnel: steps, conversionRate: eventMap.STORE_VIEW ? round((number(eventMap.PURCHASE) / number(eventMap.STORE_VIEW)) * 100) : 0,
    sources: sourceRows.map((row) => ({ source: row._id, events: row.events, sessions: row.sessions.filter(Boolean).length })),
    attribution: attributedRows.map((row) => ({ source: row._id.source || '', campaign: row._id.campaign || '', reelId: row._id.reelId || '', orders: row.orders, customers: row.customers.filter(Boolean).length, revenue: round(row.revenue) })),
    coupons: couponRows.map((row) => ({ code: row._id, orders: row.orders, customers: row.customers.filter(Boolean).length, discount: round(row.discount), revenue: round(row.revenue), returnOnDiscount: row.discount ? round(row.revenue / row.discount) : null })),
    banners: bannerRows.map((row) => ({ bannerId: row._id.bannerId || '', campaign: row._id.campaign || '', impressions: row.impressions, clicks: row.clicks, ctr: row.impressions ? round((row.clicks / row.impressions) * 100) : 0 })),
    homeEngagement: homeRows.map((row) => ({
      event: row._id.name || '', section: row._id.sectionId || '', categoryId: row._id.categoryId || '',
      category: row._id.categoryName || '', action: row._id.action || '', milestone: number(row._id.milestone), value: row.value,
    })),
    note: 'Storefront events are first-party events recorded by this application. External Instagram or Facebook views are not imported.',
  };
}

async function fulfillmentReport(context) {
  const { range, orderFilter, tenantFilter, query } = context;
  const orders = await Order.find(valid(dated(orderFilter, range.from, range.to))).select('_id finalAmount adjustedFinalAmount deliveryCharge codCharge paymentMethod paymentStatus orderStatus').lean();
  const orderIds = orders.map((order) => order._id);
  const shipmentMatch = andFilter({ order: { $in: orderIds }, ...(query.provider ? { provider: cleanFilter(query.provider, 40).toLowerCase() } : {}) }, tenantFilter);
  const shipments = orderIds.length ? await Shipment.find(shipmentMatch).select('order provider courierName status providerCharge expectedDeliveryAt events createdAt').lean() : [];
  const now = Date.now(); let deliveryHours = 0; let deliveredWithTiming = 0;
  const status = {}; const providers = {};
  shipments.forEach((shipment) => {
    status[shipment.status || 'WAITING'] = (status[shipment.status || 'WAITING'] || 0) + 1;
    const key = shipment.provider || 'manual';
    if (!providers[key]) providers[key] = { provider: key, shipments: 0, delivered: 0, exceptions: 0, rto: 0, charge: 0 };
    providers[key].shipments += 1; providers[key].charge += number(shipment.providerCharge);
    if (shipment.status === 'DELIVERED') providers[key].delivered += 1;
    if (['EXCEPTION', 'FAILED'].includes(shipment.status)) providers[key].exceptions += 1;
    if (['RTO_IN_TRANSIT', 'RETURNED'].includes(shipment.status)) providers[key].rto += 1;
    const picked = shipment.events?.filter((event) => event.status === 'PICKED_UP').map((event) => new Date(event.date).getTime()).filter(Number.isFinite).sort()[0];
    const delivered = shipment.events?.filter((event) => event.status === 'DELIVERED').map((event) => new Date(event.date).getTime()).filter(Number.isFinite).sort().at(-1);
    if (picked && delivered && delivered >= picked) { deliveryHours += (delivered - picked) / 3600000; deliveredWithTiming += 1; }
  });
  const delayed = shipments.filter((shipment) => shipment.expectedDeliveryAt
    && new Date(shipment.expectedDeliveryAt).getTime() < now
    && !['DELIVERED', 'CANCELLED', 'RTO_IN_TRANSIT', 'RETURNED', 'FAILED'].includes(shipment.status)).length;
  const codOutstanding = orders.filter((order) => order.paymentMethod === 'COD' && order.orderStatus === 'Delivered' && order.paymentStatus === 'Pending');
  const returnFilters = [{ createdAt: { $gte: range.from, $lt: range.to } }];
  if (query.product) returnFilters.push({ product: objectId(query.product, 'product') });
  if (query.category) {
    const categoryProducts = await Product.find(andFilter({ category: objectId(query.category, 'category') }, tenantFilter)).distinct('_id');
    returnFilters.push({ product: { $in: categoryProducts } });
  }
  const orderLevelReturnFilters = ['status', 'paymentMethod', 'coupon', 'campaign', 'source', 'city', 'pincode', 'provider'].some((key) => query[key]);
  if (orderLevelReturnFilters) {
    const filteredOrderIds = await Order.find(orderFilter).distinct('_id');
    returnFilters.push({ order: { $in: filteredOrderIds } });
  }
  const returnMatch = andFilter(returnFilters.length > 1 ? { $and: returnFilters } : returnFilters[0], tenantFilter);
  const returnRows = await ReturnExchange.find(returnMatch).select('type status quantity financial createdAt completedAt slaDueAt').lean();
  const returnStatus = {}; let refunded = 0; let refundPending = 0; let overdue = 0; let resolutionHours = 0; let resolved = 0;
  returnRows.forEach((item) => {
    returnStatus[item.status] = (returnStatus[item.status] || 0) + 1;
    refunded += number(item.financial?.refundedAmount);
    if (['PENDING', 'INITIATED', 'FAILED'].includes(item.financial?.refundStatus)) refundPending += 1;
    if (item.slaDueAt && new Date(item.slaDueAt).getTime() < now && !['Refunded', 'Exchanged', 'Closed', 'Rejected', 'Cancelled'].includes(item.status)) overdue += 1;
    if (item.completedAt) { resolutionHours += (new Date(item.completedAt) - new Date(item.createdAt)) / 3600000; resolved += 1; }
  });
  return {
    summary: {
      orders: orders.length, shipments: shipments.length, waitingForShipment: Math.max(0, orders.length - shipments.length), delayed,
      delivered: number(status.DELIVERED), rto: number(status.RTO_IN_TRANSIT) + number(status.RETURNED), exceptions: number(status.EXCEPTION) + number(status.FAILED),
      averageDeliveryHours: deliveredWithTiming ? round(deliveryHours / deliveredWithTiming) : null,
      shippingCollected: round(orders.reduce((sum, order) => sum + number(order.deliveryCharge) + number(order.codCharge), 0)),
      carrierCost: round(shipments.reduce((sum, shipment) => sum + number(shipment.providerCharge), 0)),
      codOutstandingOrders: codOutstanding.length, codOutstandingAmount: round(codOutstanding.reduce((sum, order) => sum + number(order.adjustedFinalAmount ?? order.finalAmount), 0)),
      returnRequests: returnRows.length, returns: returnRows.filter((item) => item.type === 'return').length, exchanges: returnRows.filter((item) => item.type === 'exchange').length,
      refunded: round(refunded), refundPending, overdueReturns: overdue, averageResolutionHours: resolved ? round(resolutionHours / resolved) : null,
    },
    shipmentStatuses: Object.entries(status).map(([label, value]) => ({ label, value })),
    providers: Object.values(providers).map((item) => ({ ...item, charge: round(item.charge), deliveryRate: item.shipments ? round((item.delivered / item.shipments) * 100) : 0, rtoRate: item.shipments ? round((item.rto / item.shipments) * 100) : 0 })),
    returnStatuses: Object.entries(returnStatus).map(([label, value]) => ({ label, value })),
  };
}

async function reportOptions({ tenantFilter, includeStores = false }) {
  const [products, categories, coupons, stores, cities, campaigns, sources, providers] = await Promise.all([
    Product.find(andFilter({ isArchived: { $ne: true } }, tenantFilter)).select('name sku').sort({ name: 1 }).limit(500).lean(),
    Category.find(andFilter({ isArchived: { $ne: true } }, tenantFilter)).select('name').sort({ name: 1 }).limit(300).lean(),
    Coupon.find(andFilter({}, tenantFilter)).select('code title').sort({ code: 1 }).limit(300).lean(),
    includeStores ? Store.find({ status: { $in: ['PUBLISHED', 'ONBOARDING'] } }).select('name slug isDefault currency timezone').sort({ isDefault: -1, name: 1 }).lean() : [],
    Order.distinct('shippingAddress.city', tenantFilter), Order.distinct('attribution.campaign', tenantFilter), Order.distinct('attribution.source', tenantFilter), Shipment.distinct('provider', tenantFilter),
  ]);
  return {
    products: products.map((item) => ({ id: String(item._id), name: item.name, sku: item.sku || '' })),
    categories: categories.map((item) => ({ id: String(item._id), name: item.name })), coupons: coupons.map((item) => ({ code: item.code, title: item.title || '' })),
    stores: stores.map((item) => ({ id: String(item._id), name: item.name, slug: item.slug, isDefault: item.isDefault, currency: item.currency, timezone: item.timezone })),
    cities: cities.filter(Boolean).sort(), campaigns: campaigns.filter(Boolean).sort(), sources: sources.filter(Boolean).sort(), providers: providers.filter(Boolean).sort(),
    statuses: ORDER_STATUSES, paymentMethods: PAYMENT_METHODS,
  };
}

async function createReportContext({ query = {}, tenantFilter = {}, store }) {
  const timezone = safeTimezone(store?.timezone || 'Asia/Kolkata');
  const currency = cleanFilter(store?.currency || 'INR', 8).toUpperCase() || 'INR';
  const range = reportRange(query, timezone);
  const orderFilter = await reportFilters(query, tenantFilter);
  return { query, tenantFilter, store, timezone, currency, range, orderFilter };
}

async function generateSection(section, context) {
  if (!SECTIONS.includes(section)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid report section.');
  const handlers = { summary: summaryReport, products: productsReport, customers: customersReport, marketing: marketingReport, fulfillment: fulfillmentReport, traffic: require('./trafficReportingService').trafficReport };
  const data = await handlers[section](context);
  return {
    schemaVersion: 1, section, generatedAt: new Date(), currency: context.currency, timezone: data.timezone || context.timezone,
    range: section === 'traffic' ? { preset: data.range.preset, fromDate: data.range.fromDate, toDate: data.range.toDate, days: data.range.days } : { preset: context.range.preset, fromDate: context.range.fromDate, toDate: context.range.toDate, days: context.range.days },
    filters: Object.fromEntries(['status', 'paymentMethod', 'product', 'category', 'coupon', 'campaign', 'source', 'city', 'pincode', 'provider', 'device', 'browser'].filter((key) => context.query[key]).map((key) => [key, context.query[key]])),
    data,
  };
}

module.exports = { SECTIONS, createReportContext, generateSection, reportOptions, reportRange, round, metric };
