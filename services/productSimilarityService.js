const Product = require('../models/Product');
const { defaultStoreFilter } = require('./storeService');
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const words = value => String(value || '').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [];
async function similar(store, suggestion = {}, existing = {}, imageUrls = []) {
  if (!store?._id) return [];
  const name = suggestion.name || existing.name || '';
  const tokens = [...new Set(words(name))].slice(0, 8);
  const urls = imageUrls.filter(url => typeof url === 'string').slice(0, 6);
  const choices = [tokens.length && { name: { $regex: tokens.map(escape).join('|'), $options: 'i' } }, urls.length && { 'images.url': { $in: urls } }].filter(Boolean);
  if (!choices.length) return [];
  const scope = store.isDefault ? defaultStoreFilter(store._id) : { storeId: store._id };
  const rows = await Product.find({ $and: [scope, { isArchived: { $ne: true }, $or: choices }] }).select('_id name sku category images.url').sort('_id').limit(80).maxTimeMS(3000).lean();
  return rows.filter(row => String(row._id) !== String(existing.productId || '')).map(row => {
    const exactPhoto = row.images?.some(image => urls.includes(image.url));
    const exactName = row.name.trim().toLowerCase() === String(name).trim().toLowerCase();
    const intersection = words(row.name).filter(word => tokens.includes(word)).length;
    const score = exactPhoto ? 1 : exactName ? 1 : intersection / Math.max(1, new Set([...tokens, ...words(row.name)]).size);
    return { _id: String(row._id), name: row.name, sku: row.sku, reason: exactPhoto ? 'Same uploaded photo' : exactName ? 'Same product name' : 'Similar product name', score };
  }).filter(row => row.score >= 0.5).sort((a, b) => b.score - a.score || a._id.localeCompare(b._id)).slice(0, 5).map(({ score, ...row }) => row);
}
module.exports = { similar };
