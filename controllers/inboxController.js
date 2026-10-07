const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const { CONVERSATION_STATUSES } = require('../models/Conversation');
const { asyncHandler } = require('../middleware/validate');
const { notFound } = require('../utils/apiError');
const { optionalString, readPagination, requireEnum, requireObjectId, requireString, wantsPagination, buildPaginatedResponse } = require('../utils/validators');
const { addMessage } = require('../services/inboxService');

exports.list = asyncHandler(async (req, res) => {
  const filter = { ...req.tenantFilter };
  if (req.query.status) filter.status = requireEnum(req.query.status, CONVERSATION_STATUSES, 'status');
  if (req.query.channel) filter.channel = String(req.query.channel).toUpperCase();

  const sort = { lastMessageAt: -1 };
  if (!wantsPagination(req.query)) {
    return res.json(await Conversation.find(filter).populate('customer', 'name email phone').sort(sort).limit(200));
  }
  const { page, limit, skip } = readPagination(req.query, { defaultLimit: 24, maxLimit: 100 });
  const [items, total] = await Promise.all([
    Conversation.find(filter).populate('customer', 'name email phone').sort(sort).skip(skip).limit(limit),
    Conversation.countDocuments(filter),
  ]);
  res.json(buildPaginatedResponse(items, { page, limit, total }));
});

exports.get = asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id, 'conversation id');
  const conversation = await Conversation.findOne({ _id: id, ...req.tenantFilter }).populate('customer', 'name email phone');
  if (!conversation) throw notFound('Conversation not found');
  const messages = await Message.find({ conversation: conversation._id }).sort('createdAt').limit(500);
  res.json({ conversation, messages });
});

exports.reply = asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id, 'conversation id');
  const body = requireString(req.body?.body, 'body', { min: 1, max: 4000 });
  const conversation = await Conversation.findOne({ _id: id, ...req.tenantFilter });
  if (!conversation) throw notFound('Conversation not found');
  const message = await addMessage(conversation, {
    body,
    author: req.user._id,
    authorRole: 'seller',
    storeId: req.store._id,
  });
  if (req.body?.status) {
    conversation.status = requireEnum(req.body.status, CONVERSATION_STATUSES, 'status');
    await conversation.save();
  }
  res.status(201).json({ conversation, message });
});

exports.updateStatus = asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id, 'conversation id');
  const status = requireEnum(req.body?.status, CONVERSATION_STATUSES, 'status');
  const assignedTo = optionalString(req.body?.assignedTo, 'assignedTo', { max: 40 });
  const conversation = await Conversation.findOneAndUpdate(
    { _id: id, ...req.tenantFilter },
    { status, ...(assignedTo ? { assignedTo } : {}) },
    { new: true },
  );
  if (!conversation) throw notFound('Conversation not found');
  res.json(conversation);
});
