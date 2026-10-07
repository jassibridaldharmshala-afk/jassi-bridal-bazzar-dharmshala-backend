const crypto = require('crypto');
const InventoryTransaction = require('../models/InventoryTransaction');
const InventoryPurchaseOrder = require('../models/InventoryPurchaseOrder');
const Product = require('../models/Product');
const Order = require('../models/Order');
const ReturnExchange = require('../models/ReturnExchange');
const User = require('../models/User');
const { asyncHandler } = require('../middleware/validate');
const { andFilter } = require('../services/storeService');
const { roleAllows } = require('../models/StoreMember');
const { logAudit } = require('../services/auditService');
const { runInTransaction } = require('../utils/transaction');
const { ApiError } = require('../utils/apiError');
const {
  buildPaginatedResponse, optionalEmail, optionalString, readPagination,
  requireArray, requireEnum, requireObjectId, requireString,
} = require('../utils/validators');
const {
  ADJUSTMENT_MODES, ADJUSTMENT_REASONS, INVENTORY_BUCKETS, applyInventoryAdjustment,
} = require('../services/inventoryService');

const TYPES = InventoryTransaction.INVENTORY_TRANSACTION_TYPES;
const PURCHASE_ORDER_STATUSES = ['DRAFT', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'];
const REVERSIBLE_TYPES = ['MANUAL_ADJUSTMENT', 'RESTOCK', 'IMPORT', 'DAMAGE', 'SHRINKAGE', 'SAMPLE'];
const OPEN_FULFILMENT_STATUSES = ['Pending', 'Confirmed', 'Packed'];
const OPEN_PURCHASE_STATUSES = ['ORDERED', 'PARTIALLY_RECEIVED'];

function escapeRegex(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function scoped(req, filter = {}) {
  return andFilter(filter, req.tenantFilter || {});
}

function isPlatformInventoryAdmin(req) {
  return req.user?.role === 'admin' && !req.storeMember;
}

function capabilities(req) {
  const allow = (permission) => isPlatformInventoryAdmin(req) || roleAllows(req.storeMember?.role, permission);
  return {
    canRead: allow('inventory.read'), canAdjust: allow('inventory.write'),
    canBulkAdjust: allow('inventory.bulk'), canApprove: allow('inventory.approve'),
    canReceive: allow('inventory.receive'), canExport: allow('inventory.export'),
    canViewCost: allow('inventory.cost.read'), canManageCatalog: allow('catalog.write'),
  };
}

function activeVariantExpression() {
  return { $filter: { input: { $ifNull: ['$variants', []] }, as: 'variant', cond: { $ne: ['$$variant.isActive', false] } } };
}

function variantLowExpression({ outOnly = false } = {}) {
  const stock = { $ifNull: ['$$variant.stock', 0] };
  const threshold = { $ifNull: ['$$variant.lowStockAlert', { $ifNull: ['$lowStockAlert', 5] }] };
  return {
    $size: {
      $filter: {
        input: activeVariantExpression(), as: 'variant',
        cond: outOnly ? { $lte: [stock, 0] } : { $and: [{ $gt: [stock, 0] }, { $lte: [stock, threshold] }] },
      },
    },
  };
}

function inventoryComputationStages(status) {
  const threshold = { $ifNull: ['$lowStockAlert', 5] };
  const stages = [{ $addFields: {
    _variantLowCount: variantLowExpression(),
    _variantOutCount: variantLowExpression({ outOnly: true }),
    _managedVariantCount: { $size: activeVariantExpression() },
  } }];
  const filters = {
    attention: { isActive: true, $expr: { $or: [{ $lte: ['$stock', threshold] }, { $gt: ['$_variantLowCount', 0] }, { $gt: ['$_variantOutCount', 0] }] } },
    low: { $expr: { $and: [{ $gt: ['$stock', 0] }, { $or: [{ $lte: ['$stock', threshold] }, { $gt: ['$_variantLowCount', 0] }] }] } },
    out: { $expr: { $lte: ['$stock', 0] } },
    'variant-out': { $expr: { $and: [{ $gt: ['$stock', 0] }, { $gt: ['$_variantOutCount', 0] }] } },
    healthy: { isActive: true, $expr: { $and: [{ $gt: ['$stock', threshold] }, { $eq: ['$_variantLowCount', 0] }, { $eq: ['$_variantOutCount', 0] }] } },
    hidden: { isActive: false },
  };
  if (filters[status]) stages.push({ $match: filters[status] });
  return stages;
}

function statusFor(product) {
  if (product.isActive === false) return 'HIDDEN';
  if (Number(product.stock || 0) <= 0) return 'SOLD_OUT';
  if (Number(product._variantOutCount || 0) > 0) return 'VARIANT_OUT';
  if (Number(product.stock || 0) <= Number(product.lowStockAlert ?? 5) || Number(product._variantLowCount || 0) > 0) return 'LOW';
  return 'HEALTHY';
}

function selectionKey(productId, variantId = '') {
  return `${String(productId)}::${String(variantId || '')}`;
}

async function stockCommitments(req, productIds) {
  if (!productIds.length) return new Map();
  const [orders, exchanges] = await Promise.all([
    Order.aggregate([
      { $match: scoped(req, { inventoryDeducted: true, inventoryRestored: { $ne: true }, orderStatus: { $in: OPEN_FULFILMENT_STATUSES }, 'orderItems.product': { $in: productIds } }) },
      { $unwind: '$orderItems' }, { $match: { 'orderItems.product': { $in: productIds } } },
      { $group: { _id: { product: '$orderItems.product', variantId: { $ifNull: ['$orderItems.variantId', ''] } }, quantity: { $sum: { $ifNull: ['$orderItems.quantity', 1] } } } },
    ]),
    ReturnExchange.aggregate([
      { $match: scoped(req, { type: 'exchange', product: { $in: productIds }, exchangeDeducted: true, exchangeReservationReleased: { $ne: true }, active: { $ne: false } }) },
      { $group: { _id: { product: '$product', variantId: { $ifNull: ['$exchangeVariantId', ''] } }, quantity: { $sum: { $ifNull: ['$quantity', 1] } } } },
    ]),
  ]);
  const result = new Map();
  [...orders, ...exchanges].forEach((row) => {
    const key = selectionKey(row._id.product, row._id.variantId);
    result.set(key, Number(result.get(key) || 0) + Number(row.quantity || 0));
  });
  return result;
}

async function incomingStock(req, productIds) {
  if (!productIds.length) return new Map();
  const rows = await InventoryPurchaseOrder.aggregate([
    { $match: scoped(req, { status: { $in: OPEN_PURCHASE_STATUSES }, 'items.product': { $in: productIds } }) },
    { $unwind: '$items' }, { $match: { 'items.product': { $in: productIds } } },
    { $project: { product: '$items.product', variantId: '$items.variantId', remaining: { $max: [0, { $subtract: ['$items.orderedQuantity', { $add: ['$items.receivedQuantity', '$items.damagedQuantity'] }] }] } } },
    { $group: { _id: { product: '$product', variantId: { $ifNull: ['$variantId', ''] } }, quantity: { $sum: '$remaining' } } },
  ]);
  return new Map(rows.map((row) => [selectionKey(row._id.product, row._id.variantId), Number(row.quantity || 0)]));
}

function mapInventoryProduct(product, reserved, incoming, canViewCost) {
  const variants = (product.variants || []).map((variant) => {
    const key = selectionKey(product._id, variant._id);
    const available = Number(variant.stock || 0);
    const committed = reserved.get(key) || 0;
    const arriving = incoming.get(key) || 0;
    const threshold = Number(variant.lowStockAlert ?? product.lowStockAlert ?? 5);
    return {
      ...variant, available, reserved: committed, onHand: available + committed, incoming: arriving,
      damaged: Number(variant.nonSellableStock?.damaged || 0), quarantine: Number(variant.nonSellableStock?.quarantine || 0),
      status: available <= 0 ? 'SOLD_OUT' : available <= threshold ? 'LOW' : 'HEALTHY',
    };
  });
  const productReserved = variants.length ? variants.reduce((sum, variant) => sum + variant.reserved, 0) : reserved.get(selectionKey(product._id)) || 0;
  const productIncoming = variants.length ? variants.reduce((sum, variant) => sum + variant.incoming, 0) : incoming.get(selectionKey(product._id)) || 0;
  const damaged = variants.length ? variants.reduce((sum, variant) => sum + variant.damaged, 0) : Number(product.nonSellableStock?.damaged || 0);
  const quarantine = variants.length ? variants.reduce((sum, variant) => sum + variant.quarantine, 0) : Number(product.nonSellableStock?.quarantine || 0);
  return {
    ...product, ...(canViewCost ? {} : { costPrice: undefined }), variants,
    available: Number(product.stock || 0), reserved: productReserved,
    onHand: Number(product.stock || 0) + productReserved, incoming: productIncoming,
    damaged, quarantine, inventoryStatus: statusFor(product),
  };
}

exports.catalog = asyncHandler(async (req, res) => {
  const { page, limit, skip } = readPagination(req.query, { defaultLimit: 25, maxLimit: 100 });
  const match = scoped(req, { isArchived: { $ne: true } });
  const q = String(req.query.q || '').trim().slice(0, 100);
  if (q) {
    const regex = new RegExp(escapeRegex(q), 'i');
    const search = { $or: [{ name: regex }, { sku: regex }, { barcode: regex }, { supplierSku: regex }, { 'variants.sku': regex }] };
    if (match.$and) match.$and.unshift(search); else Object.assign(match, search);
  }
  const status = String(req.query.status || '').toLowerCase();
  const sortMap = {
    name: { name: 1, _id: 1 }, 'stock-low': { stock: 1, name: 1, _id: 1 },
    'stock-high': { stock: -1, name: 1, _id: 1 }, updated: { lastInventoryChangeAt: -1, updatedAt: -1, _id: -1 },
  };
  const pipeline = [
    { $match: match }, ...inventoryComputationStages(status), { $sort: sortMap[req.query.sort] || sortMap.updated },
    { $facet: {
      items: [
        { $skip: skip }, { $limit: limit },
        { $lookup: { from: 'categories', localField: 'category', foreignField: '_id', as: '_category' } },
        { $lookup: { from: 'users', let: { actorId: '$lastInventoryChangedBy' }, pipeline: [{ $match: { $expr: { $eq: ['$_id', '$$actorId'] } } }, { $project: { name: 1 } }], as: '_inventoryActor' } },
        { $addFields: { category: { $arrayElemAt: ['$_category', 0] }, lastInventoryChangedBy: { $arrayElemAt: ['$_inventoryActor', 0] } } },
        { $project: { _category: 0, _inventoryActor: 0, description: 0, shortDescription: 0, sizeChart: 0, videos: 0, specifications: 0, attributeValues: 0 } },
      ], count: [{ $count: 'total' }],
    } },
  ];
  const [result] = await Product.aggregate(pipeline);
  const items = result?.items || [];
  const productIds = items.map((item) => item._id);
  const [reserved, incoming] = await Promise.all([stockCommitments(req, productIds), incomingStock(req, productIds)]);
  const access = capabilities(req);
  res.set('Cache-Control', 'private, no-store, max-age=0');
  res.json({
    ...buildPaginatedResponse(items.map((item) => mapInventoryProduct(item, reserved, incoming, access.canViewCost)), { page, limit, total: result?.count?.[0]?.total || 0 }),
    capabilities: access,
  });
});

exports.summary = asyncHandler(async (req, res) => {
  const products = await Product.find(scoped(req, { isArchived: { $ne: true } })).select('stock variants lowStockAlert nonSellableStock price costPrice isActive createdAt lastInventoryChangeAt').lean();
  const ids = products.map((product) => product._id);
  const recentSince = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  const agedBefore = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const [reserved, incoming, recentSales] = await Promise.all([
    stockCommitments(req, ids), incomingStock(req, ids),
    ids.length ? InventoryTransaction.aggregate([
      { $match: scoped(req, { product: { $in: ids }, type: 'SALE', createdAt: { $gte: recentSince } }) },
      { $group: { _id: '$product', units: { $sum: { $abs: '$quantity' } } } },
    ]) : [],
  ]);
  const soldByProduct = new Map(recentSales.map((row) => [String(row._id), Number(row.units || 0)]));
  const result = { products: products.length, sellable: 0, reserved: 0, onHand: 0, incoming: 0, damaged: 0, quarantine: 0, lowProducts: 0, lowVariants: 0, soldOutProducts: 0, slowMovingProducts: 0, slowMovingUnits: 0, agedStockProducts: 0, agedStockUnits: 0, retailValue: 0, costValue: 0 };
  products.forEach((product) => {
    const mapped = mapInventoryProduct(product, reserved, incoming, true);
    result.sellable += mapped.available; result.reserved += mapped.reserved; result.onHand += mapped.onHand;
    result.incoming += mapped.incoming; result.damaged += mapped.damaged; result.quarantine += mapped.quarantine;
    result.retailValue += mapped.available * Number(product.price || 0); result.costValue += mapped.available * Number(product.costPrice || 0);
    if (mapped.inventoryStatus === 'SOLD_OUT') result.soldOutProducts += 1;
    if (['LOW', 'VARIANT_OUT'].includes(mapped.inventoryStatus)) result.lowProducts += 1;
    result.lowVariants += mapped.variants.filter((variant) => ['LOW', 'SOLD_OUT'].includes(variant.status)).length;
    if (mapped.available > 0 && !soldByProduct.get(String(product._id))) {
      result.slowMovingProducts += 1; result.slowMovingUnits += mapped.available;
    }
    const lastMovement = product.lastInventoryChangeAt || product.createdAt;
    if (mapped.available > 0 && lastMovement && new Date(lastMovement) <= agedBefore) {
      result.agedStockProducts += 1; result.agedStockUnits += mapped.available;
    }
  });
  res.set('Cache-Control', 'private, no-store, max-age=0');
  res.json({ ...result, capabilities: capabilities(req), generatedAt: new Date() });
});

exports.exportCatalog = asyncHandler(async (req, res) => {
  if (!capabilities(req).canExport) throw new ApiError('FORBIDDEN', 'You do not have permission to export inventory');
  const products = await Product.find(scoped(req, { isArchived: { $ne: true } }))
    .select('name sku stock variants lowStockAlert nonSellableStock inventoryLocation binLocation lastInventoryChangeAt updatedAt')
    .sort({ name: 1, _id: 1 }).limit(10000).lean();
  const ids = products.map((product) => product._id);
  const [reserved, incoming] = await Promise.all([stockCommitments(req, ids), incomingStock(req, ids)]);
  const items = [];
  products.forEach((product) => {
    const mapped = mapInventoryProduct(product, reserved, incoming, false);
    const selections = mapped.variants.length ? mapped.variants : [{
      sku: mapped.sku, available: mapped.available, reserved: mapped.reserved, incoming: mapped.incoming,
      damaged: mapped.damaged, quarantine: mapped.quarantine, lowStockAlert: mapped.lowStockAlert,
    }];
    selections.forEach((variant) => items.push([
      mapped.name,
      variant.sku || mapped.sku || '',
      mapped.variants.length ? [variant.size, variant.color].filter(Boolean).join(' / ') : '',
      variant.available, variant.reserved, variant.incoming, variant.damaged, variant.quarantine,
      variant.lowStockAlert ?? mapped.lowStockAlert ?? 5,
      [mapped.inventoryLocation || 'Main stockroom', mapped.binLocation].filter(Boolean).join(' / '),
      mapped.lastInventoryChangeAt || mapped.updatedAt || '',
    ]));
  });
  res.set('Cache-Control', 'private, no-store, max-age=0');
  res.json({ generatedAt: new Date(), truncated: products.length >= 10000, items });
});

exports.adjust = asyncHandler(async (req, res) => {
  const result = await applyInventoryAdjustment({
    productId: requireObjectId(req.body?.productId, 'product'), variantId: req.body?.variantId,
    mode: req.body?.mode, bucket: req.body?.bucket, quantity: req.body?.quantity,
    expectedStock: req.body?.expectedStock, expectedRevision: req.body?.expectedRevision,
    reasonCode: req.body?.reasonCode, reason: req.body?.reason,
    note: optionalString(req.body?.note, 'Note', { max: 500 }), reference: optionalString(req.body?.reference, 'Reference', { max: 120 }),
    idempotencyKey: optionalString(req.body?.idempotencyKey, 'Request key', { max: 120 }), tenantFilter: req.tenantFilter, userId: req.user?._id,
  });
  await logAudit({
    req, action: 'INVENTORY_ADJUSTMENT', entityType: 'Product', entityId: result.product._id, storeId: result.product.storeId,
    before: result.movement ? { stock: result.movement.stockBefore, bucket: result.movement.bucket } : {},
    after: result.movement ? { stock: result.movement.stockAfter, bucket: result.movement.bucket } : {},
    summary: result.duplicate ? 'Duplicate inventory request safely ignored' : result.movement?.reason,
  });
  res.json({ product: result.product, movement: result.movement, duplicate: result.duplicate });
});

exports.bulkAdjust = asyncHandler(async (req, res) => {
  const entries = requireArray(req.body?.items, 'Inventory items', { min: 1, max: 100 });
  const batchKey = optionalString(req.body?.idempotencyKey, 'Batch request key', { max: 80 }) || crypto.randomUUID();
  const common = {
    mode: requireEnum(String(req.body?.mode || '').toUpperCase(), ADJUSTMENT_MODES, 'Adjustment mode'),
    bucket: requireEnum(String(req.body?.bucket || 'SELLABLE').toUpperCase(), INVENTORY_BUCKETS, 'Inventory bucket'),
    reasonCode: requireEnum(String(req.body?.reasonCode || '').toUpperCase(), Object.keys(ADJUSTMENT_REASONS), 'Adjustment reason'),
    note: optionalString(req.body?.note, 'Note', { max: 500 }), reference: optionalString(req.body?.reference, 'Reference', { max: 120 }),
    tenantFilter: req.tenantFilter, userId: req.user?._id,
  };
  const results = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] || {};
    try {
      let productId = entry.productId;
      let selectedVariantId = entry.variantId;
      if (!productId && entry.sku) {
        const sku = String(entry.sku).trim();
        const product = await Product.findOne(scoped(req, { $or: [{ sku }, { barcode: sku }, { 'variants.sku': sku }] })).select('sku barcode variants');
        if (!product) throw new ApiError('NOT_FOUND', `No product found for SKU ${sku}`);
        productId = product._id;
        if (!selectedVariantId && product.sku !== sku && product.barcode !== sku) selectedVariantId = product.variants.find((variant) => variant.sku === sku)?._id;
      }
      const result = await applyInventoryAdjustment({
        ...common, productId: requireObjectId(productId, 'product'), variantId: selectedVariantId,
        quantity: entry.quantity, expectedStock: entry.expectedStock, idempotencyKey: `${batchKey}:${index}`,
      });
      results.push({ index, success: true, productId: String(result.product._id), movement: result.movement });
    } catch (error) {
      results.push({ index, success: false, code: error.errorCode || 'INVENTORY_UPDATE_FAILED', message: error.message });
    }
  }
  const updated = results.filter((item) => item.success).length;
  await logAudit({ req, action: 'INVENTORY_BULK_ADJUSTMENT', entityType: 'Inventory', entityId: batchKey, after: { requested: entries.length, updated, failed: entries.length - updated } });
  res.json({ batchKey, requested: entries.length, updated, failed: entries.length - updated, results });
});

