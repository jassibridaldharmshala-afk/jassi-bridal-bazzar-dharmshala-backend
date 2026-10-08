const { asyncHandler } = require('../middleware/validate');
const { logAudit } = require('../services/auditService');
const setup = require('../services/bridalCatalogSetup');

exports.preview = asyncHandler(async (_req, res) => res.json(await setup.previewBridalCatalog()));
exports.apply = asyncHandler(async (req, res) => {
  const result = await setup.setupBridalCatalog();
  await logAudit({ req, action: 'BRIDAL_CATALOG_SETUP', entityType: 'Store', after: { created: result.created, structureUpdated: result.structureUpdated } });
  res.json(result);
});
