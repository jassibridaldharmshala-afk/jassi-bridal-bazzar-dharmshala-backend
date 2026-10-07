const fs = require('fs');
const path = require('path');
const { generateGeminiJson } = require('./geminiJson.service');

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

function isVisionEnabled() {
  return Boolean(String(process.env.GEMINI_API_KEY || '').trim());
}

function mimeFromName(name = '') {
  const ext = path.extname(String(name)).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/jpeg';
}

function localUploadPath(imageUrl = '') {
  const raw = String(imageUrl || '').split('?')[0];
  const match = raw.match(/\/uploads\/([^/?#]+)$/i);
  if (!match) return '';
  return path.join(__dirname, '..', 'uploads', match[1]);
}

function readImageFile(filePath = '') {
  const resolved = path.resolve(String(filePath || ''));
  if (!resolved || !fs.existsSync(resolved)) throw new Error('Product image could not be read');
  const buffer = fs.readFileSync(resolved);
  if (!buffer.length) throw new Error('Product image is empty');
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error('Image is too large to analyze');
  return { mimeType: mimeFromName(resolved), data: buffer.toString('base64') };
}

function resolveFetchUrl(imageUrl = '') {
  const raw = String(imageUrl || '').trim();
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;

  // Prefer the running local API for relative /uploads paths.
  // PUBLIC_API_URL may point at production and would fail for local files.
  const localOrigin = `http://127.0.0.1:${process.env.SERVER_PORT || 5000}`;
  const configured = String(process.env.PUBLIC_API_URL || '').replace(/\/$/, '');
  const origin = /localhost|127\.0\.0\.1/i.test(configured) || !configured ? (configured || localOrigin) : localOrigin;
  return `${origin}${raw.startsWith('/') ? '' : '/'}${raw}`;
}

async function readImage(imageUrl = '') {
  const raw = String(imageUrl || '').trim();
  if (!raw) throw new Error('Image is required');

  const diskPath = localUploadPath(raw);
  if (diskPath && fs.existsSync(diskPath)) {
    const buffer = fs.readFileSync(diskPath);
    if (buffer.length > MAX_IMAGE_BYTES) throw new Error('Image is too large to analyze');
    return { mimeType: mimeFromName(diskPath), data: buffer.toString('base64') };
  }

  const absolute = resolveFetchUrl(raw);
  const response = await fetch(absolute, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error('Could not read the uploaded photo');
  const mimeType = (response.headers.get('content-type') || mimeFromName(absolute)).split(';')[0];
  if (!mimeType.startsWith('image/')) throw new Error('Only product photos can be analyzed');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error('Image is too large to analyze');
  return { mimeType, data: buffer.toString('base64') };
}

function clip(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function asList(value) {
  const items = Array.isArray(value) ? value : String(value || '').split(',');
  return items.map((item) => clip(item, 40)).filter(Boolean).slice(0, 8);
}

function buildPrompt(categories, subcategories, imageCount = 1) {
  const categoryNames = categories.map((item) => item.name).filter(Boolean).slice(0, 40);
  return [
    'You are a fashion catalog assistant for an Indian clothing boutique (sarees, lehengas, suits, kurtis, gowns, tops, skirts, jumpsuits).',
    `Look carefully at the ${imageCount > 1 ? `${imageCount} photos of the same product` : 'product photo'}. Identify the garment from what you see — do not use any filename.`,
    'Return JSON only.',
    'Rules:',
    '- name: short shoppable title from what is visible (color + garment type + notable detail). Example: "Wine Embroidered Anarkali Suit".',
    '- categoryName: pick the closest match from the store category list when possible.',
    '- subCategory: only if it clearly fits a listed subcategory, otherwise empty.',
    '- colors: visible garment colors only.',
    '- pattern: visible pattern or surface work such as embroidered, floral, solid, printed, zari, sequinned. Leave empty if unclear.',
    '- fabric: only if visually likely (silk sheen, cotton weave, georgette drape). Leave empty if unsure.',
    '- occasion: only if styling clearly suggests one (wedding, festive, casual, party). Leave empty if unsure.',
    '- tags: 2-6 short searchable words from what you see.',
    '- shortDescription: one line for the product card.',
    '- description: 1-2 sentences describing the visible garment. No invented care claims, no price, no stock.',
    '- confidence values must be numbers from 0 to 1. Use a lower score whenever a detail is uncertain.',
    '- Never guess price, stock, SKU, measurements or which sizes are available.',
    `Store categories: ${categoryNames.join(', ') || 'none'}.`,
    `Known subcategories: ${(subcategories || []).slice(0, 40).join(', ') || 'none'}.`,
    'JSON shape: {"name":"","categoryName":"","subCategory":"","colors":[],"pattern":"","fabric":"","occasion":"","tags":[],"shortDescription":"","description":"","confidence":{"name":0,"category":0,"color":0,"pattern":0,"fabric":0,"occasion":0,"overall":0}}',
  ].join(' ');
}

async function callGemini({ images, categories, subcategories }) {
  const safeImages = (Array.isArray(images) ? images : []).filter(Boolean).slice(0, 3);
  const prompt = buildPrompt(categories, subcategories, safeImages.length);
  return generateGeminiJson({
    parts: [{ text: prompt }, ...safeImages.map(image => ({ inlineData: { mimeType: image.mimeType, data: image.data } }))],
    timeoutMs: 25000, temperature: 0.2,
  });
}

function matchCategory(categories, categoryName) {
  const needle = clip(categoryName, 80).toLowerCase();
  if (!needle) return null;
  return categories.find((item) => clip(item.name, 80).toLowerCase() === needle)
    || categories.find((item) => {
      const name = clip(item.name, 80).toLowerCase();
      return name.length >= 3 && (needle.includes(name) || name.includes(needle));
    })
    || null;
}

function confidenceValue(value, fallback = 0) {
  let number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  if (number > 1 && number <= 100) number /= 100;
  return Math.max(0, Math.min(1, Math.round(number * 100) / 100));
}

function inferSizingMode(categoryName = '', name = '') {
  const garment = `${categoryName} ${name}`.toLowerCase();
  if (/\b(saree|dupatta|stole|scarf)\b/.test(garment)) return 'free-size';
  if (/\b(kurti|kurta|suit|dress|gown|lehenga|skirt|top|shirt|jumpsuit|pant|trouser)\b/.test(garment)) return 'sized';
  return 'confirm';
}

function normalizeVisionSuggestion(raw = {}, safeCategories = [], model = '') {
  const matched = matchCategory(safeCategories, raw.categoryName);
  const name = clip(raw.name, 120);
  if (!name) {
    throw new Error('Could not identify this garment from the photo. Try a clearer front-facing product shot.');
  }
  const colors = asList(raw.colors);
  const rawConfidence = raw.confidence && typeof raw.confidence === 'object' ? raw.confidence : {};
  const knownScores = [
    confidenceValue(rawConfidence.name, name ? 0.7 : 0),
    confidenceValue(rawConfidence.category, matched ? 0.7 : 0),
    confidenceValue(rawConfidence.color, colors.length ? 0.7 : 0),
    confidenceValue(rawConfidence.pattern, raw.pattern ? 0.65 : 0),
    confidenceValue(rawConfidence.fabric, raw.fabric ? 0.55 : 0),
    confidenceValue(rawConfidence.occasion, raw.occasion ? 0.55 : 0),
  ].filter((score) => score > 0);
  const computedOverall = knownScores.length
    ? knownScores.reduce((sum, score) => sum + score, 0) / knownScores.length
    : 0.45;
  const confidence = {
    name: confidenceValue(rawConfidence.name, name ? 0.7 : 0),
    category: confidenceValue(rawConfidence.category, matched ? 0.7 : 0),
    primaryColor: confidenceValue(rawConfidence.color, colors.length ? 0.7 : 0),
    pattern: confidenceValue(rawConfidence.pattern, raw.pattern ? 0.65 : 0),
    fabric: confidenceValue(rawConfidence.fabric, raw.fabric ? 0.55 : 0),
    occasion: confidenceValue(rawConfidence.occasion, raw.occasion ? 0.55 : 0),
    overall: confidenceValue(rawConfidence.overall, computedOverall),
  };

  return {
    suggestion: {
      name,
      categoryId: matched?._id ? String(matched._id) : '',
      categoryName: matched?.name || '',
      subCategory: clip(raw.subCategory, 80),
      colors,
      pattern: clip(raw.pattern, 80),
      fabric: clip(raw.fabric, 80),
      occasion: clip(raw.occasion, 80),
      tags: asList(raw.tags),
      shortDescription: clip(raw.shortDescription, 200),
      description: clip(raw.description, 800),
      sizingMode: inferSizingMode(matched?.name || raw.categoryName, name),
    },
    confidence,
    analysis: {
      source: 'gemini-vision',
      model: clip(model, 80),
      analyzedAt: new Date().toISOString(),
    },
  };
}

async function analyzeImages({ images, categories = [], subcategories = [] } = {}) {
  if (!isVisionEnabled()) {
    return {
      enabled: false,
      reason: 'Smart visual suggestions are not configured on the server.',
    };
  }

  const safeCategories = (Array.isArray(categories) ? categories : [])
    .map((item) => ({ _id: item?._id, name: clip(item?.name, 80) }))
    .filter((item) => item._id && item.name)
    .slice(0, 40);
  const safeSubcategories = (Array.isArray(subcategories) ? subcategories : [])
    .map((item) => clip(item, 80))
    .filter(Boolean)
    .slice(0, 40);
  const result = await callGemini({ images, categories: safeCategories, subcategories: safeSubcategories });
  return {
    enabled: true,
    ...normalizeVisionSuggestion(result.raw, safeCategories, result.model),
  };
}

exports.isVisionEnabled = isVisionEnabled;

exports.getQuickAddVisionStatus = () => ({
  enabled: isVisionEnabled(),
  reason: isVisionEnabled()
    ? 'Photo reading is on. Upload a product photo to identify name, category, colors and details.'
    : 'Photo reading is off. Add a free GEMINI_API_KEY in backend/.env, then restart the server.',
});

exports.analyzeQuickAddImage = async ({ imageUrl, categories = [], subcategories = [] } = {}) => {
  if (!isVisionEnabled()) return analyzeImages({ images: [], categories, subcategories });
  const image = await readImage(imageUrl);
  return analyzeImages({ images: [image], categories, subcategories });
};

exports.analyzeReelCandidateImages = async ({ imageUrls = [], categories = [], subcategories = [] } = {}) => {
  if (!isVisionEnabled()) return analyzeImages({ images: [], categories, subcategories });
  const images = await Promise.all((Array.isArray(imageUrls) ? imageUrls : []).slice(0, 3).map(readImage));
  if (!images.length) throw new Error('No candidate photos are available for smart analysis.');
  return analyzeImages({ images, categories, subcategories });
};

exports.analyzeReelCandidateFiles = async ({ filePaths = [], categories = [], subcategories = [] } = {}) => {
  if (!isVisionEnabled()) return analyzeImages({ images: [], categories, subcategories });
  const images = (Array.isArray(filePaths) ? filePaths : []).slice(0, 3).map(readImageFile);
  if (!images.length) throw new Error('No candidate photos are available for smart analysis.');
  return analyzeImages({ images, categories, subcategories });
};

exports.normalizeVisionSuggestion = normalizeVisionSuggestion;
