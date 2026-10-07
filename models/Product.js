const mongoose = require('mongoose');
const storeIdPlugin = require('./plugins/storeId');
const imageBackground = require('./imageBackgroundSchema');

const variantSchema = new mongoose.Schema({
  sku: String,
  size: { type: String, default: '' },
  color: { type: String, default: '' },
  optionValues: { type: Map, of: String, default: {} },
  stock: { type: Number, default: 0, min: 0 },
  lowStockAlert: { type: Number, min: 0 },
  nonSellableStock: {
    damaged: { type: Number, min: 0, default: 0 },
    quarantine: { type: Number, min: 0, default: 0 },
  },
  price: Number,
  originalPrice: Number,
  images: [{ url: String, publicId: String, primary: { type: Boolean, default: false } }],
  isActive: { type: Boolean, default: true },
}, { _id: true });

const sizeChartRowSchema = new mongoose.Schema({
  size: { type: String, required: true, trim: true },
  acrossShoulder: { type: Number, min: 0 },
  sleeveLength: { type: Number, min: 0 },
  bust: { type: Number, min: 0 },
  chest: { type: Number, min: 0 },
  waist: { type: Number, min: 0 },
  frontLength: { type: Number, min: 0 },
  bottomLength: { type: Number, min: 0 },
  hips: { type: Number, min: 0 },
  outseamLength: { type: Number, min: 0 },
  inseamLength: { type: Number, min: 0 },
}, { _id: false });

const productSchema = new mongoose.Schema({
  name: { type: String, required: true },
  sourceDraftId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductDraft', unique: true, sparse: true, default: undefined },
  slug: { type: String, required: true },
  brand: { type: String, default: 'Jassi General Store' },
  shortDescription: String,
  industry: { type: String, default: 'fashion', index: true },
  commerceMode: { type: String, enum: ['SALE_ONLY', 'RENTAL_ONLY', 'SALE_AND_RENTAL'], default: 'SALE_ONLY' },
  industryRevision: { type: Number, default: 0 },
  categoryDefinitionKey: { type: String, default: '' },
  attributeValues: { type: Map, of: String, default: {} },
  specifications: [{ _id: false, key: String, label: String, value: String, unit: String, group: String, active: { type: Boolean, default: true }, showOnDetail: { type: Boolean, default: true } }],
  description: String,
  category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category' },
  subCategory: String,
  price: { type: Number, required: true },
  originalPrice: Number,
  costPrice: { type: Number, min: 0, default: 0 },
  discountPercentage: Number,
  gstRate: { type: Number, min: 0, max: 100, default: 0 },
  hsnCode: { type: String, trim: true, default: '' },
  barcode: { type: String, trim: true, default: '' },
  images: [{ url: String, publicId: String, primary: { type: Boolean, default: false }, background: { type: imageBackground, default: undefined }, sourceFrame: { type: new mongoose.Schema({ timestampSeconds: Number, qualityScore: Number, viewType: String, width: Number, height: Number, selectionVersion: String }, { _id: false }), default: undefined } }],
  videos: [{ url: String, publicId: String, thumbnail: String }],
  sizes: [String],
  sizingMode: { type: String, enum: ['auto', 'sized', 'free-size'], default: 'auto' },
  sizeChartProfile: {
    type: String,
    enum: ['auto', 'free-size', 'kurta-set', 'kurti', 'dress', 'top-shirt', 'bottom', 'skirt-lehenga', 'jumpsuit', 'apparel'],
    default: 'auto',
  },
  sizeChart: {
    unit: { type: String, enum: ['in', 'cm'], default: 'in' },
    columns: { type: [String], default: [] },
    rows: { type: [sizeChartRowSchema], default: [] },
  },
  sizeFitNotes: String,
  colors: [String],
  fabric: String,
  occasion: String,
  completeLookProductIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
  variantGroupId: { type: mongoose.Schema.Types.ObjectId, ref: 'VariantGroup' },
  variantName: String,
  variantColor: String,
  variantSize: String,
  variants: { type: [variantSchema], default: [] },
  stock: { type: Number, required: true, default: 0 },
  lowStockAlert: { type: Number, default: 5 },
  inventoryRevision: { type: Number, min: 0, default: 0 },
  catalogReferenceRevision: { type: Number, default: 0, select: false },
  nonSellableStock: {
    damaged: { type: Number, min: 0, default: 0 },
    quarantine: { type: Number, min: 0, default: 0 },
  },
  inventoryLocation: { type: String, trim: true, maxlength: 120, default: '' },
  binLocation: { type: String, trim: true, maxlength: 80, default: '' },
  lastInventoryChangeAt: Date,
  lastInventoryChangedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reorderQuantity: { type: Number, min: 0, default: 0 },
  shippingWeightKg: { type: Number, min: 0, max: 1000, default: 0 },
  packageDimensions: {
    lengthCm: { type: Number, min: 0, max: 1000, default: 0 },
    widthCm: { type: Number, min: 0, max: 1000, default: 0 },
    heightCm: { type: Number, min: 0, max: 1000, default: 0 },
  },
  countryOfOrigin: { type: String, trim: true, default: 'India' },
  manufacturerDetails: { type: String, trim: true, default: '' },
  warranty: { type: String, trim: true, default: '' },
  supplierName: { type: String, trim: true, default: '' },
  supplierSku: { type: String, trim: true, default: '' },
  restockAt: Date,
  publishAt: Date,
  salePrice: { type: Number, min: 0 },
  saleStartAt: Date,
  saleEndAt: Date,
  expiryDate: Date,
  batchNumber: String,
  sku: { type: String },
  tags: [String],
  primaryImage: String,
  highlights: [String],
  careInstructions: String,
  returnPolicy: String,
  returnable: { type: Boolean, default: true },
  exchangeable: { type: Boolean, default: true },
  returnWindowDays: { type: Number, min: 0, max: 365 },
  metaTitle: String,
  metaDescription: String,
  metaKeywords: String,
  rating: { type: Number, default: 0 },
  numReviews: { type: Number, default: 0 },
  isFeatured: { type: Boolean, default: false },
  isNewArrival: { type: Boolean, default: false },
  isBestSeller: { type: Boolean, default: false },
  showOnHomepage: { type: Boolean, default: false },
  showInTrending: { type: Boolean, default: false },
  showInFestive: { type: Boolean, default: false },
  isActive: { type: Boolean, default: true },
  isArchived: { type: Boolean, default: false, index: true },
  deletedAt: Date,
}, { timestamps: true });

productSchema.plugin(storeIdPlugin);
productSchema.index({ storeId: 1, slug: 1 }, { unique: true });
productSchema.index({ storeId: 1, sku: 1 }, { unique: true, partialFilterExpression: { sku: { $type: 'string' } } });
productSchema.index({ storeId: 1, category: 1, createdAt: -1 });
productSchema.index({ storeId: 1, isActive: 1, createdAt: -1 });
productSchema.index({ storeId: 1, isArchived: 1, updatedAt: -1 });
productSchema.index({ storeId: 1, barcode: 1 }, { unique: true, partialFilterExpression: { barcode: { $type: 'string', $gt: '' } } });
productSchema.index({ storeId: 1, stock: 1, updatedAt: -1 });

productSchema.pre('save', function syncVariantStock(next) {
  if (Array.isArray(this.variants) && this.variants.length) {
    this.stock = this.variants
      .filter((variant) => variant && variant.isActive !== false)
      .reduce((sum, variant) => sum + Math.max(0, Number(variant.stock || 0)), 0);
  }
  next();
});

module.exports = mongoose.model('Product', productSchema);
