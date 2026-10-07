const mongoose = require('mongoose');
const storeIdPlugin = require('./plugins/storeId');

const checkoutAttemptSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  attemptId: { type: String, required: true, trim: true, maxlength: 120 },
  fingerprint: { type: String, required: true, maxlength: 64, select: false },
  status: { type: String, enum: ['PROCESSING', 'READY', 'FAILED'], default: 'PROCESSING' },
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
  providerOrderId: String,
  failureCode: String,
  expiresAt: { type: Date, default: () => new Date(Date.now() + 24 * 60 * 60 * 1000) },
}, { timestamps: true });

checkoutAttemptSchema.plugin(storeIdPlugin);
checkoutAttemptSchema.index({ user: 1, attemptId: 1 }, { unique: true, name: 'one_payment_setup_per_checkout_attempt' });
checkoutAttemptSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('CheckoutAttempt', checkoutAttemptSchema);
