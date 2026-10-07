const ReelImport = require('../models/ReelImport');
const { getReelImportConfig } = require('../config/reelImport');

const ACTIVE_STATUSES = new Set(['uploading', 'uploaded', 'queued', 'processing', 'creating_drafts']);
const TERMINAL_STAGE_STATUSES = new Set(['completed', 'failed', 'cancelled']);

const STAGE_TIMEOUTS_MS = {
  uploading_video: 10 * 60 * 1000,
  validating_video: 2 * 60 * 1000,
  queued: 5 * 60 * 1000,
  preparing_video: 2 * 60 * 1000,
  downloading_video: 4 * 60 * 1000,
  reading_video: 2 * 60 * 1000,
  extracting_frames: 6 * 60 * 1000,
  analyzing_frames: 8 * 60 * 1000,
  analyzing_details: 8 * 60 * 1000,
  saving_frames: 8 * 60 * 1000,
  remote_processing: 20 * 60 * 1000,
  finalizing_results: 2 * 60 * 1000,
  creating_drafts: 5 * 60 * 1000,
};

function normalizeStageKey(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'processing_reel';
}

function stageKeyForJob(job) {
  const stageWasDefaulted = typeof job?.$isDefault === 'function' && job.$isDefault('progress.stage');
  if (job?.progress?.stage && !stageWasDefaulted) return normalizeStageKey(job.progress.stage);
  const currentStep = String(job?.progress?.currentStep || '').toLowerCase();
  if (currentStep.includes('download')) return 'downloading_video';
  if (currentStep.includes('queue')) return 'queued';
  if (currentStep.includes('extract')) return 'extracting_frames';
  if (currentStep.includes('saving') || currentStep.includes('upload')) return 'saving_frames';
  if (currentStep.includes('reading') || currentStep.includes('duration')) return 'reading_video';
  if (currentStep.includes('draft')) return 'creating_drafts';
  return normalizeStageKey(currentStep || job?.status || 'processing_reel');
}

function activityDate(job) {
  // Root updatedAt is persisted on legacy jobs as well. Newly-added Date defaults
  // may exist only in memory when an older document is hydrated, so they must not
  // make an old stalled job look freshly active.
  const value = job?.updatedAt
    || job?.lastHeartbeatAt
    || job?.progress?.updatedAt
    || job?.startedAt
    || job?.createdAt;
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
}

function getJobHealth(job, { now = new Date(), timeoutMinutes } = {}) {
  const active = ACTIVE_STATUSES.has(String(job?.status || ''));
  const lastActivityAt = activityDate(job);
  const stage = stageKeyForJob(job);
  const configuredTimeout = Math.max(60 * 1000, Number(timeoutMinutes || getReelImportConfig().timeoutMinutes) * 60 * 1000);
  const staleAfterMs = Math.min(configuredTimeout, STAGE_TIMEOUTS_MS[stage] || configuredTimeout);
  const inactiveForMs = lastActivityAt ? Math.max(0, now.getTime() - lastActivityAt.getTime()) : 0;
  return {
    active,
    stage,
    stale: Boolean(active && lastActivityAt && inactiveForMs > staleAfterMs),
    recoverable: ['failed', 'cancelled'].includes(String(job?.status || ''))
      || Boolean(active && lastActivityAt && inactiveForMs > staleAfterMs),
    lastActivityAt,
    inactiveForSeconds: Math.floor(inactiveForMs / 1000),
    staleAfterSeconds: Math.floor(staleAfterMs / 1000),
  };
}

function applyProgress(job, {
  stage,
  percentage,
  currentStep,
  message = '',
  stageStatus = 'running',
  errorCode,
  now = new Date(),
} = {}) {
  const key = normalizeStageKey(stage || currentStep || job.status);
  const percent = Math.max(0, Math.min(100, Number(percentage || 0)));
  const previous = job.progress || {};
  const previousKey = stageKeyForJob(job);
  const history = Array.isArray(job.stageHistory) ? job.stageHistory : [];
  const running = [...history].reverse().find((entry) => entry.status === 'running');

  if (running && running.key !== key) {
    running.status = 'completed';
    running.completedAt = now;
    running.durationMs = Math.max(0, now.getTime() - new Date(running.startedAt || now).getTime());
  }

  let entry = [...history].reverse().find((item) => item.key === key && item.status === 'running');
  if (!entry) {
    entry = {
      key,
      label: currentStep || key,
      status: stageStatus,
      percentage: percent,
      message,
      attempt: Number(job.attemptCount || 0),
      startedAt: now,
    };
    history.push(entry);
  } else {
    entry.label = currentStep || entry.label;
    entry.percentage = percent;
    entry.message = message;
    entry.status = stageStatus;
  }

  if (TERMINAL_STAGE_STATUSES.has(stageStatus)) {
    entry.completedAt = now;
    entry.durationMs = Math.max(0, now.getTime() - new Date(entry.startedAt || now).getTime());
    if (errorCode) entry.errorCode = errorCode;
  }

  job.stageHistory = history.slice(-60);
  job.progress = {
    percentage: percent,
    stage: key,
    currentStep: currentStep || key,
    message,
    startedAt: previousKey === key && previous.startedAt ? previous.startedAt : now,
    updatedAt: now,
  };
  job.lastHeartbeatAt = now;
  return job;
}