exports.reverse = asyncHandler(async (req, res) => {
  const movementId = requireObjectId(req.params.id, 'inventory movement');
  const result = await runInTransaction(async (session) => {
    const movement = await InventoryTransaction.findOne(scoped(req, { _id: movementId })).session(session || null);
    if (!movement) throw new ApiError('NOT_FOUND', 'Inventory movement not found');
    if (!REVERSIBLE_TYPES.includes(movement.type) || movement.reversalOf) throw new ApiError('VALIDATION_ERROR', 'This system movement cannot be reversed here');
    if (movement.reversedBy) throw new ApiError('DUPLICATE_REQUEST', 'This inventory movement has already been reversed');
    const adjusted = await applyInventoryAdjustment({
      productId: movement.product, variantId: movement.variantId, mode: movement.quantity > 0 ? 'REMOVE' : 'ADD',
      bucket: movement.bucket || 'SELLABLE', quantity: Math.abs(Number(movement.quantity || 0)), reasonCode: 'REVERSAL',
      note: optionalString(req.body?.note, 'Reversal note', { max: 500 }) || `Reversal of ${movement.reason || movement.type}`,
      reference: movement.reference, idempotencyKey: `reversal:${movement._id}`, reversalOf: movement._id,
      tenantFilter: req.tenantFilter, userId: req.user?._id,
    }, session);
    if (adjusted.movement) {
      const claimed = await InventoryTransaction.updateOne({ _id: movement._id, reversedBy: { $exists: false } }, { $set: { reversedBy: adjusted.movement._id } }, { session });
      if (!claimed.modifiedCount) throw new ApiError('DUPLICATE_REQUEST', 'This inventory movement has already been reversed');
    }
    return adjusted;
  });
  await logAudit({ req, action: 'INVENTORY_ADJUSTMENT_REVERSED', entityType: 'InventoryTransaction', entityId: movementId, after: { reversalId: result.movement?._id } });
  res.json({ product: result.product, movement: result.movement });
});

