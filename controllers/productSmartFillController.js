const rateLimit = require('express-rate-limit');
const Category = require('../models/Category');
const { andFilter } = require('../services/storeService');
const { readConfiguration } = require('../services/masterConfigurationService');
const { analyzeProductContext, enabled } = require('../services/productImportContext.service');
const { readProductPhoto } = require('../services/productSmartFillMedia');
const { asyncHandler } = require('../middleware/validate');
const { ApiError } = require('../utils/apiError');

const active = new Set();
const clean = (value, max = 3000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const factFields = { name: 'Name', category: 'Category', subCategory: 'Product type', fabric: 'Fabric', colors: 'Colours', sizes: 'Sizes', occasion: 'Occasion', description: 'Description' };
function sourceText(body, categories, attributes) {
  const existing = body.existing && typeof body.existing === 'object' && !Array.isArray(body.existing) ? body.existing : {};
  const lines = Object.entries(factFields).map(([key, label]) => {
    const raw = key === 'category' ? categories.find(item => String(item._id) === existing.category)?.name : existing[key];
    const value = clean(Array.isArray(raw) ? raw.filter(item => typeof item === 'string').join(', ') : raw, key === 'description' ? 2000 : 200);
    return value ? label + ': ' + value.replace(/\r?\n/g, ' ') : '';
  }).filter(Boolean);
  for (const attribute of attributes) {
    const value = clean(existing.attributeValues?.[attribute.key], 500);
    if (value) lines.push(attribute.label + ': ' + value);
  }
  // Supplier notes go first. Previously entered prices and stock are never
  // reinterpreted as new commercial evidence.
  return [clean(body.notes, 7000), ...lines].filter(Boolean).join('\n').slice(0, 10000);
}

exports.limiter = rateLimit({ windowMs: 60000, max: 12, standardHeaders: true, legacyHeaders: false,
  keyGenerator: req => String(req.user._id),
  message: { message: 'Smart Fill has received several requests. Please wait a minute before trying again.' },
});
exports.status = (_req, res) => res.json({ enabled: enabled(), notesSupported: true, maxPhotos: 3 });
exports.fill = asyncHandler(async (req, res) => {
  if (req.body?.notes !== undefined && (typeof req.body.notes !== 'string' || req.body.notes.length > 7000)) throw new ApiError('VALIDATION_ERROR', 'Keep supplier notes under 7,000 characters.');
  const urls = req.body?.imageUrls ?? [];
  if (!Array.isArray(urls) || urls.length > 3 || urls.some(url => typeof url !== 'string' || url.length > 4096)) throw new ApiError('VALIDATION_ERROR', 'Select up to three uploaded product photos.');
  const key = String(req.user._id);
  if (active.has(key)) throw new ApiError('DUPLICATE_REQUEST', 'A Smart Fill request is already running. Wait for it to finish.');
  active.add(key);
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(75000)]);
  const cancel = () => { if (!res.writableEnded) controller.abort(); };
  res.on('close', cancel);
  try {
    const [categories, configuration] = await Promise.all([
      Category.find(andFilter({ isActive: { $ne: false } }, req.tenantFilter)).select('_id name').limit(100).lean(), readConfiguration(req.store?._id),
    ]);
    const attributes = configuration.structure.attributes || [];
    const caption = sourceText(req.body || {}, categories, attributes);
    if (!caption && !urls.length) throw new ApiError('VALIDATION_ERROR', 'Add a product photo, supplier notes or a few product details first.');
    if (!enabled() && !caption) throw new ApiError('SMART_FILL_UNAVAILABLE', 'Photo analysis needs Gemini configured on the backend. You can still paste supplier notes to fill stated details.');
    const images = []; const warnings = [];
    if (enabled()) {
      for (const url of [...new Set(urls)]) {
        try { images.push(await readProductPhoto(url, signal)); }
        catch (error) { if (signal.aborted) throw error; warnings.push('A selected photo could not be read. Re-upload it for photo analysis.'); }
      }
      if (urls.length && !images.length && !caption) throw new ApiError('SMART_FILL_MEDIA', warnings[0]);
    }
    const suggestion = await analyzeProductContext({ caption, images, categories, attributes, signal });
    // Configured specifications also work in notes-only mode, but only for a
    // labelled, verbatim value. There are no inferred warranty/material claims.
    suggestion.attributeValues = { ...suggestion.attributeValues };
    for (const attribute of attributes) {
      const labels = [attribute.label, attribute.key].map(value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
      const match = caption.match(new RegExp(`(?:^|\\n)\\s*(?:${labels})\\s*[:=]\\s*([^\\n]+)`, 'i'));
      if (match && !suggestion.attributeValues[attribute.key]) {
        suggestion.attributeValues[attribute.key] = clean(match[1], 500);
        suggestion.fieldSources['attribute.' + attribute.key] = { source: 'caption', quote: match[0].trim() };
      }
    }
    if (suggestion.contextStatus === 'failed') warnings.push(suggestion.contextError);
    if (!enabled()) warnings.push('Photo AI is not configured. These suggestions use only the details stated in your notes and form.');
    if (suggestion.priceAmbiguous || suggestion.multipleProducts) warnings.push('More than one price or product may be present. Confirm the product and enter its price manually.');
    if (configuration.structure.features?.sizing === false) { delete suggestion.sizes; delete suggestion.sizingMode; delete suggestion.sizeChart; }
    // Only listing data is returned. No credentials, model configuration or
    // provider responses are included, and nothing is saved or published here.
    const fields = ['name', 'category', 'subCategory', 'description', 'shortDescription', 'colors', 'tags', 'highlights', 'fabric', 'occasion', 'sizes', 'sizingMode', 'price', 'originalPrice', 'attributeValues'];
    const data = Object.fromEntries(fields.filter(field => suggestion[field] !== undefined).map(field => [field, suggestion[field]]));
    res.json({ suggestion: data, fieldSources: suggestion.fieldSources || {}, mode: suggestion.contextStatus === 'completed' ? 'ai' : 'notes', warnings: [...new Set(warnings)] });
  } catch (error) {
    if (signal.aborted && !controller.signal.aborted) throw new ApiError('SMART_FILL_TIMEOUT', 'Smart Fill took too long. Try again with fewer photos, or paste the product details.');
    if (!controller.signal.aborted) throw error;
  } finally { active.delete(key); res.off('close', cancel); }
});
exports.sourceText = sourceText;
