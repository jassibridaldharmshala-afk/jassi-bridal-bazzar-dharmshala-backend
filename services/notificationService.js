const Notification = require('../models/Notification');
const User = require('../models/User');
const StoreMember = require('../models/StoreMember');
const mongoose = require('mongoose');

const ADMIN_EVENTS = {
  ORDER_PLACED: ['New order received', 'A new order is ready to review.'],
  ORDER_CONFIRMED: ['Online order confirmed', 'Payment was confirmed for a new order.'],
  ORDER_CANCELLED: ['Order cancelled', 'An order has been cancelled.'],
  RETURN_REQUESTED: ['New return or exchange request', 'A customer request needs your review.'],
  CONTACT_RECEIVED: ['New support message', 'A customer has contacted the store.'],
  PAYMENT_FAILED: ['Payment failed', 'A customer payment attempt needs attention.'],
  LOW_STOCK: ['Low stock alert', 'A product has reached its low-stock threshold.'],
  ORDER_SHIPPED: ['Shipment updated', 'An order shipment is now moving.'],
  ORDER_OUT_FOR_DELIVERY: ['Out for delivery', 'An order is out for delivery.'],
  ORDER_DELIVERED: ['Order delivered', 'An order was delivered successfully.'],
  REVIEW_SUBMITTED: ['New customer review', 'A verified customer submitted a product review.'],
  REVIEW_NEGATIVE: ['Negative review needs attention', 'A verified customer left a one or two star review. Follow up promptly.'],
  REVIEW_REPORTED: ['Review reported', 'A customer review needs moderation.'],
  SOCIAL_MESSAGE_RECEIVED: ['New social message', 'A customer sent a new message in Social studio.'],
  SOCIAL_POST_FAILED: ['Social post needs attention', 'A scheduled or submitted social post could not be completed.'],
  SOCIAL_CONNECTION_EXPIRING: ['Social connection expiring', 'A connected Meta account should be reconnected soon.'],
  SOCIAL_CONNECTION_EXPIRED: ['Social connection expired', 'Reconnect the Meta account to restore inbox and publishing.'],
};

/**
 * In-app notifications are stored. Transactional provider adapters used by
 * OTP/reporting are separate and do not make a general notification channel
 * available. Unsupported channels stay explicit instead of appearing sent.
 */
function channelAvailable(channel) {
  if (channel === 'IN_APP') return true;
  return false;
}

async function notify({
  userId,
  event,
  title,
  message,
  channels = ['IN_APP'],
  metadata,
  storeId,
  deliverAfter,
  adminEvent,
} = {}) {
  if (!event) return [];
  const docs = [];

  for (const channel of channels) {
    if (channel === 'IN_APP' && !userId) continue;
    const available = channelAvailable(channel);
    if (channel === 'IN_APP' && userId && available) {
      docs.push({
        user: userId,
        event,
        title,
        message,
        channel,
        status: 'SENT',
        metadata,
        audience: 'CUSTOMER',
        storeId,
        deliverAfter,
      });
      continue;
    }

    docs.push({
      user: userId || undefined,
      event,
      title,
      message,
      channel,
      status: 'SKIPPED',
      reason: `${channel} delivery is not enabled for general notifications`,
      metadata, storeId, deliverAfter,
    });
  }

  const staffEvent = adminEvent || event;
  if (channels.includes('IN_APP') && ADMIN_EVENTS[staffEvent]) {
    const [admins, members] = await Promise.all([
      User.find({ role: 'admin', isBlocked: { $ne: true } }).select('_id'),
      storeId && mongoose.Types.ObjectId.isValid(storeId)
        ? StoreMember.find({ store: storeId, status: 'ACTIVE' }).select('user')
        : [],
    ]);
    const adminIds = [...new Set([...admins.map((admin) => String(admin._id)), ...members.map((member) => String(member.user))])];
    adminIds.forEach((adminId) => docs.push({
      user: adminId, event: staffEvent, title: ADMIN_EVENTS[staffEvent][0], message: ADMIN_EVENTS[staffEvent][1],
      audience: 'ADMIN', channel: 'IN_APP', status: 'SENT', metadata, storeId,
    }));
  }

  if (!docs.length) return [];
  const entity = metadata?.subscriptionId || metadata?.refundId || metadata?.returnId || metadata?.contactId || metadata?.reviewId || metadata?.orderId || metadata?.productId || metadata?.socialMessageId || metadata?.socialPostId || metadata?.socialAccountId;
  const once = ['ORDER_PLACED', 'ORDER_CONFIRMED', 'ORDER_SHIPPED', 'ORDER_OUT_FOR_DELIVERY', 'ORDER_DELIVERED', 'ORDER_CANCELLED', 'PAYMENT_FAILED', 'REFUND_PROCESSED', 'RETURN_REQUESTED', 'CONTACT_RECEIVED', 'SUBSCRIPTION_EXPIRING', 'SUBSCRIPTION_EXPIRED', 'SUBSCRIPTION_ACTIVATED', 'REVIEW_SUBMITTED', 'REVIEW_NEGATIVE', 'REVIEW_REPORTED', 'REVIEW_REPLIED', 'REVIEW_MODERATED', 'REVIEW_REQUEST', 'SOCIAL_MESSAGE_RECEIVED', 'SOCIAL_POST_FAILED', 'SOCIAL_CONNECTION_EXPIRING', 'SOCIAL_CONNECTION_EXPIRED'].includes(event)
    || ['REVIEW_NEGATIVE'].includes(staffEvent);
  if (!once || !entity) return Notification.insertMany(docs);
  await Notification.bulkWrite(docs.map((doc) => {
    if (!doc.user || doc.channel !== 'IN_APP') return { insertOne: { document: doc } };
    const dedupeKey = `${doc.user}:${doc.audience}:${doc.event}:${entity}`;
    return { updateOne: { filter: { dedupeKey }, update: { $setOnInsert: { ...doc, dedupeKey } }, upsert: true, timestamps: false } };
  }).map((operation) => {
    if (operation.updateOne) Object.assign(operation.updateOne.update.$setOnInsert, { createdAt: new Date(), updatedAt: new Date() });
    return operation;
  }));
  return docs;
}

function notifyLater(payload) {
  setImmediate(() => {
    notify(payload).catch(() => null);
  });
}

module.exports = { channelAvailable, notify, notifyLater };
