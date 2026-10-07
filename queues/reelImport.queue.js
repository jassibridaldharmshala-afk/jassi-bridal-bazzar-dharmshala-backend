const { Queue } = require('bullmq');
const { getReelImportConfig } = require('../config/reelImport');

const QUEUE_NAME = 'reel-product-import';
let queue;

function getRedisConnection() {
  if (!process.env.REDIS_URL) return null;
  try {
    const redisUrl = new URL(process.env.REDIS_URL);
    return {
      host: redisUrl.hostname,
      port: Number(redisUrl.port || 6379),
      username: redisUrl.username ? decodeURIComponent(redisUrl.username) : undefined,
      password: redisUrl.password ? decodeURIComponent(redisUrl.password) : undefined,
      db: redisUrl.pathname && redisUrl.pathname !== '/' ? Number(redisUrl.pathname.slice(1)) : 0,
      tls: redisUrl.protocol === 'rediss:' ? {} : undefined,
      maxRetriesPerRequest: null,
    };
  } catch {
    const error = new Error('REDIS_URL is invalid.');
    error.code = 'REEL_QUEUE_CONFIGURATION_INVALID';
    throw error;
  }
}

function getQueue() {
  const connection = getRedisConnection();
  if (!connection) return null;
  if (!queue) queue = new Queue(QUEUE_NAME, { connection });
  return queue;
}

async function enqueueReelImport({ jobId, storageKey, attemptNumber }) {
  const config = getReelImportConfig();
  const payload = { jobId: String(jobId), storageKey: String(storageKey) };
  const activeQueue = getQueue();

  if (activeQueue) {
    const nextAttempt = Math.max(1, Number(attemptNumber || 1));
    const queueJobId = `reel-${payload.jobId}-attempt-${nextAttempt}`;
    await activeQueue.add('process-reel', payload, {
      jobId: queueJobId,
      attempts: config.maxAttempts,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { age: 24 * 60 * 60, count: 100 },
      removeOnFail: { age: 7 * 24 * 60 * 60, count: 500 },
    });
    return { mode: 'redis', queueJobId };
  }

  setTimeout(() => {
    require('../workers/reelImport.processor').processReelImportJob(payload)
      .catch((error) => console.error(JSON.stringify({
        event: 'reel_import_dev_worker_failed',
        jobId: payload.jobId,
        code: error.code || 'PROCESSING_FAILED',
        message: error.message,
      })));
  }, 25);
  return { mode: 'in-process', queueJobId: null };
}

async function removeQueuedReelImport(queueJobId) {
  const activeQueue = getQueue();
  if (!activeQueue) return false;
  const queuedJob = await activeQueue.getJob(String(queueJobId));
  if (!queuedJob) return false;
  const state = await queuedJob.getState();
  if (['waiting', 'delayed', 'paused'].includes(state)) {
    await queuedJob.remove();
    return true;
  }
  return false;
}

async function closeReelImportQueue() {
  if (queue) await queue.close();
  queue = null;
}

async function resumePendingReelImports({ schedule = enqueueReelImport } = {}) {
  const ReelImport = require('../models/ReelImport');
  const config = getReelImportConfig();
  if (!config.enabled) return { resumed: 0, skipped: 0 };

  const hasRedis = Boolean(getRedisConnection());
  const statuses = hasRedis ? ['uploaded', 'queued'] : ['uploaded', 'queued', 'processing'];
  const jobs = await ReelImport.find({
    status: { $in: statuses },
    cancellationRequested: { $ne: true },
    attemptCount: { $lt: config.maxAttempts },
    ...(hasRedis ? { $or: [{ status: 'uploaded' }, { status: 'queued', queueJobId: null, attemptCount: 0 }] } : {}),
  }).select('+sourceVideo.url').sort({ createdAt: 1 }).limit(25);

  let resumed = 0;
  for (const job of jobs) {
    if (!job.sourceVideo?.storageKey) continue;
    job.status = 'queued';
    job.activeRunId = null;
    job.progress = {
      percentage: Math.max(8, Number(job.progress?.percentage || 0)),
      stage: 'queued',
      currentStep: 'Queued',
      message: 'Processing resumed after the server restarted.',
      startedAt: new Date(),
      updatedAt: new Date(),
    };
    job.lastHeartbeatAt = new Date();
    await job.save();
    const queued = await schedule({
      jobId: job._id,
      storageKey: job.sourceVideo.storageKey,
      attemptNumber: Number(job.attemptCount || 0) + 1,
    });
    if (queued?.queueJobId) {
      await ReelImport.updateOne({ _id: job._id }, { $set: { queueJobId: queued.queueJobId } });
    }
    resumed += 1;
  }
  return { resumed, skipped: Math.max(0, jobs.length - resumed) };
}

module.exports = {
  QUEUE_NAME,
  closeReelImportQueue,
  enqueueReelImport,
  getRedisConnection,
  removeQueuedReelImport,
  resumePendingReelImports,
};
