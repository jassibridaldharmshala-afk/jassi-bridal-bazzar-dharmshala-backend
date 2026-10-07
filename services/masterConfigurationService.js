const Configuration = require('../models/MasterConfiguration');
const Product = require('../models/Product');
const Store = require('../models/Store');
const Category = require('../models/Category');
const mongoose = require('mongoose');
const { ATTRIBUTE_TYPES, DEFAULT_STRUCTURE, INDUSTRY_IDS, getIndustryPreset } = require('../config/industryPresets');
const { assertMasterOwner } = require('../config/masterOwner');
const { ApiError } = require('../utils/apiError');
const clone = (value) => JSON.parse(JSON.stringify(value));
const bad = (message) => { throw new ApiError('VALIDATION_ERROR', message); };
const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const title = (value) => String(value || '').replace(/[-_]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
const CLIENT_PERMISSION_KEYS = Object.freeze([
  'branding', 'websiteDesign', 'content', 'catalog', 'pricing', 'inventory', 'orders', 'returns',
  'reviews', 'discounts', 'payments', 'shipping', 'social', 'reports', 'customers', 'staff', 'integrations',
]);
const SYSTEM_FILTER_KEYS = new Set(['category', 'subcategory', 'price', 'availability', 'rating', 'discount', 'delivery_availability']);
const PRODUCT_CARD_FIELDS = new Set(['name', 'price', 'originalPrice', 'discountPercentage', 'rating', 'stock', 'category', 'shortDescription']);

function safeInteger(value, fallback, min, max) {
  const number = Number(value);
  return Number.isInteger(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function cleanOptions(value, limit) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > limit) bad(`Use at most ${limit} attribute options`);
  return [...new Set(value.map((item) => text(String(item ?? ''), 100)).filter(Boolean))];
}

function cleanDefault(value, type) {
  if (value === undefined || value === null || value === '') return '';
  if (type === 'boolean') return value === true || String(value).toLowerCase() === 'true';
  if (type === 'number' || type === 'measurement' || type === 'range') return Number.isFinite(Number(value)) ? Number(value) : '';
  return text(String(value), 500);
}

function checkedDefault(value, type, options, validation, label) {
  const result = cleanDefault(value, type);
  if (result === '') return result;
  if (['dropdown', 'multi_select'].includes(type)) {
    const selected = Array.isArray(value)
      ? value.map((item) => text(String(item), 100)).filter(Boolean)
      : String(result).split(',').map((item) => item.trim()).filter(Boolean);
    if (selected.some((item) => !options.includes(item))) bad(`${label} has a default value that is not in its options`);
    return type === 'multi_select' ? selected.join(', ') : selected[0];
  }
  if (['number', 'measurement', 'range'].includes(type)) {
    if (validation.min !== undefined && result < validation.min) bad(`${label} default must be at least ${validation.min}`);
    if (validation.max !== undefined && result > validation.max) bad(`${label} default must be at most ${validation.max}`);
  }
  if (type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(String(result))) bad(`${label} needs a valid YYYY-MM-DD default date`);
  if (validation.minLength && String(result).length < validation.minLength) bad(`${label} default is shorter than its minimum length`);
  if (validation.maxLength && String(result).length > validation.maxLength) bad(`${label} default is longer than its maximum length`);
  return result;
}

function cleanValidation(value, type) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const result = {};
  if (['number', 'measurement', 'range'].includes(type)) {
    if (source.min !== undefined && Number.isFinite(Number(source.min))) result.min = Number(source.min);
    if (source.max !== undefined && Number.isFinite(Number(source.max))) result.max = Number(source.max);
    if (result.min !== undefined && result.max !== undefined && result.min > result.max) bad('Attribute minimum cannot exceed maximum');
  } else {
    if (source.minLength !== undefined) result.minLength = safeInteger(source.minLength, 0, 0, 500);
    if (source.maxLength !== undefined) result.maxLength = safeInteger(source.maxLength, 500, 1, 500);
  }
  return result;
}