async function saveProgress(job, details) {
  applyProgress(job, details);
  await job.save();
  return job;
}

async function updateActiveRunProgress(jobId, runId, details) {
  const job = await ReelImport.findOne({
    _id: jobId,
    status: 'processing',
    activeRunId: runId,
    cancellationRequested: { $ne: true },
  }).select('+activeRunId +sourceVideo.url');
  if (!job) {
    const error = new Error('This processing run was cancelled or replaced by a newer run.');
    error.code = 'REEL_PROCESSING_SUPERSEDED';
    throw error;
  }
  return saveProgress(job, details);
}

async function heartbeatActiveRun(jobId, runId) {
  const now = new Date();
  const result = await ReelImport.updateOne({
    _id: jobId,
    status: 'processing',
    activeRunId: runId,
    cancellationRequested: { $ne: true },
  }, {
    $set: { lastHeartbeatAt: now, 'progress.updatedAt': now },
  });
  return result.modifiedCount === 1;
}

async function failStalledJob(job, { now = new Date() } = {}) {
  const health = getJobHealth(job, { now });
  if (!health.stale) return job;

  const inactiveMinutes = Math.max(1, Math.round(health.inactiveForSeconds / 60));
  const message = `No progress was received for ${inactiveMinutes} minute${inactiveMinutes === 1 ? '' : 's'}. The run was stopped safely and can be retried.`;
  job.status = 'failed';
  job.activeRunId = null;
  job.queueJobId = null;
  job.completedAt = now;
  job.error = { code: 'REEL_PROCESSING_STALLED', safeMessage: message };
  await saveProgress(job, {
    stage: health.stage,
    percentage: job.progress?.percentage || 0,
    currentStep: 'Processing stalled',
    message,
    stageStatus: 'failed',
    errorCode: 'REEL_PROCESSING_STALLED',
    now,
  });
  return job;
}

async function sweepStalledReelImports({ limit = 50, now = new Date() } = {}) {
  const jobs = await ReelImport.find({
    status: { $in: [...ACTIVE_STATUSES] },
    cancellationRequested: { $ne: true },
  }).select('+activeRunId').sort({ updatedAt: 1 }).limit(limit);
  let failed = 0;
  for (const job of jobs) {
    if (!getJobHealth(job, { now }).stale) continue;
    await failStalledJob(job, { now });
    failed += 1;
  }
  return { checked: jobs.length, failed };
}

function startReelImportWatchdog({ intervalMs = 60000 } = {}) {
  const timer = setInterval(() => {
    sweepStalledReelImports().then((result) => {
      if (result.failed) console.warn(JSON.stringify({ event: 'reel_import_stalled_jobs_failed', count: result.failed }));
    }).catch((error) => {
      console.error(JSON.stringify({ event: 'reel_import_watchdog_failed', message: error.message }));
    });
  }, Math.max(15000, intervalMs));
  timer.unref?.();
  return () => clearInterval(timer);
}

function publicHealth(job) {
  const health = getJobHealth(job);
  return {
    stage: health.stage,
    stalled: health.stale,
    recoverable: health.recoverable,
    lastActivityAt: health.lastActivityAt,
    inactiveForSeconds: health.inactiveForSeconds,
    staleAfterSeconds: health.staleAfterSeconds,
  };
}

module.exports = {
  ACTIVE_STATUSES,
  STAGE_TIMEOUTS_MS,
  applyProgress,
  failStalledJob,
  getJobHealth,
  heartbeatActiveRun,
  publicHealth,
  saveProgress,
  startReelImportWatchdog,
  stageKeyForJob,
  sweepStalledReelImports,
  updateActiveRunProgress,
};
