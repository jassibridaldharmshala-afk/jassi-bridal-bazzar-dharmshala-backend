const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Disposable processing inputs only. This directory is never served by Express.
const mediaStagingDirectory = path.join(os.tmpdir(), 'jassi-media-staging');
const STAGING_MAX_AGE = 24 * 60 * 60 * 1000;
let sweepStarted = false;
async function cleanupStaleStaging(now = Date.now()) {
  const root = path.resolve(mediaStagingDirectory);
  const entries = await fs.promises.readdir(root, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}-/i.test(entry.name)) continue;
    const target = path.resolve(root, entry.name);
    if (path.dirname(target) !== root) continue;
    const details = await fs.promises.lstat(target).catch(() => null);
    if (details?.isFile() && !details.isSymbolicLink() && now - details.mtimeMs > STAGING_MAX_AGE) await fs.promises.unlink(target).catch(() => {});
  }
}
function stagingDirectory() {
  fs.mkdirSync(mediaStagingDirectory, { recursive: true, mode: 0o700 });
  if (!sweepStarted) {
    sweepStarted = true;
    cleanupStaleStaging().catch(() => {});
    setInterval(() => cleanupStaleStaging().catch(() => {}), 60 * 60 * 1000).unref();
  }
  return mediaStagingDirectory;
}
module.exports = { stagingDirectory, mediaStagingDirectory, cleanupStaleStaging };
