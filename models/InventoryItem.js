const mongoose = require('mongoose');
const storeIdPlugin = require('./plugins/storeId');

const inventoryItemSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  variantId: { type: String, default: '', trim: true, maxlength: 120 },
  sku: { type: String, default: '', trim: true, maxlength: 120 },
  uniqueItemId: { type: String, required: true, trim: true, uppercase: true, maxlength: 64 },
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
  orderItemId: { type: String, default: '', maxlength: 64 },
  status: {
    type: String,
    enum: ['AVAILABLE', 'RESERVED', 'PACKED', 'SHIPPED', 'DELIVERED', 'RETURN_REQUESTED', 'RETURNED', 'RETURN_VERIFIED', 'RETURN_REJECTED'],
    default: 'AVAILABLE',
  },
  assignedAt: Date,
  packedAt: Date,
  shippedAt: Date,
  deliveredAt: Date,
  returnedAt: Date,
}, { timestamps: true });

inventoryItemSchema.plugin(storeIdPlugin);
inventoryItemSchema.index({ storeId: 1, uniqueItemId: 1 }, { unique: true });
inventoryItemSchema.index({ storeId: 1, product: 1, variantId: 1, status: 1 });
inventoryItemSchema.index({ storeId: 1, order: 1, orderItemId: 1 });

module.exports = mongoose.model('InventoryItem', inventoryItemSchema);

