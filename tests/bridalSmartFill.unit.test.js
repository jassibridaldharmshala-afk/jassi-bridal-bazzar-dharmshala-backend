const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeContext, analyzeProductContext, matchCategory, captionPrices } = require('../services/productImportContext.service');
const { suggestionAttributes } = require('../services/productSuggestionPolicy');
const { normalizeVisionSuggestion } = require('../services/quickAddVision.service');
const categories = [{ _id: 'lehenga', name: 'Lehengas' }, { _id: 'jewellery', name: 'Bridal Jewellery', definitionKey: 'bridal_jewellery' }, { _id: 'garland', name: 'Jaimala & Varmala' }];
const structure = { industry: 'boutique', features: { sizing: true }, attributes: [
  { key: 'size', label: 'Size' }, { key: 'pattern', type: 'dropdown', options: ['Embroidered', 'Solid'] },
  { key: 'material', type: 'text' }, { key: 'embellishment', type: 'text' },
], categoryDefinitions: [{ key: 'bridal_jewellery', name: 'Bridal Jewellery', attributes: [{ key: 'jewellery_type', label: 'Jewellery type', type: 'dropdown', options: ['Necklace Set', 'Earrings'] }] }] };
const raw = { name: 'Wine Embroidered Lehenga', category: 'lehenga', multipleProducts: false, priceAmbiguous: false, fieldSources: {}, colors: ['Wine', 'Gold'], highlights: ['Gold floral embroidery'], description: 'Wine lehenga with gold floral embroidery.', sizes: ['M'], sizingMode: 'sized', attributeValues: { size: 'M' } };

test('bridal extraction keeps visible details and supported specifications without fixed sizes or guessed material', () => {
  const attributes = suggestionAttributes(structure, categories);
  const result = normalizeContext({ ...raw, fabric: 'Silk', careInstructions: 'Machine wash', attributeValues: { size: 'M', pattern: 'embroidered', material: 'Silk', embellishment: 'Gold floral work', jewellery_type: 'Earrings' }, fieldSources: {
    sizes: { source: 'on_screen', quote: 'M' }, fabric: { source: 'visual', quote: 'Silky shine' }, careInstructions: { source: 'visual', quote: 'Looks washable' },
    'attribute.pattern': { source: 'visual', quote: 'Floral embroidery is visible' }, 'attribute.material': { source: 'visual', quote: 'Silky shine' },
    'attribute.embellishment': { source: 'visual', quote: 'Gold floral work' }, 'attribute.jewellery_type': { source: 'visual', quote: 'Model wears earrings' },
  } }, { structure, categories, attributes });
  assert.deepEqual(result.sizes, []); assert.equal(result.sizingMode, 'free-size'); assert.deepEqual(result.sizeChart.rows, []);
  assert.deepEqual(result.attributeValues, { pattern: 'Embroidered', embellishment: 'Gold floral work' });
  assert.equal(result.fabric, undefined); assert.equal(result.careInstructions, undefined); assert.equal(result.fieldSources.sizes, undefined);
  assert.deepEqual(result.highlights, raw.highlights);
});

test('category-specific dropdowns use configured options and only their matching product category', () => {
  const attributes = suggestionAttributes(structure, categories);
  const candidate = { ...raw, category: 'jewellery', attributeValues: { jewellery_type: 'necklace set' }, fieldSources: { 'attribute.jewellery_type': { source: 'visual', quote: 'Matching necklace design' } } };
  assert.equal(normalizeContext(candidate, { structure, categories, attributes }).attributeValues.jewellery_type, 'Necklace Set');
  assert.equal(normalizeContext({ ...candidate, attributeValues: { jewellery_type: 'Invented option' } }, { structure, categories, attributes }).attributeValues.jewellery_type, undefined);
  assert.equal(matchCategory('Red artificial jaimala', categories), 'garland');
  for (const notes of ['Rent: Rs 499', 'Rental rate: 499', 'Security deposit: Rs 1000']) assert.equal(captionPrices(notes).price, undefined);
  assert.equal(captionPrices('Sale price: Rs 1500\nRent: Rs 499').price, 1500);
});

test('notes fallback fills explicit care, highlights and category-specific details but never bridal sizes', async t => {
  const previous = process.env.GEMINI_API_KEY; delete process.env.GEMINI_API_KEY;
  t.after(() => { if (previous !== undefined) process.env.GEMINI_API_KEY = previous; });
  const result = await analyzeProductContext({ caption: 'Name: Bridal Jewellery\nJewellery type: Necklace Set\nSizes: M, L\nCare: Keep away from water\nHighlights: Matching necklace, Pearl detailing\nPrice: 1500', categories, structure });
  assert.equal(result.category, 'jewellery'); assert.equal(result.attributeValues.jewellery_type, 'Necklace Set');
  assert.equal(result.careInstructions, 'Keep away from water'); assert.equal(result.highlights.length, 2);
  assert.deepEqual(result.sizes, []); assert.equal(result.price, 1500);
});

test('six product views use one bounded AI request and quick add uses the same evidence and bridal size policy', async t => {
  const previous = process.env.GEMINI_API_KEY; process.env.GEMINI_API_KEY = 'synthetic-test-key';
  t.after(() => { if (previous === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = previous; });
  const provider = t.mock.method(global, 'fetch', async (_url, options) => {
    const parts = JSON.parse(options.body).contents[0].parts;
    assert.equal(parts.filter(item => item.inlineData).length, 6);
    assert.ok(parts.some(item => item.text?.includes('NEVER extract size labels')));
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(raw) }] } }] }) };
  });
  const result = await analyzeProductContext({ images: Array.from({ length: 6 }, () => ({ mimeType: 'image/jpeg', buffer: Buffer.from([255, 216, 255, 1]) })), categories, structure });
  assert.equal(result.contextStatus, 'completed'); assert.equal(provider.mock.callCount(), 1); assert.equal(result.sizingMode, 'free-size');
  const quick = normalizeVisionSuggestion({ ...raw, fabric: 'Silk', categoryName: 'Lehengas' }, categories, 'fixture', { structure, attributes: suggestionAttributes(structure, categories) }).suggestion;
  assert.equal(quick.sizingMode, 'free-size'); assert.equal(quick.fabric, ''); assert.deepEqual(quick.highlights, raw.highlights);
});

test('quick add reads all selected views from approved storage and rejects oversized selections before AI', async t => {
  const previous = process.env.GEMINI_API_KEY; process.env.GEMINI_API_KEY = 'synthetic-quick-key';
  t.after(() => { if (previous === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = previous; });
  const media = require('../services/productSmartFillMedia');
  const photos = t.mock.method(media, 'readProductPhoto', async () => ({ mimeType: 'image/jpeg', buffer: Buffer.from([255, 216, 255, 1]) }));
  const provider = t.mock.method(global, 'fetch', async (_url, options) => {
    assert.equal(JSON.parse(options.body).contents[0].parts.filter(item => item.inlineData).length, 6);
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(raw) }] } }] }) };
  });
  const { analyzeQuickAddImage } = require('../services/quickAddVision.service');
  const result = await analyzeQuickAddImage({ imageUrls: Array.from({ length: 6 }, (_, index) => '/uploads/photo-' + index + '.jpg'), categories, structure });
  assert.equal(result.suggestion.sizingMode, 'free-size'); assert.equal(photos.mock.callCount(), 6); assert.equal(provider.mock.callCount(), 1);
  await assert.rejects(() => analyzeQuickAddImage({ imageUrls: Array(7).fill('/uploads/a.jpg') }), /six/);
  assert.equal(photos.mock.callCount(), 6);
});
