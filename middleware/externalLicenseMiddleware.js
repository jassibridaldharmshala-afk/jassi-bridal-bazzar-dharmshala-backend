const Product = require('../models/Product');
const { ApiError } = require('../utils/apiError');
const { licenseStatus } = require('../services/controlPlaneClient');

const FEATURE_ROUTES = [
  [/^\/(?:admin\/reports|seller\/(?:reports|analytics))/, 'analytics'],
  [/^\/(?:admin|seller)\/rentals\/report(?:\/|$)/, 'analytics'],
  [/^\/admin\/products\/(?:smart-fill|quick-analyze)/, 'aiProduct'],
  [/^\/admin\/(?:social-imports|reel-imports)/, 'socialImport'],
  [/^\/(?:social|admin\/social|seller\/(?:social|instagram|inbox))/, 'socialStudio'],
  [/^\/(?:admin|seller)\/business\/assistant/, 'businessAssistant'],
  [/^\/(?:admin|seller)\/business\/abandoned-carts/, 'abandonedCart'],
  [/^\/(?:admin|seller)\/business\/customer-offers|^\/seller\/crm/, 'crm'],
  [/^\/(?:admin\/business|seller\/business)\/festival/, 'festival'],
  [/^\/(?:admin\/customization|seller\/design)/, 'advancedCustomization'],
  // Reading your delivery history is part of an order, including self/manual
  // fulfilment. Only carrier automation operations require the paid feature.
  [/\/(?:replacement-)?delivery\/(?:book|pickup|cancel|exception|reconcile|label)(?:\/|$)/, 'shippingAutomation'],
  [/\/rentals\/bookings\/[^/]+\/courier\/(?:outbound|inbound)\/(?:book|pickup|cancel|sync|reconcile|label)(?:\/|$)/, 'shippingAutomation'],
];

function apiPath(req) {
  return String(req.originalUrl || req.url || '').split('?')[0].replace(/^\/api/, '') || '/';
}

function shouldSkip(path) {
  return /^\/(?:platform|master|system)(?:\/|$)/.test(path)
    || /^\/auth(?:\/|$)/.test(path)
    || /^\/social\/(?:webhook|oauth|deauthorize|data-deletion|deletion-status)/.test(path);
}

function isCommerceWrite(method, path) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return false;
  return !/^\/(?:contact|newsletter)(?:\/|$)/.test(path);
}

async function isExistingRentalSettlement(req, path) {
  if (req.method === 'DELETE' && /^\/(?:admin|seller)\/rentals\/bookings\/[a-f\d]{24}\/proofs\/[a-f\d]{24}$/.test(path)) return true;
  if (req.method !== 'POST') return false;
  const customerPayment = path.match(/^\/rentals\/bookings\/([a-f\d]{24})\/(payment|verify)$/);
  if (customerPayment) {
    const row = await require('../models/Rental').Booking.findOne({ _id: customerPayment[1], userId: req.user._id }).select('status').lean();
    // Verification records provider money and never initiates another charge.
    return !!row && (customerPayment[2] === 'verify' || ['CONFIRMED', 'PREPARING', 'READY', 'OUT', 'RETURNED'].includes(row.status));
  }
  if (/^\/(?:admin|seller)\/rentals\/bookings\/[a-f\d]{24}\/payments\/[a-f\d]{24}\/reconcile$/.test(path)) return true;
  if (/^\/rentals\/bookings\/[a-f\d]{24}\/acknowledgements$/.test(path)) return true;
  if (/^\/(?:admin|seller)\/rentals\/bookings\/[a-f\d]{24}\/proofs$/.test(path)) return true;
  if (/^\/(?:admin|seller)\/rentals\/bookings\/[a-f\d]{24}\/courier\/(?:outbound|inbound)\/(?:cancel|sync|reconcile)$/.test(path)) return true;
  if (/^\/(?:admin|seller)\/rentals\/bookings\/[a-f\d]{24}\/(?:refund|collection)$/.test(path)) {
    if (path.endsWith('/refund')) return true;
    const row = await require('../models/Rental').Booking.findById(path.split('/').at(-2)).select('status').lean();
    return ['CONFIRMED', 'PREPARING', 'READY', 'OUT', 'RETURNED'].includes(row?.status);
  }
  if (/^\/(?:admin|seller)\/rentals\/bookings\/[a-f\d]{24}\/operation$/.test(path)) return ['PREPARE', 'READY', 'HANDOVER', 'CANCEL', 'NO_SHOW', 'RECEIVE', 'INSPECT', 'RELEASE', 'DECLARE_LOST', 'CLOSE', 'REOPEN_SETTLEMENT', 'ASSESS', 'WAIVE_ASSESSMENT', 'LOGISTICS'].includes(req.body?.action);
  return /^\/rentals\/bookings\/[a-f\d]{24}\/requests$/.test(path) && ['RETURN_COLLECTION', 'DISPUTE'].includes(req.body?.type);
}

