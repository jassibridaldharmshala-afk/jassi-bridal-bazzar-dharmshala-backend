const mongoose = require('mongoose');

// Separate from public /settings: destinations and provider credentials must
// never be included in storefront configuration or a generated client ZIP.
const schema = new mongoose.Schema({
  storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', required: true, unique: true },
  revision: { type: Number, default: 0 },
  enabledAt: Date,
  email: {
    enabled: { type: Boolean, default: false },
    recipient: String, senderEmail: String, senderName: String,
    apiKey: { type: String, select: false },
  },
  whatsapp: {
    enabled: { type: Boolean, default: false },
    recipient: String, phoneNumberId: String, templateName: String,
    language: { type: String, default: 'en' },
    consent: { type: Boolean, default: false },
    accessToken: { type: String, select: false },
  },
  storefrontUrl: String,
  lastTestAt: Date,
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

module.exports = mongoose.model('OrderAlertConfiguration', schema);
