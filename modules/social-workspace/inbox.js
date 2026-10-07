const crypto = require('crypto');
const { Connection, Thread, Message, WebhookEvent } = require('./models');
const { decryptSecret, encryptSecret } = require('../../utils/secretBox');
const meta = require('./meta');
const mongoose = require('mongoose');
const Order = require('../../models/Order');
const User = require('../../models/User');
const StoreMember = require('../../models/StoreMember');
const CustomerCrm = require('../../models/CustomerCrm');
const { defaultStoreFilter } = require('../../services/storeService');
const { notifyLater } = require('../../services/notificationService');
function attachmentUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''; } catch { return ''; }
}
async function record(account, { id, participantId, participantName, text, attachments = [], direction, sentAt, externalThreadId }) {
  if (!id || !participantId || !['inbound', 'outbound'].includes(direction)) return null;
  const parsedDate = new Date(sentAt || 0);
  if (!Number.isFinite(parsedDate.getTime()) || parsedDate.getTime() > Date.now() + 60000 || parsedDate.getTime() < 1) return null;
  const time = parsedDate;
  const thread = await Thread.findOneAndUpdate({ connectionId: account._id, participantId: String(participantId) }, {
    $setOnInsert: { storeId: account.storeId, provider: account.provider },
    $set: { ...(participantName ? { participantName: String(participantName).slice(0, 160) } : {}), ...(externalThreadId ? { externalId: externalThreadId } : {}) },
  }, { new: true, upsert: true });
  let message; let inserted = false;
  try {
    const write = await Message.updateOne({ connectionId: account._id, externalId: String(id) }, { $setOnInsert: {
      storeId: account.storeId, threadId: thread._id, direction, text: String(text || '').slice(0, 10000), sentAt: time,
      attachments: attachments.slice(0, 20).map(a => ({ type: a.type || 'file', url: attachmentUrl(a.url) })).filter(a => a.url), status: direction === 'inbound' ? 'received' : 'sent',
    } }, { upsert: true });
    inserted = Boolean(write.upsertedCount);
    message = await Message.findOne({ connectionId: account._id, externalId: String(id) });
  } catch (error) { if (error.code !== 11000) throw error; }
  await Thread.updateOne({ _id: thread._id, $or: [{ lastMessageAt: { $lte: time } }, { lastMessageAt: null }] }, { $set: { lastMessageAt: time, preview: String(text || (attachments.length ? 'Attachment' : 'Message')).slice(0, 200) } });
  if (direction === 'inbound') {
    await Thread.updateOne({ _id: thread._id, $or: [{ lastInboundAt: { $lt: time } }, { lastInboundAt: null }] }, { $set: { lastInboundAt: time, resolved: false } });
  }
  return { thread, message, inserted };
}
async function ingestHistory(account, conversation) {
  const participant = (conversation.participants?.data || []).find(p => ![account.accountId, account.pageId].includes(p.id));
  if (!participant) return;
  // History is processed oldest first. Only actual customer messages extend the reply window.
  for (const item of [...(conversation.messages?.data || [])].reverse()) {
    const outgoing = [account.accountId, account.pageId].includes(item.from?.id);
    await record(account, { id: item.id, participantId: participant.id, participantName: participant.name || participant.username, text: item.message, direction: outgoing ? 'outbound' : 'inbound', sentAt: item.created_time, externalThreadId: conversation.id,
      attachments: (item.attachments?.data || []).map(a => ({ type: a.mime_type?.startsWith('image') ? 'image' : 'file', url: a.image_data?.url || a.video_data?.url || a.file_url })) });
  }
  // Keep even an attachment-only conversation visible if Meta omits the message body.
  await Thread.updateOne({ connectionId: account._id, participantId: participant.id }, { $set: { externalId: conversation.id, historyCursor: conversation.messages?.paging?.next ? conversation.messages.paging.cursors?.after || '' : '' } });
}
const fields = 'id,updated_time,participants,messages.limit(25){id,message,from,to,created_time,attachments}';
async function syncConnection(account, { older = false } = {}) {
  if (!meta.capabilities(account).inbox) throw meta.fail('Messaging permission is missing. Reconnect this account.');
  const after = older ? account.syncCursor : '';
  if (older && !after) return { hasMore: false };
  const result = await meta.request(`${account.pageId}/conversations`, { host: account.apiHost || 'graph.facebook.com', token: decryptSecret(account.token), params: { ...(account.authMethod === 'instagram' ? {} : { platform: account.provider === 'instagram' ? 'instagram' : 'messenger' }), fields, limit: 20, after } });
  for (const conversation of result.data || []) await ingestHistory(account, conversation);
  const cursor = result.paging?.next ? result.paging.cursors?.after || '' : '';
  await Connection.updateOne({ _id: account._id }, { $set: { lastSyncedAt: new Date(), status: 'connected', lastError: '', lastErrorAt: null, ...(older || !account.syncCursor ? { syncCursor: cursor } : {}) } });
  return { hasMore: Boolean(cursor) };
}
async function syncAccount(req, res) {
  const account = await Connection.findOneAndUpdate({ _id: req.params.id, storeId: req.socialStore._id, $or: [{ syncLease: null }, { syncLease: { $lt: new Date() } }] }, { $set: { syncLease: new Date(Date.now() + 120000) } }, { new: true }).select('+token');
  if (!account) throw meta.fail('Account not found or an inbox sync is already running.', 409);
  try {
    res.json({ success: true, ...(await syncConnection(account, { older: Boolean(req.body.older) })) });
  } catch (error) {
    await Connection.updateOne({ _id: account._id }, { $set: { lastError: error.message, lastErrorAt: new Date(), ...([190, 102].includes(error.metaCode) ? { status: 'expired' } : { status: 'degraded' }) } }); throw error;
  } finally { await Connection.updateOne({ _id: account._id }, { $unset: { syncLease: 1 } }); }
}
async function list(req, res) {
  const filter = { storeId: req.socialStore._id };
  if (['facebook', 'instagram'].includes(req.query.provider)) filter.provider = req.query.provider;
  if (req.query.state === 'unread') filter.$expr = { $gt: ['$lastInboundAt', { $ifNull: ['$readAt', new Date(0)] }] };
  if (req.query.state === 'open') filter.resolved = false;
  if (req.query.state === 'resolved') filter.resolved = true;
  if (req.query.state === 'overdue') { filter.resolved = false; filter.lastInboundAt = { $lt: new Date(Date.now() - 60 * 60 * 1000) }; }
  if (req.query.state === 'snoozed') filter.snoozedUntil = { $gt: new Date() };
  else filter.$and = [...(filter.$and || []), { $or: [{ snoozedUntil: null }, { snoozedUntil: { $lte: new Date() } }] }];
  if (['LOW', 'NORMAL', 'HIGH', 'URGENT'].includes(req.query.priority)) filter.priority = req.query.priority;
  if (req.query.assigned === 'me') filter.assignedTo = req.user._id;
  if (req.query.assigned === 'unassigned') filter.assignedTo = null;
  if (req.query.search) { const expression = String(req.query.search).slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); filter.$or = [{ participantName: new RegExp(expression, 'i') }, { preview: new RegExp(expression, 'i') }]; }
  const page = Math.max(0, Math.min(1000, parseInt(req.query.page, 10) || 0));
  const rows = await Thread.find(filter).sort({ lastMessageAt: -1, _id: -1 }).skip(page * 30).limit(31).lean();
  const unread = await Thread.countDocuments({ storeId: req.socialStore._id, $expr: { $gt: ['$lastInboundAt', { $ifNull: ['$readAt', new Date(0)] }] } });
  res.json({ threads: rows.slice(0, 30).map(t => ({ ...t, canReply: meta.replyAllowed(t), unread: new Date(t.lastInboundAt || 0) > new Date(t.readAt || 0) })), hasMore: rows.length > 30, unread });
}
async function detail(req, res) {
  const thread = await Thread.findOne({ _id: req.params.id, storeId: req.socialStore._id })
    .populate('assignedTo', 'name').populate('internalNotes.author', 'name').lean();
  if (!thread) throw meta.fail('Conversation not found.', 404);
  const filter = { threadId: thread._id, storeId: thread.storeId };
  if (req.query.before && /^[a-f\d]{24}$/i.test(req.query.before)) {
    const pivot = await Message.findOne({ _id: req.query.before, threadId: thread._id, storeId: thread.storeId }).lean();
    if (!pivot) throw meta.fail('Message not found.', 404);
    filter.$or = [{ sentAt: { $lt: pivot.sentAt } }, { sentAt: pivot.sentAt, _id: { $lt: pivot._id } }];
  }
  const messages = await Message.find(filter).sort({ sentAt: -1, _id: -1 }).limit(51).lean();
  res.json({ thread: { ...thread, canReply: meta.replyAllowed(thread) }, messages: messages.slice(0, 50).reverse(), hasMore: messages.length > 50 });
}
async function markRead(req, res) {
  const thread = await Thread.findOne({ _id: req.params.id, storeId: req.socialStore._id });
  if (!thread) throw meta.fail('Conversation not found.', 404);
  // Mark the last displayed inbound timestamp, rather than messages arriving after the read.
  let readAt;
  if (req.body.readAt) { const time = new Date(req.body.readAt); if (Number.isFinite(time.getTime()) && time <= new Date() && time > new Date(thread.readAt || 0)) readAt = time; }
  if (readAt) await Thread.updateOne({ _id: thread._id }, { $max: { readAt } });
  res.json({ success: true });
}
function labels(value) {
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value.map(item => String(item || '').trim().replace(/\s+/g, ' ').slice(0, 40)).filter(Boolean))].slice(0, 10);
}
async function update(req, res) {
  const thread = await Thread.findOne({ _id: req.params.id, storeId: req.socialStore._id });
  if (!thread) throw meta.fail('Conversation not found.', 404);
  const set = {};
  if (typeof req.body.resolved === 'boolean') set.resolved = req.body.resolved;
  if (['LOW', 'NORMAL', 'HIGH', 'URGENT'].includes(req.body.priority)) set.priority = req.body.priority;
  const nextLabels = labels(req.body.labels); if (nextLabels) set.labels = nextLabels;
  if (Object.prototype.hasOwnProperty.call(req.body, 'snoozedUntil')) {
    const date = req.body.snoozedUntil ? new Date(req.body.snoozedUntil) : null;
    if (date && (!Number.isFinite(date.getTime()) || date <= new Date() || date > new Date(Date.now() + 30 * 86400000))) throw meta.fail('Choose a snooze time within the next 30 days.');
    set.snoozedUntil = date;
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'assignedTo')) {
    const id = String(req.body.assignedTo || '');
    if (id) {
      if (!mongoose.isValidObjectId(id) || !await StoreMember.exists({ store: req.socialStore._id, user: id, status: 'ACTIVE' })) throw meta.fail('Choose an active member of this store.');
      set.assignedTo = id;
    } else set.assignedTo = null;
  }
  await Thread.updateOne({ _id: thread._id }, { $set: set });
  res.json({ thread: await Thread.findById(thread._id).populate('assignedTo', 'name').lean() });
}
async function addNote(req, res) {
  const text = String(req.body.text || '').trim().replace(/\r\n/g, '\n');
  if (!text || text.length > 1000) throw meta.fail('Write an internal note of up to 1,000 characters.');
  const thread = await Thread.findOneAndUpdate({ _id: req.params.id, storeId: req.socialStore._id }, { $push: { internalNotes: { $each: [{ text, author: req.user._id, authorName: req.user.name || 'Team member' }], $slice: -200 } } }, { new: true }).populate('internalNotes.author', 'name');
  if (!thread) throw meta.fail('Conversation not found.', 404);
  res.json({ notes: thread.internalNotes });
}
async function replyPresence(req, res) {
  const active = req.body.active !== false, now = new Date(), expiresAt = new Date(Date.now() + 45000);
  if (!active) {
    await Thread.updateOne({ _id: req.params.id, storeId: req.socialStore._id, 'replyLease.user': req.user._id }, { $unset: { replyLease: 1 } });
    return res.json({ editor: null });
  }
  const thread = await Thread.findOneAndUpdate({ _id: req.params.id, storeId: req.socialStore._id, $or: [{ 'replyLease.expiresAt': { $lt: now } }, { 'replyLease.expiresAt': null }, { 'replyLease.user': req.user._id }] }, { $set: { replyLease: { user: req.user._id, expiresAt } } }, { new: true }).populate('replyLease.user', 'name').lean();
  if (!thread) {
    const occupied = await Thread.findOne({ _id: req.params.id, storeId: req.socialStore._id }).populate('replyLease.user', 'name').lean();
    if (!occupied) throw meta.fail('Conversation not found.', 404);
    return res.status(409).json({ message: `${occupied.replyLease?.user?.name || 'Another team member'} is replying right now.`, editor: occupied.replyLease?.user || null });
  }
  return res.json({ editor: thread.replyLease?.user || null, expiresAt });
}
function orderScope(store) { return store.isDefault ? defaultStoreFilter(store._id) : { storeId: store._id }; }
function maskedPhone(value = '') { const digits = String(value).replace(/\D/g, ''); return digits.length > 4 ? `${'•'.repeat(Math.min(6, digits.length - 4))}${digits.slice(-4)}` : digits; }
function maskedEmail(value = '') { const [name, domain] = String(value).split('@'); return name && domain ? `${name.slice(0, 1)}•••@${domain}` : ''; }
async function searchCustomers(req, res) {
  const search = String(req.query.search || '').trim().slice(0, 80);
  if (search.length < 2) return res.json({ customers: [] });
  const expression = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const scope = orderScope(req.socialStore);
  const [orderUsers, crmUsers] = await Promise.all([
    Order.distinct('user', { $and: [scope, { user: { $ne: null } }] }),
    CustomerCrm.distinct('user', { storeId: req.socialStore._id }),
  ]);
  const ids = [...new Set([...orderUsers, ...crmUsers].map(String))].filter(mongoose.isValidObjectId).map(id => new mongoose.Types.ObjectId(id));
  const customers = await User.find({ _id: { $in: ids }, $or: [{ name: new RegExp(expression, 'i') }, { phone: new RegExp(expression, 'i') }, { email: new RegExp(expression, 'i') }] }).select('name phone email').limit(15).lean();
  const pii = req.socialAllows('crm.pii.read');
  res.json({ customers: customers.map(customer => ({ ...customer, phone: pii ? customer.phone : maskedPhone(customer.phone), email: pii ? customer.email : maskedEmail(customer.email) })) });
}
async function linkCustomer(req, res) {
  const customerId = String(req.body.customerId || '');
  const thread = await Thread.findOne({ _id: req.params.id, storeId: req.socialStore._id });
  if (!thread) throw meta.fail('Conversation not found.', 404);
  if (!customerId) { thread.customer = undefined; await thread.save(); return res.json({ success: true }); }
  if (!mongoose.isValidObjectId(customerId)) throw meta.fail('Choose a valid customer.');
  const scope = orderScope(req.socialStore);
  const belongs = await Promise.all([
    Order.exists({ $and: [scope, { user: customerId }] }),
    CustomerCrm.exists({ storeId: req.socialStore._id, user: customerId }),
  ]);
  if (!belongs.some(Boolean)) throw meta.fail('This customer does not belong to the active store.', 404);
  thread.customer = customerId; await thread.save(); res.json({ success: true });
}
async function context(req, res) {
  const thread = await Thread.findOne({ _id: req.params.id, storeId: req.socialStore._id }).lean();
  if (!thread) throw meta.fail('Conversation not found.', 404);
  if (!thread.customer) return res.json({ customer: null, orders: [] });
  const [customer, orders, crm] = await Promise.all([
    User.findById(thread.customer).select('name phone email').lean(),
    Order.find({ $and: [orderScope(req.socialStore), { user: thread.customer }] }).select('invoiceNumber finalAmount orderStatus paymentStatus paymentMethod createdAt orderItems').sort({ createdAt: -1 }).limit(5).lean(),
    CustomerCrm.findOne({ storeId: req.socialStore._id, user: thread.customer }).select('tags lifecycleStatus followUpAt restrictions').lean(),
  ]);
  const pii = req.socialAllows('crm.pii.read');
  res.json({
    customer: customer ? { ...customer, phone: pii ? customer.phone : maskedPhone(customer.phone), email: pii ? customer.email : maskedEmail(customer.email), tags: crm?.tags || [], lifecycleStatus: crm?.lifecycleStatus || 'ACTIVE', followUpAt: crm?.followUpAt || null } : null,
    orders: orders.map(order => ({ _id: order._id, invoiceNumber: order.invoiceNumber, finalAmount: order.finalAmount, orderStatus: order.orderStatus, paymentStatus: order.paymentStatus, paymentMethod: order.paymentMethod, createdAt: order.createdAt, items: (order.orderItems || []).slice(0, 3).map(item => ({ name: item.name || item.productName, quantity: item.quantity })) })),
  });
}
async function older(req, res) {
  const thread = await Thread.findOne({ _id: req.params.id, storeId: req.socialStore._id });
  if (!thread?.externalId || !thread.historyCursor) throw meta.fail('No older messages are available from Meta.');
  const account = await Connection.findOne({ _id: thread.connectionId, storeId: req.socialStore._id }).select('+token');
  if (!account) throw meta.fail('Reconnect this account first.');
  const result = await meta.request(`${thread.externalId}/messages`, { host: account.apiHost || 'graph.facebook.com', token: decryptSecret(account.token), params: { fields: 'id,message,from,to,created_time,attachments', after: thread.historyCursor, limit: 25 } });
  await ingestHistory(account, { id: thread.externalId, participants: { data: [{ id: thread.participantId, name: thread.participantName }] }, messages: result });
  res.json({ success: true });
}
async function reply(req, res) {
  const text = String(req.body.text || '').trim(), clientId = String(req.body.clientId || '');
  if (!text || text.length > 1000 || !/^[\w-]{16,80}$/.test(clientId)) throw meta.fail('Write a reply of up to 1,000 characters.');
  const thread = await Thread.findOne({ _id: req.params.id, storeId: req.socialStore._id });
  if (!thread) throw meta.fail('Conversation not found.', 404);
  const existing = await Message.findOne({ threadId: thread._id, clientId });
  if (existing) return res.json({ message: existing });
  if (!meta.replyAllowed(thread)) throw meta.fail('The 24-hour reply window has closed. Wait for a new customer message or continue in Meta Business Suite.', 409, 'REPLY_WINDOW_CLOSED');
  const account = await Connection.findOne({ _id: thread.connectionId, storeId: thread.storeId, status: 'connected' }).select('+token');
  if (!account || !meta.capabilities(account).inbox) throw meta.fail('Reconnect this account with messaging access.');
  let message;
  try { message = await Message.create({ storeId: thread.storeId, threadId: thread._id, connectionId: account._id, clientId, direction: 'outbound', text, status: 'sending', sentAt: new Date() }); }
  catch (error) { if (error.code !== 11000) throw error; return res.json({ message: await Message.findOne({ threadId: thread._id, clientId }) }); }
  let accepted = false;
  try {
    const result = await meta.request(`${account.pageId}/messages`, { host: account.apiHost || 'graph.facebook.com', token: decryptSecret(account.token), method: 'POST', params: { recipient: { id: thread.participantId }, message: { text }, ...(account.provider === 'facebook' ? { messaging_type: 'RESPONSE' } : {}) } });
    if (!result.message_id) throw Object.assign(meta.fail('Meta did not confirm delivery. Check the conversation before sending again.'), { ambiguous: true });
    accepted = true;
    // Echo webhooks can arrive before the send response; merge without duplicating the bubble.
    await Message.deleteOne({ connectionId: account._id, externalId: result.message_id, _id: { $ne: message._id } });
    message.externalId = result.message_id; message.status = 'sent';
    await message.save();
    await Thread.updateOne({ _id: thread._id, $or: [{ lastMessageAt: { $lte: message.sentAt } }, { lastMessageAt: null }] }, { $set: { lastMessageAt: message.sentAt, preview: text.slice(0, 200) } });
  } catch (error) {
    message.status = accepted || error.ambiguous ? 'unknown' : 'failed'; message.error = accepted ? 'Meta accepted the reply but local confirmation was interrupted. Sync and check the conversation before sending again.' : error.message; await message.save();
  }
  res.json({ message });
}
async function accountFor(provider, id) {
  return Connection.findOne({ provider, status: { $in: ['connected', 'degraded'] }, $or: [{ accountId: String(id) }, { pageId: String(id) }] });
}
async function processDelivery(account, event) {
  if (event.delivery) {
    const deliveredAt = new Date(Number(event.delivery.watermark || event.timestamp || Date.now()));
    const mids = (event.delivery.mids || []).map(String).slice(0, 100);
    if (mids.length) await Message.updateMany({ connectionId: account._id, externalId: { $in: mids }, direction: 'outbound', status: { $in: ['sending', 'sent'] } }, { $set: { status: 'delivered', deliveredAt } });
  }
  if (event.read) {
    const readAt = new Date(Number(event.read.watermark || event.timestamp || Date.now()));
    const filter = { connectionId: account._id, direction: 'outbound', sentAt: { $lte: readAt }, status: { $in: ['sent', 'delivered'] } };
    if (event.read.mid) filter.externalId = String(event.read.mid);
    await Message.updateMany(filter, { $set: { status: 'read', readAt } });
  }
}
async function processMessagingEvent(account, event) {
  if (event.delivery || event.read) return processDelivery(account, event);
  if (event.reaction?.mid) return Message.updateOne({ connectionId: account._id, externalId: String(event.reaction.mid) }, { $set: { reaction: { emoji: String(event.reaction.emoji || '').slice(0, 16), action: event.reaction.action === 'unreact' ? 'unreact' : 'react', updatedAt: new Date(Number(event.timestamp || Date.now())) } } });
  const outgoing = Boolean(event.message?.is_echo) || [account.accountId, account.pageId].includes(String(event.sender?.id));
  const participantId = outgoing ? event.recipient?.id : event.sender?.id;
  const mid = event.message?.mid || (event.postback ? `postback:${event.timestamp}:${participantId}` : '');
  if (!mid || !participantId) return null;
  if (event.message?.is_deleted) return Message.updateOne({ connectionId: account._id, externalId: mid }, { $set: { text: 'This message was removed on Meta.', attachments: [] } });
  const context = event.message?.reply_to?.story ? { type: 'story', id: event.message.reply_to.mid || '', url: attachmentUrl(event.message.reply_to.story.url) } : undefined;
  const result = await record(account, { id: mid, participantId, direction: outgoing ? 'outbound' : 'inbound', text: event.message?.text || event.postback?.title || event.postback?.payload || '', sentAt: event.timestamp, attachments: (event.message?.attachments || []).map(a => ({ type: a.type, url: a.payload?.url })) });
  if (context && result?.message) {
    await Message.updateOne({ _id: result.message._id }, { $set: { context } });
    await Thread.updateOne({ _id: result.thread._id }, { $set: { contextType: 'story', contextId: context.id } });
  }
  if (!outgoing && result?.inserted) notifyLater({ event: 'SOCIAL_MESSAGE_RECEIVED', adminEvent: 'SOCIAL_MESSAGE_RECEIVED', channels: ['IN_APP'], storeId: account.storeId, metadata: { socialMessageId: result.message?._id, socialAccountId: account._id, socialThreadId: result.thread?._id } });
  return result;
}
async function processCommentChange(account, value, timestamp) {
  const id = value.id || value.comment_id, participantId = value.from?.id || value.sender_id;
  if (!id || !participantId || value.verb === 'remove') return;
  const result = await record(account, { id: `comment:${id}`, participantId, participantName: value.from?.name || value.from?.username, direction: 'inbound', text: value.message || value.text || 'New comment', sentAt: timestamp || Date.now(), externalThreadId: `comment:${value.post_id || value.media?.id || id}` });
  if (result?.thread) await Thread.updateOne({ _id: result.thread._id }, { $set: { contextType: 'comment', contextId: String(value.post_id || value.media?.id || id) } });
  if (result?.inserted) notifyLater({ event: 'SOCIAL_MESSAGE_RECEIVED', adminEvent: 'SOCIAL_MESSAGE_RECEIVED', channels: ['IN_APP'], storeId: account.storeId, metadata: { socialMessageId: result.message?._id, socialAccountId: account._id, socialThreadId: result.thread?._id } });
}
async function processWebhookPayload(payload) {
  for (const entry of (payload.entry || []).slice(0, 100)) {
    const provider = payload.object === 'instagram' ? 'instagram' : 'facebook';
    const account = await accountFor(provider, entry.id);
    if (!account) continue;
    for (const event of (entry.messaging || []).slice(0, 100)) await processMessagingEvent(account, event);
    for (const change of (entry.changes || []).slice(0, 100)) if (['comments', 'feed'].includes(change.field)) await processCommentChange(account, change.value || {}, entry.time);
  }
}
async function webhook(req, res) {
  if (!meta.verifySignature(req.body, req.headers['x-hub-signature-256'])) return res.sendStatus(403);
  let payload; try { payload = JSON.parse(req.body.toString('utf8')); } catch { return res.sendStatus(400); }
  if (!payload || !Array.isArray(payload.entry) || payload.entry.length > 100) return res.sendStatus(400);
  const eventHash = crypto.createHash('sha256').update(req.body).digest('hex');
  await WebhookEvent.updateOne({ eventHash }, { $setOnInsert: { eventHash, encryptedPayload: encryptSecret(JSON.stringify(payload)), status: 'pending', nextAttemptAt: new Date(), expiresAt: new Date(Date.now() + 7 * 86400000) } }, { upsert: true });
  res.sendStatus(200);
  require('./webhookWorker').kick();
}
function verifyWebhook(req, res) {
  if (meta.config().verifyToken && req.query['hub.mode'] === 'subscribe' && meta.equal(req.query['hub.verify_token'], meta.config().verifyToken)) return res.status(200).type('text').send(String(req.query['hub.challenge'] || ''));
  return res.sendStatus(403);
}
module.exports = { record, ingestHistory, syncConnection, syncAccount, list, detail, markRead, update, addNote, replyPresence, searchCustomers, linkCustomer, context, older, reply, webhook, verifyWebhook, processWebhookPayload };
