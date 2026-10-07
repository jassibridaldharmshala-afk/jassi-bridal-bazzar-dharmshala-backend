const mongoose = require('mongoose');
const storeIdPlugin = require('./plugins/storeId');

const NOTIFICATION_CHANNELS = ['IN_APP', 'EMAIL', 'SMS', 'WHATSAPP', 'PUSH'];
const NOTIFICATION_STATUSES = ['QUEUED', 'SENT', 'SKIPPED', 'FAILED'];

const notificationSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  event: { type: String, required: true },
  title: String,
  message: String,
  channel: { type: String, enum: NOTIFICATION_CHANNELS, default: 'IN_APP' },
  status: { type: String, enum: NOTIFICATION_STATUSES, default: 'QUEUED' },
  reason: String,
  metadata: Object,
  audience: { type: String, enum: ['CUSTOMER', 'ADMIN'], default: 'CUSTOMER' },
  dedupeKey: String,
  readAt: Date,
  deliverAfter: Date,
}, { timestamps: true });

notificationSchema.plugin(storeIdPlugin);
notificationSchema.index({ user: 1, createdAt: -1 });
notificationSchema.index({ event: 1, createdAt: -1 });
notificationSchema.index({ user: 1, channel: 1, readAt: 1, createdAt: -1 });
notificationSchema.index({ dedupeKey: 1 }, { unique: true, sparse: true });
notificationSchema.index({ user: 1, deliverAfter: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
module.exports.NOTIFICATION_CHANNELS = NOTIFICATION_CHANNELS;
module.exports.NOTIFICATION_STATUSES = NOTIFICATION_STATUSES;
