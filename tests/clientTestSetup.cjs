// Generated-client commerce tests run against isolated databases/providers.
// Licence signature/cache tests keep the real implementation and their own
// signed ephemeral fixtures; this never affects server.js or production boot.
require('./helpers');
if (!process.argv.some(value => /licenseCache\.unit\.test\.js$/.test(value))) {
  require('../services/controlPlaneClient').licenseStatus = async () => ({ managed: false, status: 'ACTIVE' });
}
