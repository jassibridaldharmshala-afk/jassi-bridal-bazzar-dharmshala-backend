const mongoose = require('mongoose');

/**
 * Append-only ledger of every stock movement.
 *
 * Stock on the Product document is the running balance; this collection
 * explains how it got there, which is what makes oversell and
 * double-restore bugs debuggable after the fact.
 */
const INVENTORY_TRANSACTION_TYPES = [
  'SALE',
  'CANCELLATION',
  'RETURN',
  'MANUAL_ADJUSTMENT',
  'RESTOCK',
  'IMPORT',
  'DAMAGE',
  'SHRINKAGE',
  'SAMPLE',
  'PURCHASE_RECEIPT',
  'REVERSAL',
];

const inventoryTransactionSchema = new mongoose.Schema({
  // Reserved for the multi-tenant phase; single-store data leaves it unset.
  storeId: { type: mongoose.Schema.Types.ObjectId, index: true },
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  variantId: { type: String, default: '' },
  sku: String,
  productSnapshot: { name: String, sku: String, deletedAt: Date },
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
  type: { type: String, enum: INVENTORY_TRANSACTION_TYPES, required: true },
  // Signed: negative removes stock, positive returns it.
  quantity: { type: Number, required: true },
  stockBefore: Number,
  stockAfter: Number,
  mode: { type: String, enum: ['SET', 'ADD', 'REMOVE', 'SYSTEM'], default: 'SYSTEM' },
  bucket: { type: String, enum: ['SELLABLE', 'DAMAGED', 'QUARANTINE'], default: 'SELLABLE' },
  reasonCode: { type: String, trim: true, maxlength: 50, default: '' },
  reason: { type: String, trim: true, maxlength: 200, default: '' },
  note: { type: String, trim: true, maxlength: 500, default: '' },
  reference: { type: String, trim: true, maxlength: 120, default: '' },
  idempotencyKey: { type: String, trim: true, maxlength: 120 },
  reversalOf: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryTransaction' },
  reversedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryTransaction' },
  purchaseOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryPurchaseOrder' },
  unitCost: { type: Number, min: 0 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

inventoryTransactionSchema.index({ storeId: 1, product: 1, createdAt: -1 });
inventoryTransactionSchema.index({ order: 1, type: 1 });
inventoryTransactionSchema.index({ storeId: 1, createdAt: -1 });
inventoryTransactionSchema.index(
  { storeId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);

module.exports = mongoose.model('InventoryTransaction', inventoryTransactionSchema);
module.exports.INVENTORY_TRANSACTION_TYPES = INVENTORY_TRANSACTION_TYPES;
