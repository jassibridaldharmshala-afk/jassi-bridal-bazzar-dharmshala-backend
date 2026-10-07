const mongoose = require('mongoose');
const Product = require('../models/Product');
const InventoryTransaction = require('../models/InventoryTransaction');
const { ApiError } = require('../utils/apiError');
const { hasManagedVariants, totalVariantStock, variantId } = require('./variantService');
const { andFilter } = require('./storeService');
const { runInTransaction } = require('../utils/transaction');

const ADJUSTMENT_MODES = ['SET', 'ADD', 'REMOVE'];
const INVENTORY_BUCKETS = ['SELLABLE', 'DAMAGED', 'QUARANTINE'];
const ADJUSTMENT_REASONS = {
  PURCHASE_RECEIPT: { label: 'Supplier stock received', type: 'PURCHASE_RECEIPT' },
  STOCK_COUNT: { label: 'Physical stock count', type: 'MANUAL_ADJUSTMENT' },
  CORRECTION: { label: 'Inventory correction', type: 'MANUAL_ADJUSTMENT' },
  CUSTOMER_RETURN: { label: 'Customer return', type: 'RETURN' },
  DAMAGED: { label: 'Damaged stock', type: 'DAMAGE' },
  LOST: { label: 'Lost or missing stock', type: 'SHRINKAGE' },
  SAMPLE: { label: 'Sample or internal use', type: 'SAMPLE' },
  IMPORT: { label: 'Inventory import', type: 'IMPORT' },
  REVERSAL: { label: 'Reversed inventory adjustment', type: 'REVERSAL' },
};

function safeInteger(value, field, { min = 0, max = 10000000 } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new ApiError('VALIDATION_ERROR', `${field} must be a whole number between ${min} and ${max}`);
  }
  return number;
}

function selectedVariant(product, selectedId) {
  if (!selectedId) return null;
  return (product.variants || []).find((variant) => String(variant._id) === String(selectedId)) || null;
}

function bucketPath(bucket, selectedId) {
  if (bucket === 'SELLABLE') return selectedId ? 'variants.$.stock' : 'stock';
  const key = bucket === 'DAMAGED' ? 'damaged' : 'quarantine';
  return selectedId ? `variants.$.nonSellableStock.${key}` : `nonSellableStock.${key}`;
}

function bucketValue(product, bucket, selectedId) {
  const variant = selectedVariant(product, selectedId);
  const source = variant || product;
  if (bucket === 'SELLABLE') return Number(source?.stock || 0);
  const key = bucket === 'DAMAGED' ? 'damaged' : 'quarantine';
  return Number(source?.nonSellableStock?.[key] || 0);
}

function adjustmentAfter(before, mode, quantity) {
  if (mode === 'SET') return quantity;
  return mode === 'ADD' ? before + quantity : before - quantity;
}

function inventoryStamp(userId) {
  return { lastInventoryChangeAt: new Date(), ...(userId ? { lastInventoryChangedBy: userId } : {}) };
}

function movementReason(reasonCode, reason) {
  return String(reason || ADJUSTMENT_REASONS[reasonCode]?.label || 'Inventory adjustment').trim().slice(0, 200);
}

async function recordOpeningInventory(product, { userId, reference = '', reason = 'Opening inventory' } = {}, session = null) {
  const selections = hasManagedVariants(product)
    ? (product.variants || []).filter((variant) => variant.isActive !== false).map((variant) => ({
      variantId: String(variant._id), sku: variant.sku || product.sku || '', quantity: Number(variant.stock || 0),
    }))
    : [{ variantId: '', sku: product.sku || '', quantity: Number(product.stock || 0) }];
  const movements = selections.filter((selection) => selection.quantity > 0).map((selection) => ({
    storeId: product.storeId,
    product: product._id,
    variantId: selection.variantId,
    sku: selection.sku,
    type: 'IMPORT',
    mode: 'SET',
    bucket: 'SELLABLE',
    quantity: selection.quantity,
    stockBefore: 0,
    stockAfter: selection.quantity,
    reasonCode: 'IMPORT',
    reason,
    reference: String(reference || '').trim().slice(0, 120),
    idempotencyKey: `opening:${product._id}:${selection.variantId || 'product'}`,
    createdBy: userId,
  }));
  if (!movements.length) return [];
  await InventoryTransaction.bulkWrite(movements.map((movement) => ({
    updateOne: {
      filter: { storeId: movement.storeId, idempotencyKey: movement.idempotencyKey },
      update: { $setOnInsert: movement },
      upsert: true,
    },
  })), { session: session || undefined, ordered: false });
  return movements;
}

