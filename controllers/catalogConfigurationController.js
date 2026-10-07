const { asyncHandler } = require('../middleware/validate');
const { readConfiguration, publicStructure } = require('../services/masterConfigurationService');

exports.publicCatalog = asyncHandler(async (req, res) => {
  res.setHeader('Cache-Control', 'private, max-age=60, stale-while-revalidate=300');
  res.setHeader('Vary', 'Host, X-Store-Slug');
  res.json(publicStructure(await readConfiguration(req.store?._id)));
});
