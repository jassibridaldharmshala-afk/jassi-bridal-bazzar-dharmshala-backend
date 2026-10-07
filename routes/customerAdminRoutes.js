const { masterOnly, isOwnerAccount, isMasterOwner } = require('../config/masterOwner');
const { assertClientHandoverReady } = require('../services/clientHandoverService');
const router = require('express').Router();
const User = require('../models/User');
const { asyncHandler, validateObjectIdParam } = require('../middleware/validate');
const { ApiError, forbidden, notFound } = require('../utils/apiError');
const { readPagination, requireBoolean, wantsPagination, buildPaginatedResponse } = require('../utils/validators');
const { logAudit } = require('../services/auditService');

/**
 * Every route here is mounted behind `protect` + `adminOnly` in app.js.
 * The extra guards below stop an admin from locking themselves out and stop
 * malformed ids from reaching Mongoose.
 */

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assertNotSelf(req, message) {
  if (String(req.params.userId) === String(req.user._id)) throw new ApiError('FORBIDDEN', message);
}

router.get('/', masterOnly, asyncHandler(async (req, res) => {
  const search = String(req.query.search || '').trim();
  const pattern = search ? new RegExp(escapeRegex(search), 'i') : null;
  const filter = pattern ? { $or: [{ phone: pattern }, { name: pattern }, { email: pattern }] } : {};
  if (!isMasterOwner(req.user)) filter.systemRole = { $ne: 'MASTER_OWNER' };
  if (wantsPagination(req.query)) {
    const { page, limit, skip } = readPagination(req.query, { defaultLimit: 24, maxLimit: 100 });
    const [items, total] = await Promise.all([
      User.find(filter).select('-password -masterSessionVersion').sort('-createdAt').skip(skip).limit(limit).lean(),
      User.countDocuments(filter),
    ]);
    return res.json(buildPaginatedResponse(items, { page, limit, total }));
  }

  const { limit, skip } = readPagination(req.query, { defaultLimit: 200, maxLimit: 500 });

  // Admin screens expect a plain array; the limit only guards against
  // unbounded scans as the customer base grows.
  res.json(await User.find(filter).select('-password -masterSessionVersion').sort('-createdAt').skip(skip).limit(limit).lean());
}));

router.patch('/:userId/block', validateObjectIdParam('userId'), asyncHandler(async (req, res) => {
  const isBlocked = requireBoolean(req.body?.isBlocked, 'isBlocked');
  if (!isMasterOwner(req.user)) throw forbidden('Master Owner permission required');
  if (isBlocked) assertNotSelf(req, 'You cannot block your own account');

  const target = await User.findById(req.params.userId).select('phone systemRole role isBlocked');
  if (!target) throw notFound('Customer not found');
  if (isOwnerAccount(target) || (!isMasterOwner(req.user) && target.role === 'admin')) throw forbidden('This account cannot be changed here');
  const customer = await User.findByIdAndUpdate(req.params.userId, { isBlocked }, { new: true }).select('-password -masterSessionVersion');
  if (!customer) throw notFound('Customer not found');
  logAudit({ req, action: isBlocked ? 'CUSTOMER_BLOCK' : 'CUSTOMER_UNBLOCK', entityType: 'User', entityId: customer._id, before: { isBlocked: Boolean(target.isBlocked) }, after: { isBlocked: customer.isBlocked } });
  res.json(customer);
}));

router.patch('/:userId/promote-admin', masterOnly, validateObjectIdParam('userId'), asyncHandler(async (req, res) => {
  await assertClientHandoverReady();
  const user = await User.findById(req.params.userId).select('-password -masterSessionVersion');
  if (!user) throw notFound('User not found');
  if (isOwnerAccount(user)) throw forbidden('The deployment owner account cannot be changed here');
  if (user.isBlocked) throw forbidden('Unblock this user before granting admin access');

  const before = { role: user.role };
  user.role = 'admin';
  user.availableModes = [...new Set([...(user.availableModes || []), 'customer', 'admin'])];
  user.activeMode = 'customer';
  await user.save();
  logAudit({ req, action: 'ROLE_PROMOTE', entityType: 'User', entityId: user._id, before, after: { role: 'admin' } });
  res.json(user);
}));

router.patch('/:userId/demote-admin', masterOnly, validateObjectIdParam('userId'), asyncHandler(async (req, res) => {
  assertNotSelf(req, 'You cannot demote yourself');

  const user = await User.findById(req.params.userId).select('-password -masterSessionVersion');
  if (!user) throw notFound('User not found');
  if (isOwnerAccount(user)) throw forbidden('The deployment owner account cannot be changed here');

  const remainingAdmins = await User.countDocuments({ role: 'admin', _id: { $ne: user._id } });
  if (!remainingAdmins) throw forbidden('At least one admin account must remain');

  const before = { role: user.role };
  user.role = 'customer';
  user.availableModes = (user.availableModes || []).includes('seller') ? ['customer', 'seller'] : ['customer'];
  user.activeMode = 'customer';
  await user.save();
  logAudit({ req, action: 'ROLE_DEMOTE', entityType: 'User', entityId: user._id, before, after: { role: 'customer' } });
  res.json(user);
}));

module.exports = router;
