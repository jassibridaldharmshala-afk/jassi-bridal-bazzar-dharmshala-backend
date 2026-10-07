const Product = require('../models/Product');
const Order = require('../models/Order');
const User = require('../models/User');
const Coupon = require('../models/Coupon');
const ReturnExchange = require('../models/ReturnExchange');
const { andFilter } = require('../services/storeService');
const { asyncHandler } = require('../middleware/validate');
const { dashboardOverview, stockWarning, netPaidAmount } = require('../services/dashboardAnalytics');
const { createReportContext, generateSection } = require('../services/reportingService');

function scope(req, extra = {}) {
  return andFilter(extra, req.tenantFilter);
}

exports.stats = async (req, res) => {
  const scopedCustomers = req.tenantFilter && Object.keys(req.tenantFilter).length
    ? Order.distinct('user', scope(req, { user: { $ne: null } })).then((ids) => ids.length)
    : User.countDocuments({ role: 'customer' });
  const [products, orders, customers, coupons, returns, revenue] = await Promise.all([
    Product.countDocuments(scope(req)),
    Order.countDocuments(scope(req)),
    scopedCustomers,
    Coupon.countDocuments(scope(req, { isActive: true })),
    ReturnExchange.countDocuments(scope(req, { status: 'Requested' })),
    Order.aggregate([{ $match: andFilter({ paymentStatus: 'Paid' }, req.tenantFilter) }, { $group: { _id: null, total: { $sum: netPaidAmount } } }]),
  ]);
  res.json({ products, orders, customers, coupons, returns, revenue: revenue[0]?.total || 0 });
};

exports.recentOrders = async (req, res) => res.json(await Order.find(scope(req)).populate('user', 'name email').sort('-createdAt').limit(10));

exports.lowStock = asyncHandler(async (req, res) => res.json(await Product.find(scope(req, {
  isActive: true, isArchived: { $ne: true }, $expr: stockWarning,
}))));

exports.overview = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'private, no-store, max-age=0');
  res.json(await dashboardOverview(req.query, req.tenantFilter));
});

// Compatibility endpoints use the same reporting engine as Reports Center so
// older clients receive the same timezone, cancellation and refund rules.
exports.salesReport = asyncHandler(async (req, res) => {
  const context = await createReportContext({ query: req.query, tenantFilter: req.tenantFilter || {}, store: req.store });
  const report = await generateSection('summary', context);
  const data = report.data;
  res.set('Cache-Control', 'private, no-store, max-age=0');
  res.json({
    from: context.range.from,
    to: new Date(context.range.to.getTime() - 1),
    preset: context.range.preset,
    totals: {
      orders: data.current.orders,
      paidOrders: data.current.paidOrders,
      revenue: data.current.recognizedRevenue,
      customers: data.current.customers,
    },
    series: data.series.map((item) => ({ ...item, value: item.revenue })),
    statusBreakdown: data.statusBreakdown,
    paymentBreakdown: data.paymentBreakdown.map((item) => ({ ...item, revenue: item.amount })),
    couponUsage: data.couponBreakdown,
  });
});

exports.productReport = asyncHandler(async (req, res) => {
  const context = await createReportContext({ query: req.query, tenantFilter: req.tenantFilter || {}, store: req.store });
  const [report, lowStock] = await Promise.all([
    generateSection('products', context),
    Product.find(scope(req, { isActive: true, isArchived: { $ne: true }, $expr: stockWarning })).select('name sku stock lowStockAlert variants').limit(50),
  ]);
  res.set('Cache-Control', 'private, no-store, max-age=0');
  res.json({
    from: context.range.from,
    to: new Date(context.range.to.getTime() - 1),
    preset: context.range.preset,
    bestSellers: report.data.items.map((item) => ({ id: item.id, name: item.name, sku: item.sku, sold: item.units, revenue: item.itemRevenue })),
    lowStock,
  });
});