function cleanCategories(value, attributes) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 150) bad('Use at most 150 category definitions');
  const keys = new Set();
  const attributeKeys = new Set(attributes.map((item) => item.key));
  const result = value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) bad('Category definitions must be objects');
    const key = text(item.key, 50).toLowerCase();
    const name = text(item.name, 80);
    const parentKey = text(item.parentKey, 50).toLowerCase();
    if (!/^[a-z][a-z0-9_]{0,49}$/.test(key) || keys.has(key) || !name) bad('Category keys must be unique lowercase identifiers');
    keys.add(key);
    const localDefinitionKeys = new Set();
    const localAttributes = Array.isArray(item.attributes) ? item.attributes.map((entry, index) => {
      if (typeof entry === 'string') {
        const inheritedKey = text(entry, 40);
        if (!attributeKeys.has(inheritedKey)) bad(`${name} refers to an unknown inherited attribute`);
        return inheritedKey;
      }
      const entryKey = text(entry?.key, 40);
      const entryLabel = text(entry?.label, 80);
      const type = ATTRIBUTE_TYPES.includes(entry?.type) ? entry.type : 'text';
      if (!/^[a-z][a-z0-9_]{0,39}$/.test(entryKey) || ['constructor', 'prototype', '__proto__'].includes(entryKey) || !entryLabel || localDefinitionKeys.has(entryKey)) bad(`${name} has an invalid or duplicate attribute definition`);
      localDefinitionKeys.add(entryKey);
      const options = cleanOptions(entry.options, 100);
      if (['dropdown', 'multi_select'].includes(type) && !options.length) bad(`${name} ${entryLabel} needs at least one option`);
      const validation = cleanValidation(entry.validation, type);
      return {
        key: entryKey, label: entryLabel, type, unit: text(entry.unit, 20), required: entry.required === true,
        filterable: entry.filterable === true, searchable: entry.searchable !== false, showOnCard: entry.showOnCard === true,
        showOnDetail: entry.showOnDetail !== false, showInSpecifications: entry.showInSpecifications !== false,
        variant: entry.variant === true, options, defaultValue: checkedDefault(entry.defaultValue, type, options, validation, entryLabel),
        sortOrder: safeInteger(entry.sortOrder, attributes.length + index + 1, 0, 1000), group: text(entry.group, 60) || 'Specifications',
        validation,
      };
    }).filter(Boolean) : [];
    const localKeys = new Set(localAttributes.map((entry) => typeof entry === 'string' ? entry : entry.key));
    const variants = cleanOptions(item.variantAttributes, 6);
    if (variants.some((entry) => !attributeKeys.has(entry) && !localKeys.has(entry))) bad(`${name} contains an unknown variant attribute`);
    return { key, name, parentKey, active: item.active !== false, attributes: localAttributes, variantAttributes: variants, filters: cleanOptions(item.filters, 30) };
  });
  if (result.some((item) => item.parentKey && !keys.has(item.parentKey))) bad('Every subcategory parent must exist in the same industry');
  result.forEach((item) => {
    const visited = new Set([item.key]);
    let parentKey = item.parentKey;
    while (parentKey) {
      if (visited.has(parentKey)) bad('Category inheritance cannot contain a cycle');
      visited.add(parentKey);
      parentKey = result.find((candidate) => candidate.key === parentKey)?.parentKey || '';
    }
  });
  const configuredKeys = new Set([...attributeKeys, ...result.flatMap((item) => (item.attributes || []).map((entry) => typeof entry === 'string' ? entry : entry.key))]);
  result.forEach((item) => {
    if ((item.filters || []).some((key) => !configuredKeys.has(key) && !SYSTEM_FILTER_KEYS.has(key))) bad(`${item.name} contains an unknown filter key`);
  });
  return result;
}

function cleanFilters(value, attributes, categories = []) {
  const fallback = ['category', 'price', ...attributes.filter((item) => item.filterable).map((item) => item.key), 'availability'];
  const list = value === undefined ? fallback : value;
  if (!Array.isArray(list) || list.length > 40) bad('Use at most 40 catalog filters');
  const seen = new Set();
  const allowed = new Set([
    ...attributes.map((item) => item.key),
    ...categories.flatMap((item) => (item.attributes || []).map((entry) => typeof entry === 'string' ? entry : entry.key)),
  ]);
  return list.map((item) => {
    const raw = typeof item === 'string' ? { key: item } : item;
    const key = text(raw?.key, 40).toLowerCase();
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(key) || seen.has(key)) bad('Filter keys must be unique lowercase identifiers');
    if (!SYSTEM_FILTER_KEYS.has(key) && !allowed.has(key)) bad(`${title(key)} filter does not match a configured product attribute`);
    seen.add(key);
    return { key, label: text(raw.label, 80) || title(key), type: text(raw.type, 30) || 'value', enabled: raw.enabled !== false };
  });
}

