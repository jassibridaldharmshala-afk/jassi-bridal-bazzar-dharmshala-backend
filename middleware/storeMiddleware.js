const mongoose = require('mongoose');
const StoreMember = require('../models/StoreMember');
const { roleAllows } = require('../models/StoreMember');
const { ApiError } = require('../utils/apiError');
const { isPlatformAdmin, resolvePublicStore, resolveStoreFromHost } = require('../services/storeService');
const { hasStoreFeature, planSummary, storeLimit } = require('../config/storePlans');
const { isMasterOwner } = require('../config/masterOwner');

function requestedStoreId(req) {
  return String(req.headers['x-store-id'] || req.query.storeId || '').trim();
}

async function optionalResolveStore(req, res, next) {
  try {
    const slug = String(req.headers['x-store-slug'] || req.query.store || '').trim().toLowerCase();
    const resolved = slug
      ? await resolvePublicStore(slug)
      : await resolveStoreFromHost(req.headers['x-forwarded-host'] || req.headers.host);
    req.store = resolved.store;
    req.isDefaultStore = resolved.isDefaultStore;
    req.tenantFilter = resolved.tenantFilter;
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Platform admins on /api/admin keep an unscoped view so existing screens
 * and tests continue to see every document, including legacy rows with no
 * storeId. Seller routes always scope to a membership-checked store.
 */
function platformAdminUnscoped(req, res, next) {
  if (isPlatformAdmin(req.user)) {
    req.tenantFilter = {};
    return next();
  }
  return res.status(403).json({ success: false, code: 'FORBIDDEN', message: 'Admin access required' });
}

async function requireStoreMember(req, res, next) {
  try {
    if (!req.user?._id) throw new ApiError('UNAUTHORIZED', 'Not authorized');

    const headerId = requestedStoreId(req);
    const filter = { user: req.user._id, status: 'ACTIVE' };
    if (headerId) {
      if (!mongoose.Types.ObjectId.isValid(headerId)) {
        throw new ApiError('VALIDATION_ERROR', 'A valid store is required');
      }
      filter.store = headerId;
    }

    let membership = await StoreMember.findOne(filter).populate('store');
    if (!membership && !headerId) {
      membership = await StoreMember.findOne({ user: req.user._id, status: 'ACTIVE' }).populate('store').sort('-createdAt');
    }
    if (!membership?.store) {
      throw new ApiError('FORBIDDEN', 'Seller access required');
    }

    req.storeMember = membership;
    req.store = membership.store;
    req.tenantFilter = { storeId: membership.store._id };
    next();
  } catch (error) {
    next(error);
  }
}

async function requireAdminCustomerStoreAccess(req, _res, next) {
  try {
    if (isMasterOwner(req.user) || req.isDefaultStore) return next();
    const membership = await StoreMember.findOne({ store: req.store?._id, user: req.user?._id, status: 'ACTIVE' });
    if (!membership) throw new ApiError('FORBIDDEN', 'You do not have access to this store’s customers');
    req.storeMember = membership;
    req.tenantFilter = { storeId: req.store._id };
    return next();
  } catch (error) {
    return next(error);
  }
}

function requireStorePermission(permission) {
  return (req, res, next) => {
    if (!req.storeMember) {
      return next(new ApiError('FORBIDDEN', 'Seller access required'));
    }
    if (!roleAllows(req.storeMember.role, permission)) {
      return next(new ApiError('FORBIDDEN', 'You do not have permission for this action'));
    }
    const capability = permissionCapability(permission);
    if (!isMasterOwner(req.user) && capability && req.store?.catalogStructure?.clientPermissions?.[capability] === false) {
      return next(new ApiError('FORBIDDEN', `${capabilityLabel(capability)} is disabled by the platform owner`));
    }
    return next();
  };
}

function requireAnyStorePermission(...permissions) {
  return (req, res, next) => {
    if (!req.storeMember) return next(new ApiError('FORBIDDEN', 'Seller access required'));
    const allowed = permissions.filter((permission) => roleAllows(req.storeMember.role, permission));
    if (!allowed.length) {
      return next(new ApiError('FORBIDDEN', 'You do not have permission for this action'));
    }
    if (!isMasterOwner(req.user) && allowed.every((permission) => {
      const capability = permissionCapability(permission);
      return capability && req.store?.catalogStructure?.clientPermissions?.[capability] === false;
    })) return next(new ApiError('FORBIDDEN', 'This capability is disabled by the platform owner'));
    return next();
  };
}

const CAPABILITY_BY_PERMISSION = Object.freeze({
  catalog: 'catalog', inventory: 'inventory', orders: 'orders', returns: 'returns', reviews: 'reviews',
  marketing: 'discounts', design: 'websiteDesign', content: 'content', reports: 'reports', crm: 'customers',
  inbox: 'social', instagram: 'social', support: 'customers', audit: 'reports',
});
function permissionCapability(permission) { return CAPABILITY_BY_PERMISSION[String(permission || '').split('.')[0]] || ''; }
function capabilityLabel(value) { return String(value || '').replace(/([A-Z])/g, ' $1').replace(/^./, (letter) => letter.toUpperCase()); }

function requireStoreFeature(feature) {
  return (req, _res, next) => {
    if (hasStoreFeature(req.store, feature)) return next();
    const plan = planSummary(req.store);
    const message = ['EXPIRED', 'SUSPENDED'].includes(plan.status)
      ? `Your ${plan.name} licence is ${plan.status.toLowerCase()}. ${plan.renewalMessage || 'Ask the platform owner to renew access.'}`
      : `${feature} is not included in the ${plan.name} plan.`;
    return next(new ApiError('FORBIDDEN', message));
  };
}

function requireActiveStoreLicenseForWrites(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.path.startsWith('/subscription') || req.path.startsWith('/notifications')) return next();
  const plan = planSummary(req.store);
  if (!['EXPIRED', 'SUSPENDED'].includes(plan.status)) return next();
  return next(new ApiError('SUBSCRIPTION_REQUIRED', `Your ${plan.name} subscription is ${plan.status.toLowerCase()}. Renew it to make changes; your existing data remains available.`));
}

function assertStoreCanAcceptOrders(store, { rental = false } = {}) {
  if (!store) return;
  if (!rental && (store.salesEnabled === false || store.catalogStructure?.commerce?.mode === 'RENTAL_ONLY')) {
    throw new ApiError('CHECKOUT_RESTRICTED', 'This store offers rental bookings rather than product sales.');
  }
  if (store.checkoutEnabled === false || store.archivedAt || store.status === 'SUSPENDED') {
    throw new ApiError('SUBSCRIPTION_REQUIRED', 'This store is temporarily not accepting new orders. Please contact the store for help.');
  }
  const plan = planSummary(store);
  if (['EXPIRED', 'SUSPENDED'].includes(plan.status)) {
    throw new ApiError('SUBSCRIPTION_REQUIRED', 'This store is temporarily not accepting new orders. Please contact the store for help.');
  }
}

async function assertMonthlyOrderCapacity(store) {
  if (!store) return;
  assertStoreCanAcceptOrders(store);
  const limit = storeLimit(store, 'ordersPerMonth');
  if (!Number.isFinite(limit)) return;
  const { ordersPerMonth: count } = await require('../services/commerceUsageService').monthlyUsage({ store });
  if (count >= limit) throw new ApiError('PLAN_LIMIT_REACHED', `This store has reached its ${limit.toLocaleString('en-IN')} orders per month plan limit.`);
}

function requireProductCapacity(req, _res, next) {
  Promise.resolve().then(async () => {
    const limit = storeLimit(req.store, 'products');
    if (!Number.isFinite(limit)) return next();
    const count = await require('../models/Product').countDocuments({ storeId: req.store._id, isArchived: { $ne: true } });
    if (count >= limit) throw new ApiError('PLAN_LIMIT_REACHED', `Your plan allows ${limit.toLocaleString('en-IN')} active products. Archive a product or upgrade your subscription.`);
    return next();
  }).catch(next);
}

function stripClientStoreId(req, _res, next) {
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'storeId')) {
    delete req.body.storeId;
  }
  next();
}

function assertStoreOwned(doc, req) {
  if (!req.store?._id || !doc) return doc;
  if (!doc.storeId) return doc;
  if (String(doc.storeId) !== String(req.store._id)) {
    throw new ApiError('FORBIDDEN', 'Not allowed to access another store');
  }
  return doc;
}

module.exports = {
  assertStoreOwned,
  assertMonthlyOrderCapacity,
  assertStoreCanAcceptOrders,
  optionalResolveStore,
  platformAdminUnscoped,
  requireAdminCustomerStoreAccess,
  requireStoreMember,
  requireStoreFeature,
  requireActiveStoreLicenseForWrites,
  requireProductCapacity,
  requireStorePermission,
  requireAnyStorePermission,
  stripClientStoreId,
};
