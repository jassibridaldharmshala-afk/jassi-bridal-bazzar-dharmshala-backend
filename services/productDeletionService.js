const crypto = require('node:crypto');
const Product = require('../models/Product');
const ProductDraft = require('../models/ProductDraft');
const Order = require('../models/Order');
const ReturnExchange = require('../models/ReturnExchange');
const InventoryTransaction = require('../models/InventoryTransaction');
const InventoryPurchaseOrder = require('../models/InventoryPurchaseOrder');
const InventoryItem = require('../models/InventoryItem');
const Review = require('../models/Review');
const VariantGroup = require('../models/VariantGroup');
const Coupon = require('../models/Coupon');
const Campaign = require('../models/Campaign');
const Banner = require('../models/Banner');
const WebsiteTheme = require('../models/WebsiteTheme');
const Cart = require('../models/Cart');
const User = require('../models/User');
const Store = require('../models/Store');
const Rental = require('../models/Rental');
const { andFilter } = require('./storeService');
const { supportsTransactions, runInTransaction } = require('../utils/transaction');
const { ApiError } = require('../utils/apiError');
const { logAudit } = require('./auditService');
const { assertStoreOwned } = require('../middleware/storeMiddleware');

const count = (Model, filter, session) => Model.countDocuments(filter).session(session || null);
const version = (product) => crypto.createHash('sha256').update(JSON.stringify([
  String(product._id), product.updatedAt, product.inventoryRevision || 0,
  product.isArchived, product.isActive, product.name,
])).digest('hex');

async function findProduct(req, session) {
  const product = await Product.findOne(andFilter({ _id: req.params.id }, req.tenantFilter)).session(session || null);
  if (!product) throw new ApiError('NOT_FOUND', 'Product not found.');
  assertStoreOwned(product, req);
  return product;
}

async function inspect(product, session) {
  const id = product._id;
  const values = [String(id), id];
  const configReferences = prefix => [
    { [`${prefix}.homepage.blocks.productIds`]: { $in: values } },
    ...['featured', 'newArrivals', 'bestSellers', 'trending', 'ethnicSets', 'accessories'].map(key => ({ [`${prefix}.homepage.sectionProductIds.${key}`]: { $in: values } })),
  ];
  // Check by globally unique product ID, including legacy unscoped records.
  // Never remove financial, rental or merchandising history automatically.
  const checks = [
    [Order, { $or: [{ 'orderItems.product': id }, { 'stockReservation.product': id }] }, 'orders', 'Orders or payment reservations'],
    [ReturnExchange, { product: id }, 'returns', 'Returns or exchanges'],
    [InventoryPurchaseOrder, { 'items.product': id }, 'purchases', 'Supplier purchase orders'],
    [InventoryTransaction, { product: id, $nor: [{ type: 'IMPORT', idempotencyKey: { $regex: `^opening:${id}:` }, order: null, purchaseOrder: null, reversalOf: null, reversedBy: null }] }, 'inventory', 'Inventory movement history'],
    [InventoryItem, { product: id }, 'pieces', 'Tracked physical inventory pieces'],
    [Review, { product: id }, 'reviews', 'Customer reviews'],
    [Rental.Listing, { $or: [{ productId: id }, { 'requirements.productId': id }] }, 'rentalListings', 'Rental listings or set components'],
    [Rental.Asset, { $or: [{ productId: id }, { 'saleConversion.productId': id }] }, 'rentalAssets', 'Rental assets or sale conversions'],
    [Rental.Booking, { $or: [{ 'quote.items.productId': id }, { 'acceptedQuote.items.productId': id }, { 'allocations.binding.productId': id }, { 'cancelledItems.productId': id }, { 'replacements.productId': id }] }, 'rentals', 'Rental booking history'],
    [VariantGroup, { $or: [{ baseProduct: id }, { products: id }, { 'members.product': id }] }, 'groups', 'Variant groups (remove this member first)'],
    [Coupon, { applicableProducts: id }, 'coupons', 'Product-specific coupons (update their scope first)'],
    [Campaign, { $or: [{ 'offer.applicableProducts': id }, { 'creative.destinationType': 'PRODUCT', 'creative.destinationValue': { $in: [String(id), product.slug] } }] }, 'campaigns', 'Marketing campaigns (update their scope/link first)'],
    [Banner, { destinationType: 'PRODUCT', destinationValue: { $in: [String(id), product.slug] } }, 'banners', 'Product-linked banners (change the destination first)'],
    [WebsiteTheme, { $or: ['draftConfig', 'publishedConfig', 'scheduledConfig'].flatMap(configReferences) }, 'themeSelections', 'Pinned theme products (remove the selection first)'],
    [Store, { $or: ['storefrontDesign.draftConfig', 'storefrontDesign.publishedConfig', 'storefrontDesign.scheduledConfig'].flatMap(configReferences) }, 'storeSelections', 'Pinned storefront products (remove the selection first)'],
    [ProductDraft, { _id: product.sourceDraftId, publishedProductId: null }, 'unfinishedPublication', 'An unfinished draft publication (complete it first)'],
  ];
  const blockers = [];
  const nonSellable = [product.nonSellableStock, ...(product.variants || []).map(item => item.nonSellableStock)]
    .reduce((sum, bucket) => sum + Number(bucket?.damaged || 0) + Number(bucket?.quarantine || 0), 0);
  if (nonSellable) blockers.push({ key: 'nonSellable', label: 'Damaged or quarantined stock (resolve it first)', count: nonSellable });
  for (const [Model, filter, key, label] of checks) {
    // A missing sourceDraftId must never accidentally count every draft.
    if (key === 'unfinishedPublication' && !product.sourceDraftId) continue;
    const total = await count(Model, filter, session);
    if (total) blockers.push({ key, label, count: total });
  }
  const cleanup = {
    carts: await count(Cart, { 'items.product': id }, session),
    wishlists: await count(User, { wishlist: id }, session),
    recommendations: await count(Product, { completeLookProductIds: id }, session),
    draftRecommendations: await count(ProductDraft, { completeLookProductIds: id }, session),
    openingMovements: await count(InventoryTransaction, { product: id }, session),
  };
  return { blockers, cleanup };
}

