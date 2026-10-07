const SIZE_CHART_PROFILES = {
  'kurta-set': ['bust', 'chest', 'frontLength', 'bottomLength', 'waist', 'sleeveLength', 'hips', 'acrossShoulder', 'outseamLength', 'inseamLength'],
  kurti: ['bust', 'chest', 'waist', 'frontLength', 'hips', 'acrossShoulder'],
  dress: ['acrossShoulder', 'sleeveLength', 'bust', 'waist', 'frontLength', 'hips'],
  'top-shirt': ['acrossShoulder', 'sleeveLength', 'bust', 'chest', 'waist', 'frontLength'],
  bottom: ['waist', 'hips', 'outseamLength', 'inseamLength', 'bottomLength'],
  'skirt-lehenga': ['waist', 'hips', 'bottomLength'],
  jumpsuit: ['acrossShoulder', 'sleeveLength', 'bust', 'waist', 'hips', 'frontLength', 'outseamLength', 'inseamLength'],
  apparel: ['bust', 'chest', 'waist', 'hips', 'acrossShoulder', 'sleeveLength', 'frontLength'],
};

const NON_SIZED_TERMS = [
  'saree', 'sari', 'dupatta', 'stole', 'scarf', 'shawl', 'jewellery', 'jewelry',
  'earring', 'necklace', 'bracelet', 'bangle', 'handbag', 'clutch', 'purse', 'accessor',
];

function normalizeProductSizing(payload = {}, categoryName = '') {
  const next = { ...payload };
  if (!Object.prototype.hasOwnProperty.call(payload, 'sizeChart')
    && !Object.prototype.hasOwnProperty.call(payload, 'sizingMode')
    && !Object.prototype.hasOwnProperty.call(payload, 'sizeChartProfile')) return next;
  const profile = inferProfile(next, categoryName);
  const mode = resolveMode(next, profile);

  if (mode === 'free-size') {
    next.sizes = [];
    next.variants = [];
    next.sizeChart = { unit: 'in', columns: [], rows: [] };
    return next;
  }

  const sizes = uniqueStrings(next.sizes).filter((size) => !/^free\s*size$/i.test(size));
  const fields = SIZE_CHART_PROFILES[profile] || SIZE_CHART_PROFILES.apparel;
  const sourceRows = new Map((Array.isArray(next.sizeChart?.rows) ? next.sizeChart.rows : [])
    .map((row) => [String(row?.size || '').trim().toLowerCase(), row]));
  next.sizes = sizes;
  next.sizeChart = {
    unit: next.sizeChart?.unit === 'cm' ? 'cm' : 'in',
    columns: fields,
    rows: sizes.map((size) => {
      const source = sourceRows.get(size.toLowerCase()) || {};
      const row = { size };
      fields.forEach((field) => {
        const value = Number(source[field]);
        if (Number.isFinite(value) && value > 0) row[field] = value;
      });
      return row;
    }),
  };
  return next;
}

function validateProductSizing(payload = {}, categoryName = '') {
  if (!Object.prototype.hasOwnProperty.call(payload, 'sizeChart')
    && !Object.prototype.hasOwnProperty.call(payload, 'sizingMode')
    && !Object.prototype.hasOwnProperty.call(payload, 'sizeChartProfile')) return '';

  const normalized = normalizeProductSizing(payload, categoryName);
  const profile = inferProfile(normalized, categoryName);
  if (resolveMode(normalized, profile) === 'free-size') return '';
  if (!normalized.sizes.length) return 'At least one selectable size is required for this product';

  const fields = SIZE_CHART_PROFILES[profile] || SIZE_CHART_PROFILES.apparel;
  for (const size of normalized.sizes) {
    const row = normalized.sizeChart.rows.find((item) => item.size === size);
    const missingField = fields.find((field) => !(Number(row?.[field]) > 0));
    if (missingField) return `Complete the size chart before saving. ${size} is missing ${humanize(missingField)}.`;
  }
  return '';
}

function inferProfile(product = {}, categoryName = '') {
  const explicit = String(product.sizeChartProfile || '').trim();
  if (explicit && explicit !== 'auto' && (explicit === 'free-size' || SIZE_CHART_PROFILES[explicit])) return explicit;
  const category = typeof product.category === 'object' ? product.category?.name : product.category;
  const text = [categoryName, category, product.subCategory, product.name, product.productType]
    .map((value) => String(value || '').toLowerCase()).join(' ');
  if (NON_SIZED_TERMS.some((term) => text.includes(term))) return 'free-size';
  if (/(jumpsuit|romper)/.test(text)) return 'jumpsuit';
  if (/(kurta set|kurti set|ethnic set|suit set|\bsuits?\b|salwar|co-?ord)/.test(text)) return 'kurta-set';
  if (/(short kurti|short kurta|kurti|kurta|tunic)/.test(text)) return 'kurti';
  if (/(dress|gown|maxi|frock)/.test(text)) return 'dress';
  if (/(pant|trouser|palazzo|legging|jogger|bottom|jean)/.test(text)) return 'bottom';
  if (/(skirt|lehenga)/.test(text)) return 'skirt-lehenga';
  if (/(shirt|top|blouse|choli|tee|t-shirt)/.test(text)) return 'top-shirt';
  return 'apparel';
}

function resolveMode(product, profile = inferProfile(product)) {
  if (product.sizingMode === 'sized') return 'sized';
  if (product.sizingMode === 'free-size') return 'free-size';
  return profile === 'free-size' ? 'free-size' : 'sized';
}

// Purchase validation must use the same category-aware rule as the product
// response and storefront. Legacy records can still contain sizes in auto mode.
function resolveProductSizingMode(product = {}, categoryName = '') {
  return resolveMode(product, inferProfile(product, categoryName));
}

function getSelectableProductSizes(product = {}, categoryName = '') {
  if (resolveProductSizingMode(product, categoryName) !== 'sized') return [];
  return uniqueStrings(product.sizes).filter((size) => !/^free\s*size$/i.test(size));
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || '').trim()).filter(Boolean))];
}

function humanize(value) {
  return String(value).replace(/([A-Z])/g, ' $1').trim().toLowerCase();
}

module.exports = { SIZE_CHART_PROFILES, inferProfile, normalizeProductSizing, validateProductSizing, resolveProductSizingMode, getSelectableProductSizes };
