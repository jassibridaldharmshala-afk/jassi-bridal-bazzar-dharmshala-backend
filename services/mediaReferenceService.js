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
module.exports = { referenced };
