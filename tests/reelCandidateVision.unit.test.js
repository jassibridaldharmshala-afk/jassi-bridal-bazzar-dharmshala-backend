const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeVisionSuggestion } = require('../services/quickAddVision.service');
const {
  defaultCandidateSuggestion,
  toCandidateAnalysis,
  toContextCandidateAnalysis,
  analyzeCandidateFiles,
} = require('../services/reelCandidateVision.service');

test('visual suggestions map a saree to the real category and free-size behavior', () => {
  const result = normalizeVisionSuggestion({
    name: 'Teal Zari Silk Saree',
    categoryName: 'Sarees',
    colors: ['Teal', 'Magenta'],
    pattern: 'Zari woven',
    fabric: 'Silk blend',
    occasion: 'Festive',
    tags: ['silk', 'zari', 'festive'],
    shortDescription: 'A teal saree with a magenta zari border.',
    description: 'A teal silk-look saree finished with a contrasting magenta zari border.',
    confidence: { name: 0.92, category: 92, color: 0.9, pattern: 0.81, fabric: 0.58, overall: 0.82 },
  }, [{ _id: 'category-sarees', name: 'Sarees' }], 'gemini-test');

  assert.equal(result.suggestion.categoryId, 'category-sarees');
  assert.equal(result.suggestion.sizingMode, 'free-size');
  assert.deepEqual(result.suggestion.colors, ['Teal', 'Magenta']);
  assert.equal(result.confidence.category, 0.92);
  assert.equal(result.analysis.model, 'gemini-test');
});

test('candidate mapping keeps inferred catalog data but never creates price, stock, or sizes', () => {
  const result = toCandidateAnalysis({
    enabled: true,
    suggestion: {
      name: 'Wine Embroidered Kurta Set',
      categoryId: 'category-suits',
      categoryName: 'Suits',
      colors: ['Wine', 'Gold'],
      pattern: 'Embroidered',
      fabric: 'Silk blend',
      occasion: 'Wedding',
      tags: ['wine', 'embroidered'],
      shortDescription: 'A wine kurta set with gold embroidery.',
      description: 'A coordinated wine kurta set with visible gold embroidery.',
      sizingMode: 'sized',
    },
    confidence: { name: 0.9, category: 0.8, primaryColor: 0.88, overall: 0.84 },
    analysis: { source: 'gemini-vision', model: 'gemini-test', analyzedAt: '2026-09-05T00:00:00.000Z' },
  }, 2);

  assert.equal(result.analysis.status, 'completed');
  assert.equal(result.suggestions.primaryColor, 'Wine');
  assert.deepEqual(result.suggestions.secondaryColors, ['Gold']);
  assert.equal(result.suggestions.sizingMode, 'sized');
  assert.equal(Object.hasOwn(result.suggestions, 'price'), false);
  assert.equal(Object.hasOwn(result.suggestions, 'stock'), false);
  assert.equal(Object.hasOwn(result.suggestions, 'sizes'), false);
});

test('unavailable analysis returns a review-safe candidate instead of failing the reel job', () => {
  const suggestion = defaultCandidateSuggestion(4);
  assert.equal(suggestion.name, 'Product 4');
  assert.equal(suggestion.sizingMode, 'confirm');
  assert.deepEqual(suggestion.tags, ['reel-import']);
});

test('context failures retain their actionable error code in the candidate response', () => {
  const result = toContextCandidateAnalysis({ contextStatus: 'failed', contextErrorCode: 'AI_MODEL_UNAVAILABLE', contextError: 'No available Gemini model.' }, 1);
  assert.equal(result.analysis.status, 'failed');
  assert.equal(result.analysis.errorCode, 'AI_MODEL_UNAVAILABLE');
  assert.equal(result.analysis.error, 'No available Gemini model.');
});

test('photo-only reel analysis uses supported model fallbacks and structured image requests', async (t) => {
  const previous = { key: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL };
  process.env.GEMINI_API_KEY = 'fixture-photo-only-key'; process.env.GEMINI_MODEL = 'retired-photo-model';
  t.after(() => {
    for (const [key, value] of [['GEMINI_API_KEY', previous.key], ['GEMINI_MODEL', previous.model]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const fs = require('node:fs'); const realExists = fs.existsSync; const realRead = fs.readFileSync;
  t.mock.method(fs, 'existsSync', file => String(file).endsWith('fixture-photo.jpg') || realExists(file));
  t.mock.method(fs, 'readFileSync', (file, ...args) => String(file).endsWith('fixture-photo.jpg') ? Buffer.from('synthetic image bytes') : realRead(file, ...args));
  const requested = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    requested.push(url);
    assert.ok(!url.includes('fixture-photo-only-key'));
    const body = JSON.parse(options.body);
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
    assert.equal(body.contents[0].parts[1].inlineData.mimeType, 'image/jpeg');
    if (url.includes('retired-photo-model')) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ name: 'Blue Saree', categoryName: 'Sarees', colors: ['Blue'] }) }] } }] }) };
  });
  const result = await analyzeCandidateFiles({ groupNumber: 1, filePaths: ['fixture-photo.jpg'], categories: [{ _id: 'sarees', name: 'Sarees' }] });
  assert.equal(result.analysis.status, 'completed'); assert.equal(result.suggestions.name, 'Blue Saree');
  assert.equal(result.analysis.model, 'gemini-flash-latest'); assert.equal(requested.length, 2);
  assert.equal(result.suggestions.stock, undefined); assert.equal(result.suggestions.price, undefined);
});
