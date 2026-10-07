const mongoose = require('mongoose');
const storeIdPlugin = require('./plugins/storeId');

const subscriberSchema = new mongoose.Schema({
  email: { type: String, required: true, lowercase: true, trim: true },
  source: { type: String, default: 'footer' },
  isActive: { type: Boolean, default: true },
  unsubscribedAt: Date,
}, { timestamps: true });

subscriberSchema.plugin(storeIdPlugin);
subscriberSchema.index({ createdAt: -1 });
subscriberSchema.index({ storeId: 1, email: 1 }, { unique: true });

module.exports = mongoose.model('Subscriber', subscriberSchema);