// Products created before inventory revisions were introduced do not have the
// field stored in MongoDB. Treat that legacy state as revision zero while still
// using a compare-and-swap update, so the first inventory change is safe too.
function withInventoryRevision(query, revision) {
  if (Number(revision) === 0) {
    return {
      $and: [
        query,
        { $or: [{ inventoryRevision: 0 }, { inventoryRevision: { $exists: false } }] },
      ],
    };
  }
  return { ...query, inventoryRevision: revision };
}

async function applyInventoryAdjustment(input, externalSession = undefined) {
  const work = async (session) => {
    const mode = String(input.mode || 'SET').toUpperCase();
    const bucket = String(input.bucket || 'SELLABLE').toUpperCase();
    const reasonCode = String(input.reasonCode || '').toUpperCase();
    if (!ADJUSTMENT_MODES.includes(mode)) throw new ApiError('VALIDATION_ERROR', 'Choose Set, Add or Remove stock');
    if (!INVENTORY_BUCKETS.includes(bucket)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid inventory bucket');
    if (!ADJUSTMENT_REASONS[reasonCode]) throw new ApiError('VALIDATION_ERROR', 'Choose a reason for this inventory change');
    const quantity = safeInteger(input.quantity, 'Quantity');
    if (mode !== 'SET' && quantity === 0) throw new ApiError('VALIDATION_ERROR', 'Quantity must be greater than zero');

    const product = await Product.findOne(andFilter({ _id: input.productId }, input.tenantFilter || {}))
      .select('name sku storeId stock variants inventoryRevision nonSellableStock lowStockAlert')
      .session(session || null);
    if (!product) throw new ApiError('NOT_FOUND', 'Product not found');

    const selectedId = String(input.variantId || '');
    if (selectedId && !mongoose.Types.ObjectId.isValid(selectedId)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid product variant');
    if (selectedId && !selectedVariant(product, selectedId)) throw new ApiError('NOT_FOUND', 'Product variant not found');
    if (!selectedId && bucket === 'SELLABLE' && hasManagedVariants(product)) {
      throw new ApiError('VARIANT_UNAVAILABLE', 'Choose a size or colour variant before changing sellable stock');
    }

    const idempotencyKey = String(input.idempotencyKey || '').trim().slice(0, 120);
    if (idempotencyKey) {
      const duplicate = await InventoryTransaction.findOne({
        storeId: product.storeId,
        idempotencyKey,
      }).session(session || null);
      if (duplicate) return { product, movement: duplicate, duplicate: true };
    }

    const before = bucketValue(product, bucket, selectedId);
    const expectedStock = input.expectedStock === undefined || input.expectedStock === null || input.expectedStock === ''
      ? null : safeInteger(input.expectedStock, 'Expected stock');
    const expectedRevision = input.expectedRevision === undefined || input.expectedRevision === null || input.expectedRevision === ''
      ? null : safeInteger(input.expectedRevision, 'Inventory revision');
    if ((expectedStock !== null && expectedStock !== before)
      || (expectedRevision !== null && expectedRevision !== Number(product.inventoryRevision || 0))) {
      throw new ApiError('INVENTORY_CHANGED', 'Stock changed in another order or staff session. Review the latest quantity and try again.', {
        details: { currentStock: before, currentRevision: Number(product.inventoryRevision || 0) },
      });
    }

    const after = adjustmentAfter(before, mode, quantity);
    if (after < 0) throw new ApiError('OUT_OF_STOCK', `Only ${before} units are available in this stock bucket`);
    if (after === before) return { product, movement: null, duplicate: false };

    const delta = after - before;
    const currentRevision = Number(product.inventoryRevision || 0);
    const path = bucketPath(bucket, selectedId);
    let guarded = withInventoryRevision({ _id: product._id }, currentRevision);
    if (selectedId) {
      const variantMatch = { _id: selectedId };
      if (bucket === 'SELLABLE') variantMatch.stock = before;
      guarded = { $and: [guarded, { variants: { $elemMatch: variantMatch } }] };
    } else if (bucket === 'SELLABLE') guarded = { $and: [guarded, { [path]: before }] };
    const filter = andFilter(guarded, input.tenantFilter || {});

    const set = { [path]: after, ...inventoryStamp(input.userId) };
    if (selectedId && bucket === 'SELLABLE') set.stock = Math.max(0, Number(product.stock || 0) + delta);
    const updated = await Product.findOneAndUpdate(
      filter,
      { $set: set, $inc: { inventoryRevision: 1 } },
      { new: true, session, runValidators: true },
    ).select('name sku storeId stock variants inventoryRevision nonSellableStock lowStockAlert lastInventoryChangeAt lastInventoryChangedBy');
    if (!updated) {
      throw new ApiError('INVENTORY_CHANGED', 'Stock changed while this adjustment was being saved. Refresh and try again.');
    }

    const movementDocument = {
      storeId: product.storeId,
      product: product._id,
      variantId: selectedId,
      sku: selectedVariant(product, selectedId)?.sku || product.sku,
      type: ADJUSTMENT_REASONS[reasonCode].type,
      mode,
      bucket,
      quantity: delta,
      stockBefore: before,
      stockAfter: after,
      reasonCode,
      reason: movementReason(reasonCode, input.reason),
      note: String(input.note || '').trim().slice(0, 500),
      reference: String(input.reference || '').trim().slice(0, 120),
      idempotencyKey: idempotencyKey || undefined,
      reversalOf: input.reversalOf || undefined,
      purchaseOrder: input.purchaseOrder || undefined,
      unitCost: input.unitCost === undefined ? undefined : Math.max(0, Number(input.unitCost) || 0),
      createdBy: input.userId,
    };

    let movement;
    try {
      [movement] = await InventoryTransaction.create([movementDocument], session ? { session } : {});
    } catch (error) {
      if (!session) {
        const restoreSet = { [path]: before };
        if (selectedId && bucket === 'SELLABLE') restoreSet.stock = Number(product.stock || 0);
        const compensationFilter = { _id: product._id, inventoryRevision: currentRevision + 1 };
        if (selectedId) compensationFilter.variants = { $elemMatch: { _id: selectedId, ...(bucket === 'SELLABLE' ? { stock: after } : {}) } };
        else if (bucket === 'SELLABLE') compensationFilter[path] = after;
        await Product.updateOne(
          compensationFilter,
          { $set: restoreSet, $inc: { inventoryRevision: -1 } },
        ).catch(() => null);
      }
      throw error;
    }
    if (bucket === 'SELLABLE') notifyStockAttentionLater([{ productId: product._id, variantId: selectedId }]);
    return { product: updated, movement, duplicate: false };
  };

  return externalSession === undefined ? runInTransaction(work) : work(externalSession);
}

async function markProductOutOfStock(input) {
  return runInTransaction(async (session) => {
    const product = await Product.findOne(andFilter({ _id: input.productId }, input.tenantFilter || {}))
      .select('name sku storeId stock variants inventoryRevision')
      .session(session || null);
    if (!product) throw new ApiError('NOT_FOUND', 'Product not found');
    const currentRevision = Number(product.inventoryRevision || 0);
    if (input.expectedRevision !== undefined && input.expectedRevision !== null
      && safeInteger(input.expectedRevision, 'Inventory revision') !== currentRevision) {
      throw new ApiError('INVENTORY_CHANGED', 'Stock changed in another order or staff session. Review the latest quantity and try again.');
    }
    const hasVariants = hasManagedVariants(product);
    const beforeStock = Number(product.stock || 0);
    const beforeVariants = (product.variants || []).map((variant) => ({ _id: variant._id, stock: Number(variant.stock || 0) }));
    const movements = hasVariants
      ? product.variants.filter((variant) => Number(variant.stock || 0) > 0).map((variant) => ({
        storeId: product.storeId, product: product._id, variantId: String(variant._id), sku: variant.sku || product.sku,
        type: 'MANUAL_ADJUSTMENT', mode: 'SET', bucket: 'SELLABLE', quantity: -Number(variant.stock || 0),
        stockBefore: Number(variant.stock || 0), stockAfter: 0, reasonCode: input.reasonCode || 'CORRECTION',
        reason: movementReason(input.reasonCode || 'CORRECTION', input.reason || 'Marked out of stock'),
        note: String(input.note || '').trim().slice(0, 500), reference: String(input.reference || '').trim().slice(0, 120),
        idempotencyKey: input.idempotencyKey ? `${String(input.idempotencyKey).slice(0, 100)}:${variant._id}` : undefined,
        createdBy: input.userId,
      }))
      : beforeStock > 0 ? [{
        storeId: product.storeId, product: product._id, sku: product.sku,
        type: 'MANUAL_ADJUSTMENT', mode: 'SET', bucket: 'SELLABLE', quantity: -beforeStock,
        stockBefore: beforeStock, stockAfter: 0, reasonCode: input.reasonCode || 'CORRECTION',
        reason: movementReason(input.reasonCode || 'CORRECTION', input.reason || 'Marked out of stock'),
        note: String(input.note || '').trim().slice(0, 500), reference: String(input.reference || '').trim().slice(0, 120),
        idempotencyKey: input.idempotencyKey ? String(input.idempotencyKey).slice(0, 120) : undefined,
        createdBy: input.userId,
      }] : [];
    if (!movements.length) return { product, movements: [] };
    const nextVariants = hasVariants ? product.variants.map((variant) => ({ ...variant.toObject(), stock: 0 })) : product.variants;
    const updated = await Product.findOneAndUpdate(
      andFilter(withInventoryRevision({ _id: product._id }, currentRevision), input.tenantFilter || {}),
      { $set: { stock: 0, ...(hasVariants ? { variants: nextVariants } : {}), ...inventoryStamp(input.userId) }, $inc: { inventoryRevision: 1 } },
      { new: true, session, runValidators: true },
    );
    if (!updated) throw new ApiError('INVENTORY_CHANGED', 'Stock changed while this action was being saved. Refresh and try again.');
    try {
      const saved = await InventoryTransaction.insertMany(movements, session ? { session } : {});
      notifyStockAttentionLater(movements.map((movement) => ({ productId: product._id, variantId: movement.variantId })));
      return { product: updated, movements: saved };
    } catch (error) {
      if (!session) {
        await Product.updateOne(
          { _id: product._id, inventoryRevision: currentRevision + 1, stock: 0 },
          { $set: { stock: beforeStock, ...(hasVariants ? { variants: product.variants } : {}) }, $inc: { inventoryRevision: -1 } },
        ).catch(() => null);
      }
      throw error;
    }
  });
}

function itemQuantity(item) {
  return Math.max(1, Number(item.quantity || 1));
}

function itemProductId(item) {
  return item.product?._id || item.product || item.productId;
}

function itemVariantId(item) {
  return item.variantId ? String(item.variantId) : '';
}

function stockAfterFromProduct(product, selection = {}) {
  if (!hasManagedVariants(product)) return Number(product?.stock || 0);
  const match = (product.variants || []).find((variant) => String(variant._id) === String(selection.variantId || ''));
  return Number(match?.stock || 0);
}

async function deductVariant(productId, variantObjectId, quantity, session, { allowShortfall = false, userId } = {}) {
  const updated = await Product.findOneAndUpdate(
    {
      _id: productId,
      variants: { $elemMatch: { _id: variantObjectId, isActive: { $ne: false }, stock: { $gte: quantity } } },
    },
    { $inc: { 'variants.$.stock': -quantity, stock: -quantity, inventoryRevision: 1 }, $set: inventoryStamp(userId) },
    { new: true, session },
  ).select('name stock sku variants');

  if (updated) {
    return {
      productId,
      quantity,
      stockAfter: stockAfterFromProduct(updated, { variantId: variantObjectId }),
      sku: updated.sku,
      shortfall: 0,
      variantId: String(variantObjectId),
    };
  }

  const product = await Product.findById(productId).select('name stock sku variants').session(session || null);
  const current = stockAfterFromProduct(product, { variantId: variantObjectId });
  const available = Math.max(0, current);

  if (!allowShortfall) {
    throw new ApiError(
      'OUT_OF_STOCK',
      product
        ? `${product.name} has only ${available} left for that size and colour`
        : 'That size and colour is no longer available',
      { details: { productId: String(productId), variantId: String(variantObjectId), available } },
    );
  }

  if (!product || available <= 0) {
    return { productId, quantity: 0, stockAfter: 0, shortfall: quantity, variantId: String(variantObjectId), sku: product?.sku };
  }

  const taken = Math.min(quantity, available);
  const clamped = await Product.findOneAndUpdate(
    {
      _id: productId,
      variants: { $elemMatch: { _id: variantObjectId, stock: { $gte: taken } } },
    },
    { $inc: { 'variants.$.stock': -taken, stock: -taken, inventoryRevision: 1 }, $set: inventoryStamp(userId) },
    { new: true, session },
  ).select('stock sku variants');

  return {
    productId,
    quantity: taken,
    stockAfter: stockAfterFromProduct(clamped || product, { variantId: variantObjectId }),
    sku: product.sku,
    shortfall: quantity - taken,
    variantId: String(variantObjectId),
  };
}

async function deductProductLevel(productId, quantity, session, { allowShortfall = false, userId } = {}) {
  const updated = await Product.findOneAndUpdate(
    { _id: productId, stock: { $gte: quantity } },
    { $inc: { stock: -quantity, inventoryRevision: 1 }, $set: inventoryStamp(userId) },
    { new: true, session },
  ).select('name stock sku');

  if (updated) {
    return { productId, quantity, stockAfter: updated.stock, sku: updated.sku, shortfall: 0 };
  }

  const product = await Product.findById(productId).select('name stock sku').session(session || null);
  const available = Math.max(0, Number(product?.stock || 0));

  if (!allowShortfall) {
    throw new ApiError(
      'OUT_OF_STOCK',
      product
        ? `${product.name} has only ${available} left in stock`
        : 'A product is no longer available',
      { details: { productId: String(productId), available } },
    );
  }

  if (!product) return { productId, quantity: 0, stockAfter: 0, shortfall: quantity };
  const taken = Math.min(quantity, available);
  const clamped = taken > 0
    ? await Product.findOneAndUpdate(
      { _id: productId, stock: { $gte: taken } },
      { $inc: { stock: -taken, inventoryRevision: 1 }, $set: inventoryStamp(userId) },
      { new: true, session },
    ).select('stock sku')
    : product;

  return {
    productId,
    quantity: taken,
    stockAfter: Math.max(0, Number(clamped?.stock ?? available)),
    sku: product.sku,
    shortfall: quantity - taken,
  };
}

async function deductOne(item, session, { allowShortfall = false, userId } = {}) {
  const productId = itemProductId(item);
  const quantity = itemQuantity(item);
  const selectedVariantId = itemVariantId(item);

  if (selectedVariantId && mongoose.Types.ObjectId.isValid(selectedVariantId)) {
    return deductVariant(productId, selectedVariantId, quantity, session, { allowShortfall, userId });
  }

  const product = await Product.findById(productId).select('name stock sku variants').session(session || null);
  if (hasManagedVariants(product)) {
    throw new ApiError('VARIANT_UNAVAILABLE', `${product.name} requires a size and colour selection`);
  }

  return deductProductLevel(productId, quantity, session, { allowShortfall, userId });
}

async function restoreOne(item, session, { userId } = {}) {
  const productId = itemProductId(item);
  const quantity = itemQuantity(item);
  const selectedVariantId = itemVariantId(item);

  if (selectedVariantId && mongoose.Types.ObjectId.isValid(selectedVariantId)) {
    const updated = await Product.findOneAndUpdate(
      { _id: productId, 'variants._id': selectedVariantId },
      { $inc: { 'variants.$.stock': quantity, stock: quantity, inventoryRevision: 1 }, $set: inventoryStamp(userId) },
      { new: true, session },
    ).select('stock sku variants');
    if (!updated) return null;
    return {
      productId,
      quantity,
      stockAfter: stockAfterFromProduct(updated, { variantId: selectedVariantId }),
      sku: updated.sku,
      variantId: selectedVariantId,
    };
  }

  const updated = await Product.findByIdAndUpdate(
    productId,
    { $inc: { stock: quantity, inventoryRevision: 1 }, $set: inventoryStamp(userId) },
    { new: true, session },
  ).select('stock sku');

  if (!updated) return null;
  return { productId, quantity, stockAfter: updated.stock, sku: updated.sku };
}

async function recordTransactions(entries, { orderId, type, reason, userId, session }) {
  const movements = entries.filter((entry) => entry.quantity > 0);
  if (!movements.length) return;
  const productIds = [...new Set(movements.map((entry) => entry.productId).filter(Boolean))];
  const products = await Product.find({ _id: { $in: productIds } }).select('storeId').session(session || null).lean();
  const storeByProduct = new Map(products.map((product) => [String(product._id), product.storeId]));
  const docs = movements.map((entry) => ({
    storeId: storeByProduct.get(String(entry.productId)) || undefined,
    product: entry.productId,
    variantId: entry.variantId || '',
    sku: entry.sku,
    order: orderId,
    type,
    mode: 'SYSTEM',
    bucket: 'SELLABLE',
    quantity: type === 'SALE' ? -entry.quantity : entry.quantity,
    stockBefore: type === 'SALE' ? entry.stockAfter + entry.quantity : entry.stockAfter - entry.quantity,
    stockAfter: entry.stockAfter,
    reasonCode: type,
    reason,
    createdBy: userId,
  }));
  await InventoryTransaction.insertMany(docs, session ? { session } : {});
}

function notifyStockAttentionLater(entries) {
  const productIds = [...new Set(entries.map((entry) => String(entry.productId || '')).filter(Boolean))];
  if (!productIds.length) return;
  setImmediate(async () => {
    try {
      const Notification = require('../models/Notification');
      const { notify } = require('./notificationService');
      const products = await Product.find({ _id: { $in: productIds } }).select('name stock variants lowStockAlert storeId').lean();
      for (const product of products) {
        const stock = hasManagedVariants(product) ? totalVariantStock(product) : Number(product.stock || 0);
        const lowVariants = (product.variants || []).filter((variant) => variant.isActive !== false && Number(variant.stock || 0) <= Number(variant.lowStockAlert ?? product.lowStockAlert ?? 5));
        if (stock > Number(product.lowStockAlert ?? 5) && !lowVariants.length) continue;
        const recent = await Notification.exists({ storeId: product.storeId, event: 'LOW_STOCK', 'metadata.productId': String(product._id), createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } });
        if (recent) continue;
        const variantMessage = lowVariants.length
          ? `${lowVariants.slice(0, 3).map((variant) => [variant.size, variant.color].filter(Boolean).join(' / ') || variant.sku || 'A variant').join(', ')} ${lowVariants.length === 1 ? 'needs' : 'need'} stock.`
          : '';
        await notify({ storeId: product.storeId, event: 'LOW_STOCK', title: `${product.name} needs stock`, message: variantMessage || (stock > 0 ? `Only ${stock} units remain.` : 'This product is sold out.'), channels: ['IN_APP'], metadata: { productId: String(product._id), stock, lowVariantIds: lowVariants.map((variant) => String(variant._id)) } });
      }
    } catch {
      // Stock updates must succeed even when a background notification cannot be recorded.
    }
  });
}

async function deductStockForOrder(items, { orderId, userId, reason = 'Order placed', session, allowShortfall = false } = {}) {
  const applied = [];

  try {
    for (const item of items) {
      const entry = await deductOne(item, session, { allowShortfall, userId });
      applied.push({ ...entry, variantId: entry.variantId || item.variantId || '' });
    }
  } catch (error) {
    if (!session) {
      for (const entry of applied) {
        if (entry.quantity <= 0) continue;
        await restoreOne({ product: entry.productId, quantity: entry.quantity, variantId: entry.variantId }, null).catch(() => null);
      }
    }
    throw error;
  }

  await recordTransactions(applied, { orderId, type: 'SALE', reason, userId, session });
  notifyStockAttentionLater(applied);
  return applied;
}

async function restoreStockForOrder(items, { orderId, userId, type = 'CANCELLATION', reason = 'Order cancelled', session } = {}) {
  const applied = [];
  for (const item of items) {
    const entry = await restoreOne(item, session, { userId });
    if (entry) applied.push({ ...entry, variantId: entry.variantId || item.variantId || '' });
  }
  await recordTransactions(applied, { orderId, type, reason, userId, session });
  return applied;
}

async function claimInventoryRestore(OrderModel, orderId, session) {
  return OrderModel.findOneAndUpdate(
    { _id: orderId, inventoryDeducted: true, inventoryRestored: { $ne: true } },
    { $set: { inventoryRestored: true, inventoryRestoredAt: new Date() } },
    { new: true, session },
  );
}

async function claimInventoryDeduction(OrderModel, orderId, session) {
  const first = await OrderModel.findOneAndUpdate(
    { _id: orderId, inventoryDeducted: { $ne: true } },
    { $set: { inventoryDeducted: true, inventoryDeductedAt: new Date() } },
    { new: true, session },
  );
  if (first) return first;

  return OrderModel.findOneAndUpdate(
    { _id: orderId, inventoryDeducted: true, inventoryRestored: true },
    { $set: { inventoryRestored: false, inventoryDeductedAt: new Date() } },
    { new: true, session },
  );
}

async function syncProductStock(product) {
  if (!product || !hasManagedVariants(product)) return product;
  product.stock = totalVariantStock(product);
  return product.save();
}

module.exports = {
  ADJUSTMENT_MODES,
  ADJUSTMENT_REASONS,
  INVENTORY_BUCKETS,
  applyInventoryAdjustment,
  markProductOutOfStock,
  recordOpeningInventory,
  claimInventoryDeduction,
  claimInventoryRestore,
  deductOne,
  deductStockForOrder,
  restoreOne,
  restoreStockForOrder,
  syncProductStock,
  variantId,
};
