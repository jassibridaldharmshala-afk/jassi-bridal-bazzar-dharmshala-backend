const ReelImport = require('../models/ReelImport');
const { deleteObject } = require('./mediaStorage.service');

const TERMINAL = ['review_required', 'completed', 'failed', 'cancelled'];
let worker;

async function claimExpired(now = new Date()) {
  return ReelImport.findOneAndUpdate({
    status: { $in: TERMINAL },
    retentionExpiresAt: { $lte: now },
    sourcePurgedAt: { $exists: false },
    $or: [{ purgeLeaseUntil: { $exists: false } }, { purgeLeaseUntil: null }, { purgeLeaseUntil: { $lte: now } }],
  }, {
    $set: { purgeLeaseUntil: new Date(now.getTime() + 5 * 60 * 1000), purgeLastError: '' },
    $inc: { purgeAttemptCount: 1 },
  }, { new: true, sort: { retentionExpiresAt: 1 } }).select('+sourceVideo.url');
}

async function purgeExpiredReelMedia({ limit = 20, now = new Date() } = {}) {
  let purged = 0;
  let failed = 0;
  for (let index = 0; index < limit; index += 1) {
    const job = await claimExpired(now);
    if (!job) break;
    try {
      const removed = await deleteObject(job.sourceVideo || {});
      if (!removed) throw new Error('The configured media provider did not confirm deletion.');
      await ReelImport.updateOne({ _id: job._id, sourcePurgedAt: { $exists: false } }, {
        $set: { sourcePurgedAt: new Date(), purgeLastError: '' },
        $unset: { purgeLeaseUntil: 1, 'sourceVideo.url': 1 },
      });
      purged += 1;
    } catch (error) {
      await ReelImport.updateOne({ _id: job._id }, {
        $set: { purgeLastError: String(error.message || 'Media cleanup failed').slice(0, 500) },
        $unset: { purgeLeaseUntil: 1 },
      }).catch(() => null);
      failed += 1;
    }
  }
  return { purged, failed };
}

function startReelMediaCleanupWorker() {
  if (worker || process.env.NODE_ENV === 'test') return stopReelMediaCleanupWorker;
  const configured = Number(process.env.REEL_MEDIA_CLEANUP_INTERVAL_MS || 6 * 60 * 60 * 1000);
  const interval = Number.isFinite(configured) ? Math.max(15 * 60 * 1000, configured) : 6 * 60 * 60 * 1000;
  const tick = () => purgeExpiredReelMedia().then(({ failed }) => {
    if (failed) console.warn(JSON.stringify({ event: 'reel_media_cleanup_incomplete', failed }));
  }).catch((error) => console.error(JSON.stringify({ event: 'reel_media_cleanup_failed', message: error.message })));
  tick();
  worker = setInterval(tick, interval);
  worker.unref();
  return stopReelMediaCleanupWorker;
}

function stopReelMediaCleanupWorker() {
  if (worker) clearInterval(worker);
  worker = null;
}

module.exports = { claimExpired, purgeExpiredReelMedia, startReelMediaCleanupWorker, stopReelMediaCleanupWorker };
