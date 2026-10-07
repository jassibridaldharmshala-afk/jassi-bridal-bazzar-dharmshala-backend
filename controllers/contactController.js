const ContactMessage = require('../models/ContactMessage');
const { asyncHandler } = require('../middleware/validate');
const { notFound } = require('../utils/apiError');
const { optionalIndianMobile, optionalString, readPagination, requireEmail, requireEnum, requireObjectId, requireString } = require('../utils/validators');
const { notifyLater } = require('../services/notificationService');
const { openConversation } = require('../services/inboxService');
const { andFilter } = require('../services/storeService');
const { wantsPagination, buildPaginatedResponse } = require('../utils/validators');

const CONTACT_STATUSES = require('../models/ContactMessage').CONTACT_STATUSES;

exports.createMessage = asyncHandler(async (req, res) => {
  const name = requireString(req.body?.name, 'name', { max: 80 });
  const email = requireEmail(req.body?.email);
  const phone = optionalIndianMobile(req.body?.phone, 'phone');
  const subject = optionalString(req.body?.subject, 'subject', { max: 120 }) || 'Website enquiry';
  const message = requireString(req.body?.message, 'message', { min: 10, max: 4000 });

  const created = await ContactMessage.create({
    name,
    email,
    phone,
    subject,
    message,
    user: req.user?._id,
    storeId: req.store?._id,
  });

  await openConversation({
    storeId: req.store?._id,
    channel: 'WEBSITE',
    subject,
    customer: req.user?._id,
    customerName: name,
    customerEmail: email,
    customerPhone: phone,
    contactMessage: created._id,
    body: message,
    author: req.user?._id,
    authorRole: 'customer',
  }).catch(() => null);

  notifyLater({
    storeId: created.storeId,
    event: 'CONTACT_RECEIVED',
    title: 'New contact message',
    message: `${name}: ${subject}`,
    metadata: { contactId: String(created._id) },
  });

  res.status(201).json({ success: true, message: 'Message received. We will contact you shortly.', id: created._id });
});

exports.adminList = asyncHandler(async (req, res) => {
  const extra = {};
  if (req.query.id) extra._id = requireObjectId(req.query.id, 'message id');
  if (req.query.status) extra.status = requireEnum(req.query.status, CONTACT_STATUSES, 'status');
  const query = andFilter(extra, req.tenantFilter);
  if (wantsPagination(req.query)) {
    const { page, limit, skip } = readPagination(req.query, { defaultLimit: 24, maxLimit: 100 });
    const [items, total] = await Promise.all([
      ContactMessage.find(query).sort('-createdAt').skip(skip).limit(limit),
      ContactMessage.countDocuments(query),
    ]);
    return res.json(buildPaginatedResponse(items, { page, limit, total }));
  }
  const { limit, skip } = readPagination(req.query, { defaultLimit: 200, maxLimit: 500 });
  res.json(await ContactMessage.find(query).sort('-createdAt').skip(skip).limit(limit));
});

exports.updateStatus = asyncHandler(async (req, res) => {
  requireObjectId(req.params.id, 'message id');
  const status = requireEnum(req.body?.status, CONTACT_STATUSES, 'status');
  const adminNote = optionalString(req.body?.adminNote, 'adminNote', { max: 1000 });
  const updated = await ContactMessage.findByIdAndUpdate(
    req.params.id,
    { status, ...(adminNote ? { adminNote } : {}) },
    { new: true },
  );
  if (!updated) throw notFound('Message not found');
  res.json(updated);
});