function cleanNamedList(value, fallback = [], limit, label) {
  const list = value === undefined ? fallback : value;
  if (!Array.isArray(list) || list.length > limit) bad(`Use at most ${limit} ${label}`);
  const seen = new Set();
  return list.map((item) => {
    const raw = typeof item === 'string' ? { key: item } : item;
    const key = text(raw?.key, 40);
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/.test(key) || seen.has(key)) bad(`${title(label)} need unique safe keys`);
    seen.add(key);
    return { key, label: text(raw.label, 80) || title(key) };
  });
}

function cleanVariantConfig(value, attributes) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const allowed = new Set(attributes.filter((item) => item.variant).map((item) => item.key));
  const selected = cleanOptions(source.attributes, 6);
  if (selected.some((key) => !allowed.has(key))) bad('Variant configuration can only use attributes marked as variant attributes');
  return {
    enabled: source.enabled === true && selected.length > 0,
    attributes: selected,
    autoGenerate: false,
    maxCombinations: safeInteger(source.maxCombinations, 120, 1, 250),
    skuPattern: text(source.skuPattern, 80) || '{base}-{options}',
  };
}

function cleanProductCard(value, attributes) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const allowed = new Set(attributes.map((item) => item.key));
  const fields = cleanOptions(source.fields === undefined ? ['name', 'price', 'discountPercentage'] : source.fields, 8);
  const attributeKeys = cleanOptions(source.attributeKeys === undefined ? attributes.filter((item) => item.showOnCard).map((item) => item.key) : source.attributeKeys, 4);
  if (fields.some((key) => !PRODUCT_CARD_FIELDS.has(key))) bad('Product card contains an unknown core field');
  if (attributeKeys.some((key) => !allowed.has(key))) bad('Product card contains an unknown attribute');
  return { fields, attributeKeys };
}

function cleanInventory(value, variantEnabled) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const mode = ['product', 'variant', 'batch'].includes(source.mode) ? source.mode : variantEnabled ? 'variant' : 'product';
  return { mode, trackExpiry: source.trackExpiry === true, allowBackorder: source.allowBackorder === true, lowStockDefault: safeInteger(source.lowStockDefault, 5, 0, 100000) };
}

function cleanBooleans(value, keys, defaults = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries(keys.map((key) => [key, source[key] === undefined ? defaults[key] === true : source[key] === true]));
}

function cleanReturns(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return { mode: ['return', 'replacement', 'non-returnable'].includes(source.mode) ? source.mode : 'return', defaultWindowDays: safeInteger(source.defaultWindowDays, 7, 0, 90), nonReturnableWhenCustomized: source.nonReturnableWhenCustomized === true };
}

function cleanSeo(value, attributes) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const allowed = new Set(attributes.map((item) => item.key));
  const descriptionAttributes = cleanOptions(source.descriptionAttributes, 10);
  if (descriptionAttributes.some((key) => !allowed.has(key))) bad('SEO description contains an unknown attribute');
  return { titlePattern: text(source.titlePattern, 120) || '{product} | {store}', descriptionAttributes };
}

