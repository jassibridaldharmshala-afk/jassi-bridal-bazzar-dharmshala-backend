const mongoose = require('mongoose');
const storeIdPlugin = require('./plugins/storeId');

const CONTACT_STATUSES = ['NEW', 'READ', 'REPLIED', 'CLOSED'];

const contactMessageSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true },
  phone: String,
  subject: String,
  message: { type: String, required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  status: { type: String, enum: CONTACT_STATUSES, default: 'NEW' },
  adminNote: String,
}, { timestamps: true });

contactMessageSchema.plugin(storeIdPlugin);
contactMessageSchema.index({ createdAt: -1 });
contactMessageSchema.index({ status: 1, createdAt: -1 });
contactMessageSchema.index({ storeId: 1, createdAt: -1 });

module.exports = mongoose.model('ContactMessage', contactMessageSchema);
module.exports.CONTACT_STATUSES = CONTACT_STATUSES;