exports.history = asyncHandler(async (req, res) => {
  const { page, limit, skip } = readPagination(req.query, { defaultLimit: 25, maxLimit: 100 });
  const filter = {};
  if (req.query.product) filter.product = requireObjectId(req.query.product, 'product id');
  if (req.query.type) filter.type = requireEnum(req.query.type, TYPES, 'inventory movement');
  if (req.query.bucket) filter.bucket = requireEnum(String(req.query.bucket).toUpperCase(), INVENTORY_BUCKETS, 'inventory bucket');
  if (req.query.reasonCode) filter.reasonCode = String(req.query.reasonCode).trim().toUpperCase();
  if (req.query.from || req.query.to) {
    const from = req.query.from ? new Date(req.query.from) : new Date(0);
    const to = req.query.to ? new Date(req.query.to) : new Date();
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from > to) throw new ApiError('VALIDATION_ERROR', 'Choose a valid inventory history date range');
    to.setHours(23, 59, 59, 999); filter.createdAt = { $gte: from, $lte: to };
  }
  const q = String(req.query.q || '').trim().slice(0, 100);
  if (q) {
    const regex = new RegExp(escapeRegex(q), 'i');
    const [products, users] = await Promise.all([
      Product.find(scoped(req, { $or: [{ name: regex }, { sku: regex }, { 'variants.sku': regex }] })).select('_id').limit(100).lean(),
      User.find({ name: regex }).select('_id').limit(50).lean(),
    ]);
    filter.$or = [{ product: { $in: products.map((item) => item._id) } }, { 'productSnapshot.name': regex }, { createdBy: { $in: users.map((item) => item._id) } }, { sku: regex }, { reason: regex }, { note: regex }, { reference: regex }];
  }
  const movementFilter = scoped(req, filter);
  const [items, total] = await Promise.all([
    InventoryTransaction.find(movementFilter).populate('product', 'name sku images').populate('createdBy', 'name').populate('order', 'invoiceNumber orderStatus').sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    InventoryTransaction.countDocuments(movementFilter),
  ]);
  res.set('Cache-Control', 'private, no-store, max-age=0');
  res.json({
    ...buildPaginatedResponse(items.map((item) => ({ ...item, product: item.product || (item.productSnapshot?.deletedAt ? { ...item.productSnapshot, deleted: true } : null), reversible: Boolean(item.product) && REVERSIBLE_TYPES.includes(item.type) && !item.reversalOf && !item.reversedBy })), { page, limit, total }),
    types: TYPES, reasons: Object.entries(ADJUSTMENT_REASONS).map(([value, item]) => ({ value, label: item.label })),
  });
});

