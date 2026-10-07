const mongoose = require('mongoose');
const Product = require('../models/Product');
const Category = require('../models/Category');
const Store = require('../models/Store');
const Settings = require('../models/Settings');
const { Configuration, Listing } = require('../models/Rental');
const { andFilter, defaultStoreFilter } = require('./storeService');
const { ApiError } = require('../utils/apiError');

const CARD_FIELDS = '_id slug name category subCategory industry occasion colors tags price originalPrice salePrice saleStartAt saleEndAt stock variants sizingMode sizes images primaryImage rating numReviews commerceMode isNewArrival isBestSeller';
const FLAGS = 'occasionShoppingEnabled recentlyViewedEnabled completeLookEnabled';
function publicFilter(req, extra = {}) {
  return andFilter({ $and: [{ isActive: true, isArchived: { $ne: true } }, { $or: [{ publishAt: { $exists: false } }, { publishAt: null }, { publishAt: { $lte: new Date() } }] }, extra] }, req.tenantFilter);
}
function tokens(value) {
  return [...new Map(String(value || '').split(/[,;|]/).map(s => s.trim().replace(/\s+/g, ' ')).filter(s => s && s.length <= 64 && !/[<>\x00-\x1f]/.test(s)).map(s => [s.toLocaleLowerCase('en-IN'), s])).values()].slice(0, 12);
}
function ids(value, limit = 12) {
  return [...new Set((Array.isArray(value) ? value : String(value || '').split(',')).map(item => String(item).toLowerCase()).filter(s => /^[a-f\d]{24}$/i.test(s)))].slice(0, limit);
}
async function preferences(req) {
  const [settings, rental] = await Promise.all([
    Settings.findOne(req.tenantFilter || {}).select(FLAGS).maxTimeMS(4000).lean(),
    req.store?._id ? Configuration.findOne({ storeId: req.store._id }).select('mode').maxTimeMS(4000).lean() : null,
  ]);
  const mode = rental?.mode || req.store?.catalogStructure?.commerce?.mode || 'SALE_ONLY';
  return { mode, rentalEnabled: mode !== 'SALE_ONLY', occasionShoppingEnabled: settings?.occasionShoppingEnabled !== false, recentlyViewedEnabled: settings?.recentlyViewedEnabled !== false, completeLookEnabled: settings?.completeLookEnabled !== false };
}
function catalogModeFilter(mode) { return mode === 'SALE_ONLY' ? { commerceMode: { $ne: 'RENTAL_ONLY' } } : {}; }
async function discovery(req) {
  const prefs = await preferences(req);
  const recent = prefs.recentlyViewedEnabled ? ids(req.query.recent) : [];
  const rentalProductIds = prefs.mode === 'RENTAL_ONLY' && req.store?._id ? await Listing.distinct('productId', { storeId: req.store._id, active: true }).maxTimeMS(4000) : null;
  const modeFilter = rentalProductIds ? { _id: { $in: rentalProductIds } } : catalogModeFilter(prefs.mode);
  const [groups, rows] = await Promise.all([
    prefs.occasionShoppingEnabled ? Product.aggregate([{ $match: publicFilter(req, modeFilter) }, { $match: { occasion: { $type: 'string', $ne: '' } } }, { $group: { _id: '$occasion', count: { $sum: 1 } } }, { $sort: { count: -1, _id: 1 } }, { $limit: 500 }]).option({ maxTimeMS: 4000 }) : [],
    recent.length ? Product.find(publicFilter(req, { $and: [{ _id: { $in: recent } }, modeFilter] })).select(CARD_FIELDS).populate('category', 'name slug').limit(12).maxTimeMS(4000).lean() : [],
  ]);
  const occasions = new Map();
  for (const group of groups) for (const label of tokens(group._id)) {
    const key = label.toLocaleLowerCase('en-IN');
    const item = occasions.get(key) || { key, label, count: 0 }; item.count += group.count; occasions.set(key, item);
  }
  const byId = new Map(rows.map(row => [String(row._id), row]));
  return { ...prefs, occasions: [...occasions.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)).slice(0, 24), recentlyViewed: recent.map(id => byId.get(id)).filter(Boolean) };
}
const ROLES = [
  ['garment', /\b(saree|sarees|sari|saris|lehenga|lehengas|kurta|kurtas|kurti|kurtis|suit|suits|dress|dresses|outfit|outfits|clothing|apparel|ethnic wear)\b/i],
  ['necklace', /\b(necklace|necklaces|pendant|pendants|neck ?set)\b/i],
  ['earrings', /\b(earring|earrings|jhumka|jhumkas)\b/i],
  ['bangles', /\b(bangle|bangles|bracelet|bracelets|chudi|chooda)\b/i],
  ['bag', /\b(bag|bags|clutch|clutches|handbag|handbags|potli)\b/i],
  ['footwear', /\b(footwear|sandal|sandals|heel|heels|shoe|shoes|juttis|jutti)\b/i],
];
const PAIRS = { garment: ['necklace', 'earrings', 'bangles', 'bag', 'footwear'], necklace: ['earrings', 'bangles'], earrings: ['necklace', 'bangles'], bangles: ['necklace', 'earrings'], bag: ['footwear'], footwear: ['bag'] };
function role(product) {
  for (const text of [product.category?.name, product.subCategory, product.name]) { const found = ROLES.find(([, pattern]) => pattern.test(String(text || ''))); if (found) return found[0]; }
  return '';
}
function common(a, b) { const values = new Set(a.map(s => String(s).trim().toLowerCase()).filter(Boolean)); return b.some(s => values.has(String(s).trim().toLowerCase())); }
function complementScore(source, candidate) {
  if (!PAIRS[role(source)]?.includes(role(candidate))) return 0;
  const occasion = common(tokens(source.occasion), tokens(candidate.occasion));
  const colour = common(source.colors || [], candidate.colors || []);
  const tags = common(source.tags || [], candidate.tags || []);
  // Do not call random products a matching look when no context matches.
  return occasion || colour || tags ? 20 + (occasion ? 12 : 0) + (colour ? 8 : 0) + (tags ? 4 : 0) : 0;
}
function saleAvailable(product) {
  const variants = Array.isArray(product.variants) ? product.variants : [];
  return variants.length ? variants.some(variant => variant.isActive !== false && Number(variant.stock) > 0) : Number(product.stock) > 0;
}
async function validateComplements(req, payload, sourceId, sourceStoreId) {
  if (payload.completeLookProductIds === undefined) return;
  const values = payload.completeLookProductIds;
  if (!Array.isArray(values) || values.length > 8 || values.some(id => typeof id !== 'string' || !/^[a-f\d]{24}$/i.test(id)) || new Set(values.map(id => id.toLowerCase())).size !== values.length || values.some(id => id.toLowerCase() === String(sourceId || '').toLowerCase())) throw new ApiError('VALIDATION_ERROR', 'Choose up to eight distinct matching products, excluding this product.');
  if (!values.length) return;
  let tenant = Object.keys(req.tenantFilter || {}).length ? req.tenantFilter : { storeId: req.store?._id || null };
  if (sourceStoreId && String(sourceStoreId) !== String(req.store?._id || '')) {
    const target = await Store.findById(sourceStoreId).select('isDefault').maxTimeMS(4000).lean();
    tenant = target?.isDefault ? defaultStoreFilter(sourceStoreId) : { storeId: sourceStoreId };
  }
  const count = await Product.countDocuments(andFilter({ _id: { $in: values } }, tenant)).maxTimeMS(4000);
  if (count !== values.length) throw new ApiError('VALIDATION_ERROR', 'Matching products must belong to this store.');
}
async function completeLook(req) {
  const prefs = await preferences(req);
  const key = req.params.slug;
  const source = await Product.findOne(publicFilter(req, mongoose.isValidObjectId(key) ? { _id: key } : { slug: key })).select(`${CARD_FIELDS} completeLookProductIds`).populate('category', 'name slug').maxTimeMS(4000).lean();
  if (!source) throw new ApiError('NOT_FOUND', 'Product not found.');
  if (!prefs.completeLookEnabled) return { enabled: false, products: [] };
  const curated = ids(source.completeLookProductIds, 8).filter(id => id !== String(source._id));
  const sourceRole = role(source);
  const terms = PAIRS[sourceRole]?.flatMap(r => ROLES.find(([key]) => key === r)?.[1].source.replace(/^\\b\(|\)\\b$/g, '').split('|')) || [];
  const matchingCategories = !curated.length && terms.length ? await Category.find(andFilter({ name: { $regex: terms.join('|'), $options: 'i' } }, req.tenantFilter)).select('_id').limit(100).maxTimeMS(4000).lean() : [];
  const extra = curated.length ? { _id: { $in: curated } } : terms.length ? { $or: [{ category: { $in: matchingCategories.map(row => row._id) } }, { name: { $regex: terms.join('|'), $options: 'i' } }, { subCategory: { $regex: terms.join('|'), $options: 'i' } }] } : null;
  if (!extra) return { enabled: true, products: [] };
  const candidates = await Product.find(publicFilter(req, { $and: [extra, { _id: { $ne: source._id } }] })).select(CARD_FIELDS).populate('category', 'name slug').sort('_id').limit(curated.length ? 8 : 120).maxTimeMS(4000).lean();
  const rentalOnly = prefs.mode === 'RENTAL_ONLY' || source.commerceMode === 'RENTAL_ONLY';
  const rentals = rentalOnly && prefs.rentalEnabled && req.store?._id ? await Listing.find({ storeId: req.store._id, productId: { $in: candidates.map(p => p._id) }, active: true }).select('productId dailyRatePaise depositPaise').maxTimeMS(4000).lean() : [];
  const rates = new Map();
  for (const row of rentals) { const key = String(row.productId); if (!rates.has(key) || row.dailyRatePaise < rates.get(key).dailyRatePaise) rates.set(key, row); }
  const products = candidates.filter(p => rentalOnly ? rates.has(String(p._id)) : p.commerceMode !== 'RENTAL_ONLY' && saleAvailable(p))
    .map(p => ({ ...p, discoveryPurchase: rentalOnly ? 'RENTAL' : 'SALE', ...(rentalOnly ? { rentalPreview: { dailyRatePaise: rates.get(String(p._id)).dailyRatePaise, depositPaise: rates.get(String(p._id)).depositPaise } } : {}), score: curated.length ? 100 - curated.indexOf(String(p._id)) : complementScore(source, p) }))
    .filter(p => p.score > 0).sort((a, b) => b.score - a.score || String(a._id).localeCompare(String(b._id))).slice(0, 8).map(({ score, ...p }) => p);
  return { enabled: true, products, strategy: curated.length ? 'OWNER_CURATED' : 'CONTEXT_MATCHED' };
}
module.exports = { CARD_FIELDS, publicFilter, tokens, ids, preferences, discovery, completeLook, complementScore, validateComplements };