async function preview(req) {
  const product = await findProduct(req);
  const { blockers, cleanup } = await inspect(product);
  const transactions = await supportsTransactions();
  return {
    id: String(product._id), name: product.name, sku: product.sku || '',
    stock: Number(product.stock || 0), archived: Boolean(product.isArchived && !product.isActive),
    version: version(product), confirmation: String(product.name || product._id).trim(),
    eligible: Boolean(product.isArchived && !product.isActive) && !blockers.length && transactions,
    transactions, blockers, cleanup,
    mediaPolicy: 'Uploaded files are retained to protect shared images and import sources.',
  };
}

async function permanentlyDelete(req) {
  if (!await supportsTransactions()) throw new ApiError('SERVICE_UNAVAILABLE', 'Permanent deletion requires a transaction-capable MongoDB deployment. Archive remains available.');
  return runInTransaction(async (session) => {
    // No partial cleanup on standalone MongoDB or an unavailable transaction.
    if (!session) throw new ApiError('SERVICE_UNAVAILABLE', 'Safe permanent deletion is unavailable. Archive remains available.');
    const product = await findProduct(req, session);
    if (!product.isArchived || product.isActive) throw new ApiError('PRODUCT_DELETE_BLOCKED', 'Archive this product before permanently deleting it.', { statusCode: 409 });
    if (String(req.body?.confirm || '').trim() !== String(product.name || product._id).trim()) throw new ApiError('VALIDATION_ERROR', 'Type the exact product name to confirm permanent deletion.');
    if (!req.body?.version || req.body.version !== version(product)) throw new ApiError('PRODUCT_CHANGED', 'This product changed. Refresh the deletion review before continuing.', { statusCode: 409 });
    // Establish a write conflict with stock changes, restores and catalog edits
    // before inspecting dependencies. Rental writers use the same store fence.
    await Product.updateOne({ _id: product._id, updatedAt: product.updatedAt }, { $inc: { inventoryRevision: 1 } }, { session });
    const rentalStoreId = product.storeId || (await Store.findOne({ isDefault: true }).select('_id').session(session))?._id;
    if (rentalStoreId) await Rental.Configuration.updateOne({ storeId: rentalStoreId }, { $inc: { fence: 1 } }, { session });
    const { blockers, cleanup } = await inspect(product, session);
    if (blockers.length) throw new ApiError('PRODUCT_DELETE_BLOCKED', `Cannot delete: ${blockers.map(item => item.label).join('; ')}. Keep this product archived to preserve its history.`, { statusCode: 409, details: { blockers } });
    const id = product._id;
    await Cart.updateMany({ 'items.product': id }, { $pull: { items: { product: id } }, $inc: { __v: 1 } }, { session });
    await User.updateMany({ wishlist: id }, { $pull: { wishlist: id } }, { session });
    await Product.updateMany({ completeLookProductIds: id }, { $pull: { completeLookProductIds: id } }, { session });
    await ProductDraft.updateMany({ completeLookProductIds: id }, { $pull: { completeLookProductIds: id }, $inc: { revision: 1 } }, { session });
    // Preserve the append-only opening ledger with a readable snapshot.
    await InventoryTransaction.updateMany({ product: id }, { $set: { productSnapshot: { name: product.name, sku: product.sku || '', deletedAt: new Date() } } }, { session });
    await Product.deleteOne({ _id: id }, { session });
    await logAudit({ req, action: 'PRODUCT_PERMANENT_DELETE', entityType: 'Product', entityId: id, storeId: product.storeId,
      before: { name: product.name, sku: product.sku, stock: product.stock, isArchived: true },
      after: { permanentlyDeleted: true, cleanup, mediaRetained: true }, summary: `Permanently deleted unused product ${product.name}`, session, strict: true });
    return { success: true, message: 'Product permanently deleted. Uploaded files and audit history were retained.', id: String(id) };
  });
}

module.exports = { preview, permanentlyDelete };
