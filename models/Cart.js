const mongoose = require('mongoose');

const cartSchema = new mongoose.Schema({
  storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', index: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  sessionId: { type: String, trim: true, maxlength: 120 },
  mergedGuestCarts: [{ type: mongoose.Schema.Types.ObjectId }],
  checkoutConsumptions: [{ type: String, maxlength: 120 }],
  items: [{
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    size: String,
    color: String,
    variantId: String,
    quantity: { type: Number, default: 1, min: 1, validate: Number.isInteger },
    selected: { type: Boolean, default: true },
    price: Number,
  }],
}, { timestamps: true, optimisticConcurrency: true });

cartSchema.index({ storeId: 1, user: 1 }, { unique: true, partialFilterExpression: { user: { $type: 'objectId' } } });
cartSchema.index({ storeId: 1, sessionId: 1 }, { unique: true, partialFilterExpression: { sessionId: { $type: 'string' } } });

module.exports = mongoose.model('Cart', cartSchema);
