const Product = require('../models/Product');
const Category = require('../models/Category');
const { cleanText } = require('./trafficAlgorithms');
const { defaultStoreFilter } = require('./storeService');
const cache = new Map();
const words = value => String(value || '').normalize('NFKC').toLowerCase().match(/[\p{L}]{2,36}/gu) || [];

// Searches are arbitrary user input. Retain catalogue topics, not the raw
// phrase, so names/addresses accidentally typed into search are discarded.
async function vocabulary(store) {
  const key = String(store._id);
  const saved = cache.get(key); if (saved?.until > Date.now()) return saved.promise;
  if (cache.size >= 20) cache.delete(cache.keys().next().value);
  const scope = store.isDefault ? defaultStoreFilter(store._id) : { storeId: store._id };
  const promise = Promise.all([Product, Category].map(Model => Model.find(scope).select('name').limit(10000).lean())).then(groups => new Set(groups.flatMap(rows => rows.flatMap(row => words(row.name))))).catch(() => { cache.delete(key); return new Set(); });
  cache.set(key, { until: Date.now() + 300000, promise }); return promise;
}
async function searchTopic(value, store) {
  const safe = cleanText(value, 120); if (!safe || safe === '[redacted]') return safe;
  const allowed = await vocabulary(store);
  const topics = [...new Set(words(safe).filter(word => allowed.has(word)))].slice(0, 5);
  return topics.join(' ').slice(0, 120) || 'Other search';
}
module.exports = { searchTopic };
