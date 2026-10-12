// Shared catalogue/draft assets must survive deleting one of their references.
async function referenced(entry) {
  const paths = ['images', 'images.variants', 'variants.images', 'variants.images.variants', 'images.background.original', 'images.background.original.variants', 'images.background.edited', 'images.background.edited.variants', 'variants.images.background.original', 'variants.images.background.original.variants', 'variants.images.background.edited', 'variants.images.background.edited.variants', 'videos', 'videos.thumbnail'];
  const terms = paths.flatMap(path => [entry.url && { [path + '.url']: entry.url }, entry.publicId && { [path + '.publicId']: entry.publicId }].filter(Boolean));
  if (!terms.length) return true;
  const [product, draft, banner, category, reel, social] = await Promise.all([
    require('../models/Product').exists({ $or: terms }), require('../models/ProductDraft').exists({ $or: terms }),
    entry.url && require('../models/Banner').exists({ $or: ['image', 'tabletImage', 'mobileImage'].map(key => ({ [key]: entry.url })) }),
    entry.url && require('../models/Category').exists({ $or: [{ image: entry.url }, { socialImage: entry.url }] }),
    require('../models/ReelCandidate').exists({ $or: [entry.url && { 'frames.url': entry.url }, entry.url && { 'frames.variants.url': entry.url }, entry.publicId && { 'frames.storageKey': entry.publicId }, entry.publicId && { 'frames.variants.publicId': entry.publicId }].filter(Boolean) }),
    require('../models/SocialProductImport').exists({ $or: terms }),
  ]);
  return !!(product || draft || banner || category || reel || social);
}
// A removed master and every display copy form one family. Preserve all of it
// when any copy is still used, including a saved order or restorable design.
async function referencedFamily(assets) {
  if (!assets?.length) return true;
  const urls = [...new Set(assets.map(asset => asset.url).filter(Boolean))];
  const checks = [
    ['Settings', ['logoUrl', 'faviconUrl', 'socialShareImage']],
    ['Store', ['logo', 'coverImage']],
    ['Campaign', ['creative.image', 'creative.tabletImage', 'creative.mobileImage']],
    ['Review', ['photos']],
    ['Order', ['items.image', 'invoiceSeller.logoUrl']],
  ];
  for (const asset of assets) if (await referenced(asset)) return true;
  for (const [model, paths] of checks) {
    if (urls.length && await require('../models/' + model).exists({ $or: paths.map(path => ({ [path]: { $in: urls } })) })) return true;
  }
  if (urls.length && await require('../models/Rental').Booking.exists({ $or: [{ 'quote.items.image': { $in: urls } }, { 'acceptedQuote.items.image': { $in: urls } }] })) return true;
  const wanted = new Set(urls);
  const contains = value => typeof value === 'string' ? wanted.has(value) : Array.isArray(value) ? value.some(contains)
    : value && typeof value === 'object' && !(value instanceof Date) ? Object.values(value).some(contains) : false;
  for (const [model, fields] of [
    ['WebsiteTheme', 'draftConfig publishedConfig scheduledConfig scheduledContent'],
    ['WebsiteThemeVersion', 'config'], ['StorefrontDesignVersion', 'config'],
    ['StoreContentVersion', 'content'], ['Store', 'storefrontDesign'],
  ]) {
    const cursor = require('../models/' + model).find({}).select(fields).lean().cursor();
    try { for await (const record of cursor) if (contains(record)) return true; }
    finally { await cursor.close(); }
  }
  return false;
}
module.exports = { referenced, referencedFamily };
