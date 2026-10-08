// Shared boundary for customer-visible catalog and sale snapshots.
const MERCHANT_FIELDS = new Set([
  'costPrice', 'purchasePrice', 'supplierName', 'supplierSku', 'supplier', 'supplierId',
  'inventoryLocation', 'binLocation', 'warehouse', 'warehouseId', 'nonSellableStock',
  'lowStockAlert', 'reorderQuantity', 'inventoryRevision', 'catalogReferenceRevision',
  'lastInventoryChangeAt', 'lastInventoryChangedBy', 'sourceDraftId', 'industryRevision',
  'createdBy', 'updatedBy', 'archivedBy', 'archivedAt', 'audit', 'auditLog', '__v',
]);
const LINE_FIELDS = new Set([
  ...MERCHANT_FIELDS, 'uniqueItemIds', 'allocations', 'profit', 'margin', 'costAmount',
]);
// Never mutate the database document: staff and accounting still need these fields.
function sanitize(value, hidden) {
  if (Array.isArray(value)) return value.map(item => sanitize(item, hidden));
  if (!value || typeof value !== 'object' || value instanceof Date || value._bsontype) return value;
  const source = value.toObject ? value.toObject() : value instanceof Map ? Object.fromEntries(value) : value;
  return Object.fromEntries(Object.entries(source).filter(([key]) => !hidden.has(key)).map(([key, item]) => [key, sanitize(item, hidden)]));
}
function publicProduct(value) { return sanitize(value, MERCHANT_FIELDS); }
function publicOrderLines(value) { return sanitize(value || [], LINE_FIELDS); }
function publicSaleOrder(value) {
  const order = publicProduct(value?.toObject ? value.toObject() : { ...(value || {}) });
  for (const key of ['packageVerification', 'fraudProtectionSnapshot', 'staffNotes', 'paymentEvents',
    'checkoutFingerprint', 'checkoutAttemptId', 'checkoutCartItems', 'cartCleanupStatus',
    'inventoryDeducted', 'inventoryDeductedAt', 'inventoryRestored', 'inventoryRestoredAt',
    'paymentProcessingToken', 'paymentProcessingAt']) delete order[key];
  order.orderItems = publicOrderLines(order.orderItems);
  return order;
}
module.exports = { publicProduct, publicOrderLines, publicSaleOrder };

