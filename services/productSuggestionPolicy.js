const SIZE_ATTRIBUTE = /^(?:size|sizes|accessory_size|ring_size|bangle_size|size_range|measurements)$/i;
const VISUAL_ATTRIBUTES = new Set(['gender', 'clothing_type', 'colour', 'color', 'pattern', 'sleeve_type', 'neckline', 'occasion', 'jewellery_type', 'embellishment', 'silhouette', 'closure_type', 'garland_style']);

const automaticSizing = structure => structure?.industry !== 'boutique' && structure?.features?.sizing !== false;

function suggestionAttributes(structure = {}, categories = [], inherited = []) {
  const result = new Map((structure.attributes || inherited).map(item => [item.key, { ...item }]));
  for (const category of categories) {
    const definition = (structure.categoryDefinitions || []).find(item => item.key === category.definitionKey || item.name.toLowerCase() === String(category.name).toLowerCase());
    for (const item of [...(definition?.attributes || []), ...(category.attributeOverrides || [])]) {
      if (!item || typeof item !== 'object' || !item.key) continue;
      if (result.has(item.key)) {
        const previous = result.get(item.key);
        if (previous.categoryIds) previous.categoryIds = [...new Set([...previous.categoryIds, String(category._id)])];
        continue;
      }
      result.set(item.key, { ...item, categoryIds: categories.filter(row => row.definitionKey === definition?.key || row._id === category._id).map(row => String(row._id)) });
    }
  }
  return [...result.values()].filter(item => automaticSizing(structure) || !SIZE_ATTRIBUTE.test(item.key));
}

function categoryAttributes(structure = {}, categories = [], categoryId, inherited = []) {
  const selected = categories.find(item => String(item._id) === String(categoryId));
  const result = new Map((structure.attributes || inherited).filter(item => !item.categoryIds || item.categoryIds.includes(String(categoryId))).map(item => [item.key, item]));
  let definition = (structure.categoryDefinitions || []).find(item => item.key === selected?.definitionKey || item.name === selected?.name);
  const chain = [], visited = new Set();
  while (definition && !visited.has(definition.key)) {
    visited.add(definition.key); chain.unshift(definition);
    definition = structure.categoryDefinitions.find(item => item.key === definition.parentKey);
  }
  for (const item of [...chain.flatMap(layer => layer.attributes || []), ...(selected?.attributeOverrides || [])]) if (item && typeof item === 'object' && item.key) result.set(item.key, { ...result.get(item.key), ...item });
  return [...result.values()].filter(item => automaticSizing(structure) || !SIZE_ATTRIBUTE.test(item.key));
}

function attributeValue(value, definition) {
  if (Array.isArray(value)) value = value.join(', ');
  if (!['string', 'number', 'boolean'].includes(typeof value)) return '';
  const text = String(value).replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!text) return '';
  if (['dropdown', 'multi_select'].includes(definition.type) && definition.options?.length) {
    const selected = (definition.type === 'multi_select' ? text.split(',') : [text]).map(item => definition.options.find(option => String(option).toLowerCase() === item.trim().toLowerCase()));
    if (selected.some(item => !item)) return '';
    return [...new Set(selected)].join(', ');
  }
  if (['number', 'measurement', 'range'].includes(definition.type)) {
    const number = Number(text);
    if (!Number.isFinite(number) || definition.validation?.min != null && number < definition.validation.min || definition.validation?.max != null && number > definition.validation.max) return '';
  }
  if (definition.type === 'boolean' && !/^(true|false)$/i.test(text)) return '';
  return text;
}

function withoutAutomaticSizes(suggestion, structure) {
  const seo = { ...suggestion, metaTitle: String(suggestion.name || '').slice(0, 60), metaDescription: String(suggestion.shortDescription || suggestion.description || '').slice(0, 160), metaKeywords: (suggestion.tags || []).join(', ').slice(0, 1000) };
  if (automaticSizing(structure)) return seo;
  const result = { ...seo, sizes: [], sizingMode: 'free-size', sizeChartProfile: 'free-size', sizeChart: { unit: 'in', columns: [], rows: [] }, attributeValues: { ...suggestion.attributeValues }, fieldSources: { ...suggestion.fieldSources } };
  for (const key of Object.keys(result.attributeValues)) if (SIZE_ATTRIBUTE.test(key)) delete result.attributeValues[key];
  for (const key of Object.keys(result.fieldSources)) if (['sizes', 'sizingMode', 'sizeChart'].includes(key) || key.startsWith('attribute.') && SIZE_ATTRIBUTE.test(key.slice(10))) delete result.fieldSources[key];
  return result;
}

module.exports = { automaticSizing, suggestionAttributes, categoryAttributes, attributeValue, withoutAutomaticSizes, VISUAL_ATTRIBUTES };
