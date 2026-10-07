const Subscriber = require('../models/Subscriber');
const { asyncHandler } = require('../middleware/validate');
const { requireEmail, readPagination, wantsPagination, buildPaginatedResponse } = require('../utils/validators');
const { andFilter } = require('../services/storeService');

exports.subscribe = asyncHandler(async (req, res) => {
  const email = requireEmail(req.body?.email);
  const existing = await Subscriber.findOne(andFilter({ email }, req.tenantFilter));
  if (existing) {
    if (!existing.isActive) {
      existing.isActive = true;
      existing.unsubscribedAt = undefined;
      await existing.save();
    }
    return res.status(200).json({ success: true, message: 'You are already subscribed.', alreadySubscribed: true });
  }

  await Subscriber.create({ email, source: req.body?.source || 'footer', storeId: req.store?._id });
  res.status(201).json({ success: true, message: 'Thanks for subscribing.' });
});

exports.unsubscribe = asyncHandler(async (req, res) => {
  const email = requireEmail(req.body?.email);
  const subscriber = await Subscriber.findOne(andFilter({ email }, req.tenantFilter));
  if (subscriber && subscriber.isActive) {
    subscriber.isActive = false;
    subscriber.unsubscribedAt = new Date();
    await subscriber.save();
  }
  res.json({ success: true, message: 'You have been unsubscribed.' });
});

exports.adminList = asyncHandler(async (req, res) => {
  const filter = andFilter({}, req.tenantFilter);
  if (wantsPagination(req.query)) {
    const { page, limit, skip } = readPagination(req.query, { defaultLimit: 24, maxLimit: 100 });
    const [items, total] = await Promise.all([
      Subscriber.find(filter).sort('-createdAt').skip(skip).limit(limit),
      Subscriber.countDocuments(filter),
    ]);
    return res.json(buildPaginatedResponse(items, { page, limit, total }));
  }
  const { limit, skip } = readPagination(req.query, { defaultLimit: 200, maxLimit: 500 });
  res.json(await Subscriber.find(filter).sort('-createdAt').skip(skip).limit(limit));
});
