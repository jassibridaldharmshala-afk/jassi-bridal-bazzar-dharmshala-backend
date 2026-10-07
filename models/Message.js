const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true, index: true },
  storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', index: true },
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  authorRole: { type: String, enum: ['customer', 'seller', 'system'], default: 'customer' },
  body: { type: String, required: true, maxlength: 4000 },
}, { timestamps: true });

messageSchema.index({ conversation: 1, createdAt: 1 });

module.exports = mongoose.model('Message', messageSchema);