function validateStructure(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) bad('A valid store structure is required');
  const industry = text(input.industry, 40).toLowerCase();
  if (!/^[a-z][a-z0-9_-]{1,39}$/.test(industry)) bad('Industry keys must be lowercase identifiers');
  if (!Array.isArray(input.attributes) || input.attributes.length > 80) bad('Use at most 80 product attributes');
  const keys = new Set();
  const attributes = input.attributes.map((item, index) => {
    const key = text(item?.key, 40);
    const label = text(item?.label, 80);
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(key) || ['constructor', 'prototype', '__proto__'].includes(key) || keys.has(key) || !label) bad('Attribute keys must be unique lowercase identifiers and have labels');
    keys.add(key);
    if (item.required !== undefined && typeof item.required !== 'boolean') bad('Attribute required must be true or false');
    const type = ATTRIBUTE_TYPES.includes(item.type) ? item.type : 'text';
    const options = cleanOptions(item.options, 100);
    if (type === 'dropdown' && item.options !== undefined && !options.length) bad(`${label} needs at least one option`);
    const validation = cleanValidation(item.validation, type);
    return {
      key, label, type, unit: text(item.unit, 20), required: item.required === true,
      filterable: item.filterable === true, searchable: item.searchable !== false,
      showOnCard: item.showOnCard === true, showOnDetail: item.showOnDetail !== false,
      showInSpecifications: item.showInSpecifications !== false, variant: item.variant === true,
      options, defaultValue: checkedDefault(item.defaultValue, type, options, validation, label), sortOrder: safeInteger(item.sortOrder, index + 1, 0, 1000),
      group: text(item.group, 60) || 'Specifications', validation,
    };
  });
  for (const key of ['sizing', 'specifications']) if (typeof input.features?.[key] !== 'boolean') bad('Choose valid feature switches');
  if (!input.features.specifications) bad('Product specifications must remain enabled for configured attributes');
  const builtin = INDUSTRY_IDS.includes(industry) ? getIndustryPreset(industry) : null;
  if (builtin && !builtin.features.sizing && input.features.sizing) bad('Size selection is not enabled for this industry');
  if (input.clientPermissions !== undefined && (!input.clientPermissions || typeof input.clientPermissions !== 'object' || Array.isArray(input.clientPermissions))) bad('Choose valid client permissions');
  for (const key of CLIENT_PERMISSION_KEYS) {
    if (input.clientPermissions?.[key] !== undefined && typeof input.clientPermissions[key] !== 'boolean') bad(`${title(key)} permission must be true or false`);
  }
  const selectedPreset = builtin || input;
  const shortList = (value, fallback, label) => {
    const list = value === undefined ? fallback : value;
    if (!Array.isArray(list) || list.length > 30) bad(`Use at most 30 ${label}`);
    return [...new Set(list.map((item) => text(item, 80)).filter(Boolean))];
  };
  const categoryDefinitions = cleanCategories(input.categoryDefinitions === undefined ? selectedPreset.categoryDefinitions : input.categoryDefinitions, attributes);
  const filters = cleanFilters(input.filters === undefined ? selectedPreset.filters : input.filters, attributes, categoryDefinitions);
  const variantConfig = cleanVariantConfig(input.variantConfig === undefined ? selectedPreset.variantConfig : input.variantConfig, attributes);
  const commerce = input.commerce || selectedPreset.commerce || { mode: 'SALE_ONLY' };
  if (!commerce || Array.isArray(commerce) || !['SALE_ONLY', 'RENTAL_ONLY', 'SALE_AND_RENTAL'].includes(commerce.mode)) bad('Choose a valid sale/rental business mode');
  return {
    id: text(input.id, 40) || industry,
    name: text(input.name, 80) || title(industry),
    industry,
    version: Math.max(2, safeInteger(input.version, 2, 1, 100000)),
    active: input.active !== false,
    commerce: { mode: commerce.mode, rentalModuleVersion: 1, stockMode: 'SEPARATE_RENTAL_ASSETS' },
    attributes,
    features: {
      sizing: input.features.sizing, specifications: input.features.specifications,
      comparison: input.features.comparison === true, perishable: input.features.perishable === true,
      customization: input.features.customization === true, technical: input.features.technical === true,
    },
    clientPermissions: Object.fromEntries(CLIENT_PERMISSION_KEYS.map((key) => [key, input.clientPermissions?.[key] === undefined ? true : input.clientPermissions[key] === true])),
    defaultCategories: shortList(input.defaultCategories, selectedPreset.defaultCategories, 'starter categories'),
    categoryDefinitions,
    filters,
    sortingOptions: cleanNamedList(input.sortingOptions, selectedPreset.sortingOptions, 12, 'sorting options'),
    measurementUnits: shortList(input.measurementUnits, selectedPreset.measurementUnits || [], 'measurement units'),
    variantConfig,
    productSections: shortList(input.productSections, selectedPreset.productSections || ['overview', 'specifications'], 'product sections'),
    productCard: cleanProductCard(input.productCard, attributes),
    inventory: cleanInventory(input.inventory, variantConfig.enabled),
    delivery: cleanBooleans(input.delivery, ['requiresWeight', 'supportsScheduledDelivery', 'supportsLocalOnly'], { requiresWeight: true }),
    returns: cleanReturns(input.returns),
    seo: cleanSeo(input.seo, attributes),
    homepageSections: shortList(input.homepageSections, selectedPreset.homepageSections, 'homepage sections'),
    recommendationGroups: shortList(input.recommendationGroups, selectedPreset.recommendationGroups || [], 'recommendation groups'),
    badges: shortList(input.badges, selectedPreset.badges || [], 'product badges'),
  };
}
async function readConfiguration(storeId) {
  if (storeId) {
    const store = await Store.findById(storeId).select('industry catalogStructure industryLocked industryRevision').lean();
    if (store) {
      const base = store.catalogStructure || { ...clone(getIndustryPreset(store.industry)), clientPermissions: { content: true, payments: true } };
      return {
        _id: `store:${storeId}`,
        structure: validateStructure(base),
        revision: Number(store.industryRevision || 0),
        locked: store.industryLocked !== false,
        history: [],
      };
    }
  }
  return await Configuration.findById('store').lean() || { _id: 'store', structure: clone(DEFAULT_STRUCTURE), revision: 0, locked: true, history: [] };
}
async function ensureConfiguration() {
  return Configuration.findOneAndUpdate({ _id: 'store' }, { $setOnInsert: { structure: clone(DEFAULT_STRUCTURE), locked: true, revision: 0 } }, { upsert: true, new: true });
}
async function updateConfiguration(user, { revision, structure, locked, note = '', confirmIndustryChange = false }) {
  assertMasterOwner(user);
  if (!Number.isInteger(revision) || revision < 0) bad('The current configuration revision is required');
  await ensureConfiguration();
  const before = await readConfiguration();
  if (revision !== before.revision) throw new ApiError('DUPLICATE_REQUEST', 'Configuration changed in another session. Reload before continuing.');
  const changingStructure = structure !== undefined;
  if (changingStructure && before.locked) throw new ApiError('FORBIDDEN', 'Unlock the configuration before changing its structure');
  if (changingStructure && locked !== undefined) bad('Save changes and lock as separate actions');
  if (!changingStructure && typeof locked !== 'boolean') bad('Choose a lock action or provide a structure');
  const next = changingStructure ? validateStructure(structure) : before.structure;
  if (changingStructure) next.version = Math.max(Number(before.structure?.version || 1) + 1, Number(next.version || 2));
  if (changingStructure) {
    const changingIndustry = next.industry !== before.structure.industry || next.features.sizing !== before.structure.features.sizing;
    if (changingIndustry && confirmIndustryChange !== true && await Product.exists({ storeId: null, isArchived: { $ne: true } })) {
      bad('This store contains products. Export/review the catalog and archive incompatible products before conversion. Products and orders are never deleted automatically.');
    }
    const changedKeys = before.structure.attributes.filter((field) =>
      JSON.stringify(next.attributes.find((item) => item.key === field.key)) !== JSON.stringify(field)).map((item) => item.key);
    if (!changingIndustry && changedKeys.length && await Product.exists({ storeId: null, 'specifications.key': { $in: changedKeys }, isArchived: { $ne: true } })) {
      bad('An attribute being changed is used by products. Migrate those product values before changing or removing its definition.');
    }
  }
  // Keep only a small compatibility trail here. Full immutable snapshots live in
  // MasterConfigurationVersion so this singleton cannot grow on every publish.
  const event = { revision: before.revision, locked: before.locked, at: new Date(), actor: String(user._id), note: text(note, 240) || (changingStructure ? 'Structure updated' : locked ? 'Configuration locked' : 'Configuration unlocked') };
  const saved = await Configuration.findOneAndUpdate({ _id: 'store', revision }, {
    $set: { structure: next, locked: changingStructure ? false : locked, updatedBy: user._id },
    $inc: { revision: 1 }, $push: { history: { $each: [event], $slice: -30 } },
  }, { new: true, runValidators: true });
  if (!saved) throw new ApiError('DUPLICATE_REQUEST', 'Configuration changed while saving. Reload and review it.');
  return saved;
}
function publicStructure(config) {
  const { clientPermissions: _private, ...structure } = config.structure;
  return { ...structure, revision: config.revision };
}
async function applyProductStructure(payload, existing = {}) {
  const configuration = await readConfiguration(payload?.storeId || existing?.storeId);
  const { structure } = configuration;
  const values = payload.attributeValues ?? existing.attributeValues ?? {};
  const source = values instanceof Map ? Object.fromEntries(values) : values;
  const oldValues = existing.attributeValues instanceof Map ? Object.fromEntries(existing.attributeValues) : (existing.attributeValues || {});
  if (!source || typeof source !== 'object' || Array.isArray(source)) bad('Attribute values must be an object');
  const selectedCategoryId = payload.category || existing.category;
  const activeStoreId = payload?.storeId || existing?.storeId;
  const selectedCategory = selectedCategoryId && mongoose.isValidObjectId(selectedCategoryId)
    ? await Category.findOne({ _id: selectedCategoryId, ...(activeStoreId ? { storeId: activeStoreId } : {}) }).select('definitionKey name').lean()
    : null;
  const requestedSubcategory = String(payload.subCategory ?? existing.subCategory ?? '').trim().toLowerCase();
  const requestedKey = text(payload.categoryDefinitionKey || existing.categoryDefinitionKey || selectedCategory?.definitionKey || selectedCategory?.name || requestedSubcategory, 50).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const categoryDefinition = (structure.categoryDefinitions || []).find((item) => requestedSubcategory && (
    item.key === requestedSubcategory.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
    || item.name.toLowerCase() === requestedSubcategory
  )) || (structure.categoryDefinitions || []).find((item) => item.key === requestedKey);
  const definitionKey = categoryDefinition?.key || requestedKey;
  const definitions = [...structure.attributes];
  const categoryChain = [];
  let cursor = categoryDefinition;
  while (cursor && categoryChain.length < 12) {
    categoryChain.unshift(cursor);
    cursor = cursor.parentKey ? (structure.categoryDefinitions || []).find((item) => item.key === cursor.parentKey) : null;
  }
  for (const layer of categoryChain) {
    for (const item of layer.attributes || []) {
      if (typeof item !== 'object' || !item.key) continue;
      const index = definitions.findIndex((definition) => definition.key === item.key);
      if (index >= 0) definitions[index] = { ...definitions[index], ...item };
      else definitions.push(item);
    }
  }
  const keys = new Set(definitions.map((item) => item.key));
  const protectedLegacyKeys = new Set(Object.keys(oldValues).filter((key) => !keys.has(key)));
  if (Object.keys(source).some((key) => !keys.has(key) && !protectedLegacyKeys.has(key))) bad('Only configured product attributes can be edited');
  for (const key of protectedLegacyKeys) {
    if (source[key] !== undefined && String(source[key]) !== String(oldValues[key])) bad('Inactive legacy attributes are read-only until migrated');
  }
  const attributeValues = {};
  const specifications = [];
  for (const definition of definitions.sort((left, right) => left.sortOrder - right.sortOrder)) {
    const value = source[definition.key];
    const cleaned = validateAttributeValue(definition, value);
    if (definition.required && !cleaned) bad(`Enter ${definition.label}`);
    if (cleaned !== '') {
      attributeValues[definition.key] = cleaned;
      if (definition.showInSpecifications !== false || definition.showOnDetail !== false) specifications.push({
        key: definition.key, label: definition.label, value: cleaned, unit: definition.unit,
        group: definition.group, active: true, showOnDetail: definition.showOnDetail !== false,
      });
    }
  }
  const oldSpecs = Array.isArray(existing.specifications) ? existing.specifications : [];
  for (const key of protectedLegacyKeys) {
    const value = String(oldValues[key] ?? '').trim();
    if (!value) continue;
    attributeValues[key] = value;
    const previous = oldSpecs.find((item) => item.key === key);
    specifications.push({ key, label: previous?.label || title(key), value, unit: previous?.unit || '', group: 'Legacy data', active: false, showOnDetail: false });
  }
  const next = {
    ...payload, attributeValues, specifications, industry: structure.industry,
    industryRevision: configuration.revision, categoryDefinitionKey: categoryDefinition?.key || definitionKey,
  };
  if (structure.inventory?.trackExpiry && attributeValues.expiry_date) next.expiryDate = attributeValues.expiry_date;
  if (structure.inventory?.mode === 'batch' && attributeValues.batch_number) next.batchNumber = attributeValues.batch_number;
  if (!structure.features.sizing) Object.assign(next, { sizingMode: 'free-size', sizeChartProfile: 'free-size', sizes: [], sizeChart: { unit: 'in', columns: [], rows: [] } });
  const inheritedVariantKeys = categoryChain.flatMap((item) => item.variantAttributes || []);
  const variantKeys = new Set(inheritedVariantKeys.length ? inheritedVariantKeys : (structure.variantConfig?.attributes || []));
  if (Array.isArray(payload.variants) && payload.variants.length && !structure.features.sizing) {
    const seen = new Set();
    payload.variants.forEach((variant) => {
      const optionValues = variant?.optionValues instanceof Map ? Object.fromEntries(variant.optionValues) : { ...(variant?.optionValues || {}) };
      if (variant?.size && !optionValues.size) optionValues.size = variant.size;
      if (variant?.color && !optionValues.colour && !optionValues.color) optionValues.colour = variant.color;
      const optionKeys = Object.keys(optionValues);
      if (optionKeys.some((key) => !variantKeys.has(key))) bad('A product variant uses an option that is not enabled for this category');
      if (variantKeys.size && Array.from(variantKeys).some((key) => !String(optionValues[key] ?? '').trim())) bad('Every product variant must include all configured option values');
      const combination = Array.from(variantKeys).sort().map((key) => `${key}:${String(optionValues[key] || '').trim().toLowerCase()}`).join('|');
      if (seen.has(combination)) bad('Product variant combinations must be unique');
      seen.add(combination);
    });
  }
  if (!structure.variantConfig?.enabled && !inheritedVariantKeys.length) {
    const unchangedLegacy = Array.isArray(existing.variants) && JSON.stringify(payload.variants || []) === JSON.stringify(existing.variants || []);
    if (unchangedLegacy) delete next.variants;
    else next.variants = [];
  }
  return next;
}

