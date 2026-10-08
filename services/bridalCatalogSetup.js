const { getIndustryPreset } = require('../config/industryPresets');
const slugify = require('../utils/slugify');
const { ApiError } = require('../utils/apiError');

const bridalPreset = getIndustryPreset('boutique');
const normal = (value) => String(value || '').trim().toLocaleLowerCase('en-IN');
const clone = (value) => JSON.parse(JSON.stringify(value));

function planBridalCatalog(store, existingCategories = []) {
  if (store?.industry !== 'boutique') throw new ApiError('VALIDATION_ERROR', 'Bridal setup is available for boutique stores only.');
  const structure = clone(store.catalogStructure || bridalPreset);
  const definitions = new Set((structure.categoryDefinitions || []).map((item) => item.key));
  const attributes = new Set((structure.attributes || []).map((item) => item.key));
  const categories = new Set((structure.defaultCategories || []).map(normal));
  let structureUpdated = false;
  for (const item of bridalPreset.attributes) {
    if (attributes.has(item.key)) continue;
    (structure.attributes ||= []).push(clone(item));
    attributes.add(item.key);
    structureUpdated = true;
  }
  for (const item of bridalPreset.categoryDefinitions) {
    if (definitions.has(item.key)) continue;
    (structure.categoryDefinitions ||= []).push(clone(item));
    definitions.add(item.key);
    structureUpdated = true;
  }
  for (const name of bridalPreset.defaultCategories) {
    if (categories.has(normal(name))) continue;
    (structure.defaultCategories ||= []).push(name);
    categories.add(normal(name));
    structureUpdated = true;
  }

  const roots = existingCategories.filter((item) => !item.parent);
  const missing = [], existing = [], archived = [], conflicts = [];
  for (const name of bridalPreset.defaultCategories) {
    const match = roots.find((item) => normal(item.name) === normal(name));
    if (match) {
      (match.isArchived ? archived : existing).push(name);
      continue;
    }
    const slug = store.isDefault ? slugify(name) : `${store.slug}-${slugify(name)}`;
    if (existingCategories.some((item) => item.slug === slug || item.previousSlugs?.includes(slug))) {
      conflicts.push(name);
      continue;
    }
    const definition = bridalPreset.categoryDefinitions.find((item) => item.name === name);
    missing.push({
      name, slug, storeId: store._id, definitionKey: definition?.key || '',
      parentDefinitionKey: '', attributeOverrides: definition?.attributes || [],
      variantAttributes: definition?.variantAttributes || [], configuredFilters: definition?.filters || [],
      displayOrder: Math.min(9999, roots.length + missing.length + 1),
      isActive: false, isArchived: false,
    });
  }
  return { structure, structureUpdated, missing, existing, archived, conflicts };
}

async function categoryRows(store, session) {
  const Category = require('../models/Category');
  const { defaultStoreFilter } = require('./storeService');
  const query = Category.find(store.isDefault ? defaultStoreFilter(store._id) : { storeId: store._id }).select('name slug previousSlugs parent isArchived');
  return (session ? query.session(session) : query).lean();
}

function summary(plan) {
  return {
    categories: bridalPreset.defaultCategories,
    missing: plan.missing.map((item) => item.name),
    existing: plan.existing,
    archived: plan.archived,
    conflicts: plan.conflicts,
    structureUpdated: plan.structureUpdated,
  };
}

async function previewBridalCatalog() {
  const Store = require('../models/Store');
  const store = await Store.findOne({ isDefault: true }).lean();
  if (!store) throw new ApiError('NOT_FOUND', 'Default boutique store is not available yet.');
  return summary(planBridalCatalog(store, await categoryRows(store)));
}

async function setupBridalCatalog() {
  const mongoose = require('mongoose');
  const Store = require('../models/Store');
  const Category = require('../models/Category');
  const { ensureDefaultStore } = require('./storeService');
  const { supportsTransactions } = require('../utils/transaction');
  const { validateStructure } = require('./masterConfigurationService');
  if (!(await supportsTransactions())) throw new ApiError('SERVICE_UNAVAILABLE', 'Bridal setup needs a transaction-capable database.');
  const defaultStore = await ensureDefaultStore();
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const store = await Store.findById(defaultStore._id).session(session);
      const plan = planBridalCatalog(store, await categoryRows(store, session));
      if (plan.structureUpdated) {
        validateStructure(plan.structure);
        store.catalogStructure.attributes = plan.structure.attributes;
        store.catalogStructure.categoryDefinitions = plan.structure.categoryDefinitions;
        store.catalogStructure.defaultCategories = plan.structure.defaultCategories;
        store.industryRevision = Number(store.industryRevision || 0) + 1;
        store.markModified('catalogStructure');
        await store.save({ session });
      }
      if (plan.missing.length) await Category.create(plan.missing, { session, ordered: true });
      result = { ...summary(plan), created: plan.missing.map((item) => item.name) };
    });
  } finally {
    await session.endSession();
  }
  return result;
}

module.exports = { planBridalCatalog, previewBridalCatalog, setupBridalCatalog };
