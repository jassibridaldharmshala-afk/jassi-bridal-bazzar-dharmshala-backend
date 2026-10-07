const mongoose = require('mongoose');
const storeIdPlugin = require('./plugins/storeId');

const itemSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  variantId: { type: String, default: '' },
  productName: { type: String, required: true, trim: true, maxlength: 180 },
  sku: { type: String, trim: true, maxlength: 120, default: '' },
  orderedQuantity: { type: Number, required: true, min: 1 },
  receivedQuantity: { type: Number, min: 0, default: 0 },
  damagedQuantity: { type: Number, min: 0, default: 0 },
  unitCost: { type: Number, min: 0, default: 0 },
}, { _id: true });

const inventoryPurchaseOrderSchema = new mongoose.Schema({
  number: { type: String, required: true, trim: true, maxlength: 60 },
  supplier: {
    name: { type: String, required: true, trim: true, maxlength: 160 },
    phone: { type: String, trim: true, maxlength: 30, default: '' },
    email: { type: String, trim: true, lowercase: true, maxlength: 160, default: '' },
  },
  status: {
    type: String,
    enum: ['DRAFT', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'],
    default: 'ORDERED',
    index: true,
  },
  expectedAt: Date,
  orderedAt: { type: Date, default: Date.now },
  receivedAt: Date,
  cancelledAt: Date,
  notes: { type: String, trim: true, maxlength: 1000, default: '' },
  items: { type: [itemSchema], validate: [(items) => Array.isArray(items) && items.length > 0, 'Add at least one purchase item'] },
  revision: { type: Number, min: 0, default: 0 },
  receivingOperation: { type: String, default: '', select: false },
  receivingOperationUntil: { type: Date, select: false },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

inventoryPurchaseOrderSchema.plugin(storeIdPlugin);
inventoryPurchaseOrderSchema.index({ storeId: 1, number: 1 }, { unique: true });
inventoryPurchaseOrderSchema.index({ storeId: 1, status: 1, expectedAt: 1 });

module.exports = mongoose.model('InventoryPurchaseOrder', inventoryPurchaseOrderSchema);
