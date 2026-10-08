const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getIndustryPreset } = require('../config/industryPresets');
const { planBridalCatalog } = require('../services/bridalCatalogSetup');

test('bridal setup adds only missing hidden categories and preserves custom structure', () => {
  const preset = getIndustryPreset('boutique');
  const store = {
    _id: 'store1', slug: 'jassi-general-store', isDefault: true, industry: 'boutique',
    catalogStructure: {
      ...structuredClone(preset),
      defaultCategories: ['Lehengas', 'My Custom Category'],
      categoryDefinitions: [preset.categoryDefinitions[0], { key: 'my_custom', name: 'My Custom Category', attributes: [] }],
      filters: [{ key: 'category', label: 'Category', enabled: true }],
    },
  };
  const rows = [{ name: 'Lehengas', slug: 'lehengas', parent: null, isArchived: false }];
  const plan = planBridalCatalog(store, rows);
  assert.equal(plan.missing.length, preset.defaultCategories.length - 1);
  assert(plan.missing.every((item) => item.isActive === false && item.storeId === store._id));
  assert(plan.missing.some((item) => item.name === 'Jaimala & Varmala' && item.definitionKey === 'jaimala_varmala'));
  assert(plan.structure.defaultCategories.includes('My Custom Category'));
  assert.deepEqual(plan.structure.filters, store.catalogStructure.filters);
  assert.equal(store.catalogStructure.defaultCategories.length, 2);
  const completed = planBridalCatalog({ ...store, catalogStructure: plan.structure }, [
    ...rows, ...plan.missing.map((item) => ({ ...item, parent: null })),
  ]);
  assert.equal(completed.missing.length, 0);
  assert.equal(completed.structureUpdated, false);
});

test('archived and conflicting category names are left for manual review', () => {
  const store = { _id: 'store1', slug: 'jassi-general-store', isDefault: true, industry: 'boutique', catalogStructure: getIndustryPreset('boutique') };
  const plan = planBridalCatalog(store, [
    { name: 'Bangles', slug: 'bangles', parent: null, isArchived: true },
    { name: 'Custom garlands', slug: 'jaimala-varmala', parent: null, isArchived: false },
  ]);
  assert(plan.archived.includes('Bangles'));
  assert(plan.conflicts.includes('Jaimala & Varmala'));
  assert(!plan.missing.some((item) => ['Bangles', 'Jaimala & Varmala'].includes(item.name)));
});