async function assertCapacity(status, path, method, req) {
  if (method !== 'POST') return;
  const productLimit = Number(status.limits?.products);
  const productCreation = path === '/admin/products' || path === '/seller/products'
    || path === '/admin/product-drafts/publish-selected' || /^\/admin\/(?:social-imports|reel-imports)\/[^/]+\/(?:publish|draft)$/.test(path);
  if (productCreation && Number.isFinite(productLimit)) {
    const current = await Product.countDocuments({ isArchived: { $ne: true } });
    const requested = Array.isArray(req?.body?.ids) ? req.body.ids.length : 1;
    if (current + requested > productLimit) throw new ApiError('PLAN_LIMIT_REACHED', `This plan allows ${productLimit} active products`);
  }
  const orderLimit = Number(status.limits?.ordersPerMonth);
  if (['/orders', '/orders/cod', '/create-order', '/payments/create-order'].includes(path) && Number.isFinite(orderLimit)) {
    const { ordersPerMonth: current } = await require('../services/commerceUsageService').monthlyUsage({ allStores: true });
    if (current >= orderLimit) throw new ApiError('PLAN_LIMIT_REACHED', `This plan allows ${orderLimit} orders per month`);
  }
}

module.exports = async function externalLicenseMiddleware(req, _res, next) {
  const path = apiPath(req);
  if (shouldSkip(path)) return next();
  // These public browsing reads have no licensed features/capacity checks and
  // already fail open below. Do not delay every shopper behind a control-plane
  // refresh (including telemetry). Writes and premium reads still validate.
  if (['GET', 'HEAD'].includes(req.method)
    && /^\/(?:storefront\/home(?:\/discovery)?|products(?:\/[^/]+(?:\/complete-look)?)?|categories|banners|settings|website-config|catalog-configuration|reviews\/featured|stores\/resolve|rentals\/(?:configuration|catalogue|payment-methods|products\/[a-f\d]{24}))\/?$/.test(path)) return next();
  if (isCommerceWrite(req.method, path) && !req.user) return next();
  let status;
  try { status = await licenseStatus(); }
  catch (error) {
    if (!isCommerceWrite(req.method, path)) return next();
    return next(error);
  }
  if (!status.managed) return next();
  req.platformLicense = status;
  try {
    if (isCommerceWrite(req.method, path) && ['EXPIRED', 'SUSPENDED', 'REVOKED'].includes(status.status)
      && (status.status === 'REVOKED' || !(await isExistingRentalSettlement(req, path)))) {
      return next(new ApiError('SUBSCRIPTION_REQUIRED', status.status === 'REVOKED' ? 'This installation has been revoked by the platform owner' : 'Renew the store subscription to make changes and accept orders'));
    }
    const requiredFeature = FEATURE_ROUTES.find(([pattern]) => pattern.test(path))?.[1];
    if (requiredFeature && req.user && !status.features?.includes(requiredFeature)) return next(new ApiError('PLAN_FEATURE_REQUIRED', 'This feature is not included in the current plan'));
    await assertCapacity(status, path, req.method, req); return next();
  }
  catch (error) { return next(error); }
};