function validateAttributeValue(definition, raw) {
  if (raw === undefined || raw === null || raw === '') return '';
  const values = Array.isArray(raw) ? raw : definition.type === 'multi_select' ? String(raw).split(',') : [raw];
  if (values.some((value) => !['string', 'number', 'boolean'].includes(typeof value))) bad(`${definition.label} has an invalid value`);
  if (definition.type === 'boolean') {
    const normalized = String(values[0]).toLowerCase();
    if (!['true', 'false', 'yes', 'no'].includes(normalized)) bad(`${definition.label} must be Yes or No`);
    return ['true', 'yes'].includes(normalized) ? 'Yes' : 'No';
  }
  const cleanedValues = values.map((value) => String(value).trim()).filter(Boolean);
  const cleaned = cleanedValues.join(', ');
  if (cleaned.length > 500) bad(`Keep ${definition.label} under 500 characters`);
  if (['number', 'measurement', 'range'].includes(definition.type)) {
    const number = Number(cleaned);
    if (!Number.isFinite(number)) bad(`${definition.label} must be a valid number`);
    if (definition.validation?.min !== undefined && number < definition.validation.min) bad(`${definition.label} must be at least ${definition.validation.min}`);
    if (definition.validation?.max !== undefined && number > definition.validation.max) bad(`${definition.label} must be at most ${definition.validation.max}`);
  }
  if (definition.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) bad(`${definition.label} must be a valid date`);
  if (definition.options?.length && ['dropdown', 'multi_select'].includes(definition.type) && cleanedValues.some((value) => !definition.options.includes(value))) bad(`Choose a valid ${definition.label}`);
  if (definition.validation?.minLength && cleaned.length < definition.validation.minLength) bad(`${definition.label} is too short`);
  if (definition.validation?.maxLength && cleaned.length > definition.validation.maxLength) bad(`${definition.label} is too long`);
  return cleaned;
}
module.exports = { validateStructure, readConfiguration, updateConfiguration, publicStructure, applyProductStructure };
