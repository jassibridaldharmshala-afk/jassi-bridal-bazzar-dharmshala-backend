const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', required: true },
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
  channel: { type: String, enum: ['EMAIL', 'WHATSAPP'], required: true },
  dedupeKey: { type: String, required: true, unique: true },
  recipient: { type: String, required: true, select: false },
  status: { type: String, enum: ['QUEUED', 'SENDING', 'RETRY', 'ACCEPTED', 'FAILED', 'UNCERTAIN', 'SKIPPED'], default: 'QUEUED' },
  test: { type: Boolean, default: false },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: Date.now },
  leaseUntil: Date,
  leaseToken: String,
  providerMessageId: String,
  reason: String,
  acceptedAt: Date,
}, { timestamps: true });
schema.index({ status: 1, nextAttemptAt: 1 });
schema.index({ storeId: 1, createdAt: -1 });
module.exports = mongoose.model('OrderAlertDelivery', schema);
