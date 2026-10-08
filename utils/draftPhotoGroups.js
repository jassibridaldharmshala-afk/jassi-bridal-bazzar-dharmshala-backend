const { ApiError } = require('./apiError');

const MAX_PHOTOS = 30;
const invalid = (message) => { throw new ApiError('VALIDATION_ERROR', message); };

// Indices refer to the original multipart file order, including on receipt retries.
// Every uploaded photo must belong to exactly one product before storage starts.
function resolveDraftPhotoGroups(fields = {}, fileCount) {
  if (!Number.isInteger(fileCount) || fileCount < 1 || fileCount > MAX_PHOTOS) invalid('Choose between 1 and 30 product photos.');
  const mode = fields.groupMode || 'separate';
  if (mode === 'single') return [{ name: '', photoIndexes: Array.from({ length: fileCount }, (_, index) => index) }];
  if (mode === 'separate') return Array.from({ length: fileCount }, (_, index) => ({ name: '', photoIndexes: [index] }));
  if (mode !== 'grouped') invalid('Choose a valid product photo grouping option.');

  let groups = fields.photoGroups;
  if (typeof groups === 'string') {
    if (groups.length > 12000) invalid('Product photo groups are too large.');
    try { groups = JSON.parse(groups); } catch { invalid('Product photo groups could not be read.'); }
  }
  if (!Array.isArray(groups) || !groups.length || groups.length > MAX_PHOTOS) invalid('Create at least one product photo group.');
  const assigned = new Set();
  const result = groups.map((group, position) => {
    if (!group || typeof group !== 'object' || Array.isArray(group)) invalid(`Product group ${position + 1} is invalid.`);
    if (group.name !== undefined && typeof group.name !== 'string') invalid('Product group names must be text.');
    const name = String(group.name || '').trim();
    if (name.length > 160) invalid('Product group names can have at most 160 characters.');
    const indices = group.photoIndexes;
    if (!Array.isArray(indices) || !indices.length || indices.length > MAX_PHOTOS) invalid(`Add photos to product group ${position + 1}.`);
    for (const index of indices) {
      if (!Number.isInteger(index) || index < 0 || index >= fileCount) invalid('A product group refers to a photo outside this upload.');
      if (assigned.has(index)) invalid('Each photo can belong to only one product group.');
      assigned.add(index);
    }
    const coverIndex = group.coverIndex === undefined ? indices[0] : group.coverIndex;
    if (!indices.includes(coverIndex)) invalid('Choose a cover photo from the same product group.');
    return { name, photoIndexes: [coverIndex, ...indices.filter((index) => index !== coverIndex)] };
  });
  if (assigned.size !== fileCount) invalid('Assign every photo to a product group or remove the unused photos.');
  return result;
}

module.exports = { resolveDraftPhotoGroups, MAX_PHOTOS };