function purchaseOrderNumber() {
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  return `PO-${date}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function purchaseOrderResponse(order) {
  const item = typeof order.toObject === 'function' ? order.toObject() : order;
  const totals = (item.items || []).reduce((sum, row) => ({
    ordered: sum.ordered + Number(row.orderedQuantity || 0), received: sum.received + Number(row.receivedQuantity || 0),
    damaged: sum.damaged + Number(row.damagedQuantity || 0), cost: sum.cost + (Number(row.orderedQuantity || 0) * Number(row.unitCost || 0)),
  }), { ordered: 0, received: 0, damaged: 0, cost: 0 });
  return { ...item, totals, remaining: Math.max(0, totals.ordered - totals.received - totals.damaged) };
}

exports.listPurchaseOrders = asyncHandler(async (req, res) => {
  const { page, limit, skip } = readPagination(req.query, { defaultLimit: 20, maxLimit: 100 });
  const filter = {};
  if (req.query.status) filter.status = requireEnum(String(req.query.status).toUpperCase(), PURCHASE_ORDER_STATUSES, 'purchase order status');
  const q = String(req.query.q || '').trim().slice(0, 100);
  if (q) { const regex = new RegExp(escapeRegex(q), 'i'); filter.$or = [{ number: regex }, { 'supplier.name': regex }, { 'items.productName': regex }, { 'items.sku': regex }]; }
  const query = scoped(req, filter);
  const [items, total] = await Promise.all([
    InventoryPurchaseOrder.find(query).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(), InventoryPurchaseOrder.countDocuments(query),
  ]);
  res.json(buildPaginatedResponse(items.map(purchaseOrderResponse), { page, limit, total }));
});

exports.createPurchaseOrder = asyncHandler(async (req, res) => {
  const supplier = req.body?.supplier || {};
  const itemInputs = requireArray(req.body?.items, 'Purchase items', { min: 1, max: 100 });
  const items = [];
  let storeId = req.store?._id;
  for (const input of itemInputs) {
    const product = await Product.findOne(scoped(req, { _id: requireObjectId(input.productId, 'product'), isArchived: { $ne: true } })).select('name sku variants storeId costPrice');
    if (!product) throw new ApiError('NOT_FOUND', 'A selected purchase product was not found');
    if (!storeId) storeId = product.storeId;
    if (String(storeId || '') !== String(product.storeId || '')) throw new ApiError('VALIDATION_ERROR', 'All purchase items must belong to the same store');
    const selectedVariant = input.variantId ? product.variants.id(requireObjectId(input.variantId, 'variant')) : null;
    if (input.variantId && !selectedVariant) throw new ApiError('NOT_FOUND', 'A selected product variant was not found');
    if (!input.variantId && product.variants?.length) throw new ApiError('VARIANT_UNAVAILABLE', `${product.name} requires a size or colour variant`);
    const orderedQuantity = Number(input.quantity); const unitCost = Number(input.unitCost ?? product.costPrice ?? 0);
    if (!Number.isSafeInteger(orderedQuantity) || orderedQuantity < 1 || orderedQuantity > 1000000) throw new ApiError('VALIDATION_ERROR', 'Purchase quantity must be a whole number between 1 and 1000000');
    if (!Number.isFinite(unitCost) || unitCost < 0 || unitCost > 100000000) throw new ApiError('VALIDATION_ERROR', 'Unit cost is invalid');
    items.push({ product: product._id, variantId: selectedVariant?._id ? String(selectedVariant._id) : '', productName: product.name, sku: selectedVariant?.sku || product.sku || '', orderedQuantity, unitCost });
  }
  const expectedAt = req.body?.expectedAt ? new Date(req.body.expectedAt) : undefined;
  if (expectedAt && !Number.isFinite(expectedAt.getTime())) throw new ApiError('VALIDATION_ERROR', 'Choose a valid expected arrival date');
  const purchaseData = {
    storeId, number: purchaseOrderNumber(), supplier: {
      name: requireString(supplier.name, 'Supplier name', { max: 160 }), phone: optionalString(supplier.phone, 'Supplier phone', { max: 30 }), email: optionalEmail(supplier.email, 'Supplier email'),
    }, expectedAt, notes: optionalString(req.body?.notes, 'Purchase notes', { max: 1000 }), items, createdBy: req.user?._id,
  };
  const created = await runInTransaction(async session => {
    // A new purchase and permanent deletion must contend on the product, not
    // just independently read it and create an orphan financial reference.
    const ids = [...new Set(items.map(item => String(item.product)))];
    const touched = await Product.updateMany(scoped(req, { _id: { $in: ids }, isArchived: { $ne: true } }),
      { $inc: { catalogReferenceRevision: 1 } }, { session: session || undefined });
    if (touched.matchedCount !== ids.length) throw new ApiError('NOT_FOUND', 'A selected purchase product was archived or removed. Refresh before creating the purchase order.');
    return session ? (await InventoryPurchaseOrder.create([purchaseData], { session }))[0] : InventoryPurchaseOrder.create(purchaseData);
  });
  await logAudit({ req, action: 'PURCHASE_ORDER_CREATED', entityType: 'InventoryPurchaseOrder', entityId: created._id, storeId, after: { number: created.number, supplier: created.supplier.name, itemCount: items.length } });
  res.status(201).json(purchaseOrderResponse(created));
});

exports.receivePurchaseOrder = asyncHandler(async (req, res) => {
  const orderId = requireObjectId(req.params.id, 'purchase order');
  const receipts = requireArray(req.body?.items, 'Received items', { min: 1, max: 100 });
  const expectedRevision = Number(req.body?.revision);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new ApiError('VALIDATION_ERROR', 'Purchase order revision is required');
  const operation = crypto.randomUUID();
  const claimed = await InventoryPurchaseOrder.findOneAndUpdate(
    scoped(req, {
      _id: orderId, revision: expectedRevision, status: { $in: OPEN_PURCHASE_STATUSES },
      $or: [{ receivingOperation: { $in: ['', null] } }, { receivingOperation: { $exists: false } }, { receivingOperationUntil: { $lte: new Date() } }],
    }),
    { $set: { receivingOperation: operation, receivingOperationUntil: new Date(Date.now() + 2 * 60 * 1000) } },
    { new: true },
  ).select('+receivingOperation +receivingOperationUntil');
  if (!claimed) throw new ApiError('PURCHASE_ORDER_CHANGED', 'This purchase order changed or is already being received. Refresh and try again.');
  let updated;
  try {
    updated = await runInTransaction(async (session) => {
      const order = await InventoryPurchaseOrder.findOne({ _id: orderId, receivingOperation: operation }).select('+receivingOperation').session(session || null);
      if (!order) throw new ApiError('PURCHASE_ORDER_CHANGED', 'The receiving lock expired. Refresh and try again.');
    for (let index = 0; index < receipts.length; index += 1) {
      const receipt = receipts[index] || {}; const line = order.items.id(requireObjectId(receipt.itemId, 'purchase item'));
      if (!line) throw new ApiError('NOT_FOUND', 'A purchase order item was not found');
      const received = Number(receipt.quantity || 0); const damaged = Number(receipt.damagedQuantity || 0);
      if (!Number.isSafeInteger(received) || received < 0 || !Number.isSafeInteger(damaged) || damaged < 0 || received + damaged < 1) throw new ApiError('VALIDATION_ERROR', 'Enter a whole received or damaged quantity');
      const remaining = Number(line.orderedQuantity) - Number(line.receivedQuantity || 0) - Number(line.damagedQuantity || 0);
      if (received + damaged > remaining) throw new ApiError('VALIDATION_ERROR', `Only ${remaining} units remain on ${line.productName}`);
      const note = optionalString(req.body?.note, 'Receiving note', { max: 500 });
      if (received) await applyInventoryAdjustment({
        productId: line.product, variantId: line.variantId, mode: 'ADD', bucket: 'SELLABLE', quantity: received,
        reasonCode: 'PURCHASE_RECEIPT', reference: order.number, note, idempotencyKey: `${order._id}:${order.revision}:${line._id}:sellable`,
        purchaseOrder: order._id, unitCost: line.unitCost, tenantFilter: req.tenantFilter, userId: req.user?._id,
      }, session);
      if (damaged) await applyInventoryAdjustment({
        productId: line.product, variantId: line.variantId, mode: 'ADD', bucket: 'DAMAGED', quantity: damaged,
        reasonCode: 'DAMAGED', reference: order.number, note, idempotencyKey: `${order._id}:${order.revision}:${line._id}:damaged`,
        purchaseOrder: order._id, unitCost: line.unitCost, tenantFilter: req.tenantFilter, userId: req.user?._id,
      }, session);
      line.receivedQuantity += received; line.damagedQuantity += damaged;
    }
    const complete = order.items.every((item) => Number(item.receivedQuantity || 0) + Number(item.damagedQuantity || 0) >= Number(item.orderedQuantity));
    const anyReceived = order.items.some((item) => Number(item.receivedQuantity || 0) + Number(item.damagedQuantity || 0) > 0);
      const saved = await InventoryPurchaseOrder.findOneAndUpdate(
      { _id: order._id, revision: expectedRevision, receivingOperation: operation },
      { $set: { items: order.items, status: complete ? 'RECEIVED' : anyReceived ? 'PARTIALLY_RECEIVED' : 'ORDERED', ...(complete ? { receivedAt: new Date() } : {}), updatedBy: req.user?._id }, $unset: { receivingOperation: 1, receivingOperationUntil: 1 }, $inc: { revision: 1 } },
      { new: true, session, runValidators: true },
    );
    if (!saved) throw new ApiError('PURCHASE_ORDER_CHANGED', 'This purchase order changed while stock was being received. Refresh and try again.');
    return saved;
    });
  } catch (error) {
    await InventoryPurchaseOrder.updateOne({ _id: orderId, receivingOperation: operation }, { $unset: { receivingOperation: 1, receivingOperationUntil: 1 } }).catch(() => null);
    throw error;
  }
  await logAudit({ req, action: 'PURCHASE_ORDER_RECEIVED', entityType: 'InventoryPurchaseOrder', entityId: updated._id, storeId: updated.storeId, after: { number: updated.number, status: updated.status, revision: updated.revision } });
  res.json(purchaseOrderResponse(updated));
});

exports.cancelPurchaseOrder = asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id, 'purchase order'); const revision = Number(req.body?.revision);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new ApiError('VALIDATION_ERROR', 'Purchase order revision is required');
  const order = await InventoryPurchaseOrder.findOneAndUpdate(
    scoped(req, { _id: id, revision, status: { $in: OPEN_PURCHASE_STATUSES } }),
    { $set: { status: 'CANCELLED', cancelledAt: new Date(), updatedBy: req.user?._id }, $inc: { revision: 1 } }, { new: true },
  );
  if (!order) throw new ApiError('PURCHASE_ORDER_CHANGED', 'Purchase order could not be cancelled. Refresh its latest status.');
  await logAudit({ req, action: 'PURCHASE_ORDER_CANCELLED', entityType: 'InventoryPurchaseOrder', entityId: order._id, storeId: order.storeId, after: { number: order.number, status: order.status } });
  res.json(purchaseOrderResponse(order));
});

exports.TYPES = TYPES;
exports.ADJUSTMENT_REASONS = ADJUSTMENT_REASONS;
