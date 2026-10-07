const Notification = require('../models/Notification');
const { asyncHandler } = require('../middleware/validate');
const { notFound } = require('../utils/apiError');
const { readPagination, requireObjectId, requireEnum, wantsPagination, buildPaginatedResponse } = require('../utils/validators');

function recipientFilter(req) {
  return {
    user: req.user._id,
    channel: 'IN_APP',
    status: 'SENT',
    deliverAfter: { $not: { $gt: new Date() } },
    ...(req.tenantFilter || {}),
    ...(req.user.role === 'admin' || ['admin', 'seller'].includes(req.user.activeMode) ? {} : { audience: { $ne: 'ADMIN' } }),
  };
}

exports.myNotifications = asyncHandler(async (req, res) => {
  const { limit, skip } = readPagination(req.query, { defaultLimit: 50, maxLimit: 100 });
  const filter = recipientFilter(req);
  if (req.query.read) filter.readAt = requireEnum(req.query.read, ['read', 'unread'], 'read filter') === 'read' ? { $ne: null } : null;
  if (req.query.category) {
    const category = requireEnum(req.query.category, ['orders', 'returns', 'payments', 'support'], 'category');
    filter.event = { $regex: { orders: '^ORDER_', returns: '^(RETURN_|EXCHANGE_)', payments: '^(PAYMENT_|REFUND_)', support: '^CONTACT_' }[category] };
  }
  const items = await Notification.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit);
  if (!wantsPagination(req.query)) return res.json(items);
  const { page } = readPagination(req.query);
  res.json(buildPaginatedResponse(items, { page, limit, total: await Notification.countDocuments(filter) }));
});

exports.summary = asyncHandler(async (req, res) => {
  const filter = { ...recipientFilter(req), readAt: null };
  const [unreadCount, latest] = await Promise.all([
    Notification.countDocuments(filter),
    Notification.findOne(filter).sort({ createdAt: -1, _id: -1 }).select('title message event metadata audience createdAt'),
  ]);
  res.json({ unreadCount, latest });
});

exports.markAllRead = asyncHandler(async (req, res) => {
  const readAt = new Date();
  await Notification.updateMany({ ...recipientFilter(req), readAt: null }, { $set: { readAt } });
  res.json({ readAt });
});

exports.markRead = asyncHandler(async (req, res) => {
  requireObjectId(req.params.id, 'notification id');
  const notification = await Notification.findOneAndUpdate(
    { ...recipientFilter(req), _id: req.params.id },
    { $set: { readAt: req.body?.read === false ? null : new Date() } },
    { new: true },
  );
  if (!notification) throw notFound('Notification not found');
  res.json(notification);
});
exports.recipientFilter = recipientFilter;
