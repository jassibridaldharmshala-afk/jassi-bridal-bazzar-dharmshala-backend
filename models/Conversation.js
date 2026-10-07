const mongoose = require('mongoose');

const CONVERSATION_STATUSES = ['OPEN', 'PENDING', 'RESOLVED', 'CLOSED'];
const CONVERSATION_CHANNELS = ['WEBSITE', 'ORDER', 'RETURN'];

const conversationSchema = new mongoose.Schema({
  storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', index: true },
  channel: { type: String, enum: CONVERSATION_CHANNELS, default: 'WEBSITE', index: true },
  status: { type: String, enum: CONVERSATION_STATUSES, default: 'OPEN', index: true },
  subject: { type: String, maxlength: 160 },
  customer: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  customerName: String,
  customerEmail: String,
  customerPhone: String,
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
  returnRequest: { type: mongoose.Schema.Types.ObjectId, ref: 'ReturnExchange' },
  contactMessage: { type: mongoose.Schema.Types.ObjectId, ref: 'ContactMessage' },
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  lastMessageAt: { type: Date, default: Date.now, index: true },
}, { timestamps: true });

conversationSchema.index({ storeId: 1, status: 1, lastMessageAt: -1 });

module.exports = mongoose.model('Conversation', conversationSchema);
module.exports.CONVERSATION_STATUSES = CONVERSATION_STATUSES;
module.exports.CONVERSATION_CHANNELS = CONVERSATION_CHANNELS;
