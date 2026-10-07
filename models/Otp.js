const mongoose = require('mongoose');

const otpSchema = new mongoose.Schema({
  phone: { type: String, index: true, sparse: true },
  email: { type: String, index: true, sparse: true },
  target: { type: String, required: true, index: true },
  targetType: { type: String, enum: ['phone', 'email'], default: 'phone', index: true },
  otpHash: { type: String, required: true },
  purpose: { type: String, enum: ['login', 'register', 'profile_phone_change', 'profile_email_change', 'master_login', 'master_demo_login', 'order_cod_verification'], default: 'login' },
  contextId: { type: String, trim: true, maxlength: 100, index: true, sparse: true },
  trustedDelivery: { type: Boolean, default: false },
  provider: { type: String, default: 'mock' },
  expiresAt: { type: Date, required: true },
  attempts: { type: Number, default: 0 },
  maxAttempts: { type: Number, default: 5 },
  isUsed: { type: Boolean, default: false },
  resendCount: { type: Number, default: 0 },
  ipAddress: String,
  userAgent: String,
}, { timestamps: true });

otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('Otp', otpSchema);
