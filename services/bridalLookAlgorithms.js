// Appearance metadata is deliberately separate from commercial facts and set contents.
const ENUMS = {
  metallicTone: ['gold-tone', 'silver-tone', 'rose-gold-tone', 'mixed', 'none'],
  style: ['traditional', 'contemporary', 'mixed'],
  accessoryType: ['garment', 'necklace', 'earrings', 'bangles', 'tikka', 'bag', 'footwear', 'other'],
  workIntensity: ['light', 'medium', 'heavy'],
};
const text = value => typeof value === 'string' ? value.trim().replace(/[<>\x00-\x1f]/g, '').slice(0, 80) : '';
const AI_APPEARANCE_PROMPT = 'Return bridalStyle:{mainColour:"",accentColours:[],metallicTone:"gold-tone|silver-tone|rose-gold-tone|mixed|none or empty",style:"traditional|contemporary|mixed or empty",accessoryType:"garment|necklace|earrings|bangles|tikka|bag|footwear|other or empty",workIntensity:"light|medium|heavy or empty",neckline:""}. Describe only visibly supported appearance of the MAIN sellable product. Every supported field requires fieldSources["bridalStyle.FIELD"] with visual evidence describing what is visible. Unknown stays empty. Gold-tone appearance is never gold purity/material; never infer gemstone authenticity, fabric, stock, prices, sizes, rentals, adjustability or included components. Jewellery worn by a model is styling, not part of the garment. Do not assign model jewellery finish to garment embroidery. Bangle size codes like 2.4/2.6 are strings, never decimal measurements. Sizes, piece/pair/set units and included items require explicit owner data.';
const list = value => [...new Set((Array.isArray(value) ? value : String(value || '').split(/[,;|]/)).map(text).filter(Boolean))].slice(0, 12);
function normalizeStyle(value) {
  const v = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return { mainColour: text(v.mainColour), accentColours: list(v.accentColours),
    ...Object.fromEntries(Object.entries(ENUMS).map(([key, options]) => [key, options.includes(v[key]) ? v[key] : ''])), neckline: text(v.neckline) };
}
function normalizeDetails(value) {
  const v = value && typeof value === 'object' ? value : {};
  return { unit: ['piece', 'pair', 'set'].includes(v.unit) ? v.unit : '', includedTypes: list(v.includedTypes).filter(type => ENUMS.accessoryType.includes(type)) };
}
const ALIASES = { maroon: 'wine', 'wine red': 'wine', 'wine-red': 'wine', burgundy: 'wine', 'dark red': 'wine', golden: 'gold', 'gold tone': 'gold', 'gold-tone': 'gold', 'silver tone': 'silver', 'silver-tone': 'silver', ivory: 'cream', beige: 'cream', fuchsia: 'pink', magenta: 'pink', emerald: 'green' };
function colour(value) { const key = text(value).toLowerCase(); return ALIASES[key] || key; }
const ROLE_PATTERNS = [
  ['garment', /saree|sari|lehenga|kurta|kurti|suit|dress|outfit|clothing|apparel/],
  ['necklace', /necklace|neckless|pendant|neck.?set|jewellery.?set|jewelry.?set/],
  ['earrings', /earring|jhumka/], ['bangles', /bangle|bracelet|chudi|chooda/],
  ['tikka', /tikka|maang|headpiece/], ['bag', /potli|clutch|handbag|\bbag/], ['footwear', /footwear|sandal|heel|shoe|jutti/],
];
function role(product) {
  if (ENUMS.accessoryType.includes(product.bridalStyle?.accessoryType)) return product.bridalStyle.accessoryType;
  // Category definitions and configured attributes take priority over names.
  for (const raw of [product.categoryDefinitionKey, product.category?.definitionKey, product.attributeValues?.product_type, product.attributeValues?.jewellery_type, product.category?.name, product.subCategory, product.name]) {
    const found = ROLE_PATTERNS.find(([, re]) => re.test(String(raw || '').toLowerCase().replace(/[_-]/g, ' ')));
    if (found) return found[0];
  }
  return '';
}
const PAIRS = { garment: ['necklace', 'earrings', 'bangles', 'tikka', 'bag', 'footwear'], necklace: ['bangles', 'tikka', 'bag'], earrings: ['necklace', 'bangles'], bangles: ['necklace', 'earrings'], bag: ['footwear'], footwear: ['bag'] };
function candidateKinds(source) {
  const roles = PAIRS[role(source)] || [];
  return { roles, pattern: new RegExp(ROLE_PATTERNS.filter(([type]) => roles.includes(type)).map(([, pattern]) => `(?:${pattern.source})`).join('|') || '(?!)', 'i') };
}
function appearance(product, { selectedColour = '', variant } = {}) {
  const metadata = normalizeStyle({ ...product.bridalStyle, ...variant?.bridalStyle });
  const attrs = product.attributeValues || {};
  const main = selectedColour || variant?.color || metadata.mainColour || (product.colors?.length === 1 ? product.colors[0] : '') || attrs.colour || '';
  // Accents for one colourway must never leak into a different selected colourway.
  const compatible = !metadata.mainColour || colour(main) === colour(metadata.mainColour);
  const explicit = [...list(product.tags), ...list(attrs.work), ...list(attrs.embroidery), ...list(attrs.finish)].join(' ').toLowerCase();
  const tone = (compatible || variant?.bridalStyle?.metallicTone ? metadata.metallicTone : '') || (/gold[ -]tone/.test(explicit) ? 'gold-tone' : /silver[ -]tone/.test(explicit) ? 'silver-tone' : '');
  return { ...metadata, mainColour: colour(main), accentColours: compatible ? metadata.accentColours.map(colour) : [], metallicTone: tone, style: metadata.style || (/traditional/.test(explicit) ? 'traditional' : /contemporary/.test(explicit) ? 'contemporary' : '') };
}
function match(source, candidate, context = {}) {
  const group = role(candidate);
  if (!PAIRS[role(source)]?.includes(group) || context.includedTypes?.has(group)) return null;
  const a = appearance(source, context), b = appearance(candidate, { variant: context.candidateVariant, selectedColour: context.candidateColour });
  const colours = new Set([a.mainColour, ...a.accentColours].filter(Boolean));
  const coordinated = [b.mainColour, ...b.accentColours].filter(Boolean).some(value => colours.has(value));
  const tone = a.metallicTone && a.metallicTone !== 'none' && a.metallicTone !== 'mixed' && a.metallicTone === b.metallicTone;
  if (!coordinated && !tone && !context.pinned) return null;
  const reasons = [];
  if (tone) reasons.push(`${a.metallicTone[0].toUpperCase() + a.metallicTone.slice(1)} finish coordinates with the outfit’s visible work.`);
  else if (coordinated) reasons.push('Coordinates with your selected colour or its accent colours.');
  if (!reasons.length && context.pinned) reasons.push('Paired with this product by the store.');
  return { group, reason: reasons[0], score: (context.pinned ? 100 : 0) + (tone ? 30 : 0) + (coordinated ? 25 : 0) + (a.style && a.style === b.style ? 5 : 0) };
}
function balance(rows, limit = 8) {
  const sorted = [...rows].sort((a, b) => b.match.score - a.match.score || String(a._id).localeCompare(String(b._id)));
  const groups = [...new Set(sorted.map(row => row.match.group))];
  const chosen = [];
  for (let round = 0; round < 2; round++) for (const group of groups) { const row = sorted.filter(item => item.match.group === group)[round]; if (row && chosen.length < limit) chosen.push(row); }
  return chosen;
}
module.exports = { ENUMS, AI_APPEARANCE_PROMPT, normalizeStyle, normalizeDetails, candidateKinds, colour, role, appearance, match, balance, list };
