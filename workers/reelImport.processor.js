const crypto = require('crypto');
const Category = require('../models/Category');
const ReelCandidate = require('../models/ReelCandidate');
const ReelImport = require('../models/ReelImport');
const { getReelImportConfig } = require('../config/reelImport');
const { analyzeCandidateImages, isVisionEnabled } = require('../services/reelCandidateVision.service');
const {
  heartbeatActiveRun,
  saveProgress,
  updateActiveRunProgress,
} = require('../services/reelImportProgress.service');

async function processReelImportJob({ jobId, storageKey }) {
  let job = await ReelImport.findOne({ _id: jobId, 'sourceVideo.storageKey': storageKey }).select('+sourceVideo.url');
  if (!job) throw processingError('REEL_JOB_NOT_FOUND', 'The reel import job no longer exists.');
  if (job.status === 'cancelled' || job.cancellationRequested) return { cancelled: true };
  if (job.status === 'review_required' || job.status === 'completed') return { idempotent: true };

  const started = Date.now();
  const runId = crypto.randomUUID();
  const expired = new Date(Date.now() - 90000);
  const claimed = await ReelImport.findOneAndUpdate({ _id: job._id, cancellationRequested: { $ne: true }, $or: [
    { status: { $in: ['uploaded', 'queued', 'failed'] } },
    { status: 'processing', $or: [{ lastHeartbeatAt: { $lt: expired } }, { lastHeartbeatAt: { $exists: false }, updatedAt: { $lt: expired } }] },
  ] }, { $set: { status: 'processing', activeRunId: runId, lastHeartbeatAt: new Date() } }, { new: true }).select('+sourceVideo.url +activeRunId');
  if (!claimed) {
    const current = await ReelImport.findById(job._id);
    return current?.status === 'processing' ? { busy: true } : { idempotent: true };
  }
  job = claimed;
  job.status = 'processing';
  job.activeRunId = runId;
  job.startedAt = job.startedAt || new Date();
  job.attemptCount += 1;
  job.error = undefined;
  const heartbeat = setInterval(() => heartbeatActiveRun(job._id, runId).catch(() => {}), 15000);
  heartbeat.unref?.();
  try {
    await saveProgress(job, {
      stage: 'preparing_video',
      percentage: 10,
      currentStep: 'Preparing video',
      message: `Processing attempt ${job.attemptCount} started.`,
    });

    const result = await requestAiWorker(job, runId);
    result.candidates = await enrichCandidatesWithSmartDetails(job, runId, result.candidates || []);
    const refreshed = await ReelImport.findOne({
      _id: jobId,
      status: 'processing',
      activeRunId: runId,
      cancellationRequested: { $ne: true },
    }).select('+activeRunId');
    if (!refreshed) return { superseded: true };

    await saveProgress(refreshed, {
      stage: 'finalizing_results',
      percentage: 94,
      currentStep: 'Finalizing results',
      message: 'Saving detected products and preparing the review screen.',
    });

    await persistCandidates(refreshed, result.candidates || []);
    if (result.metadata) {
      refreshed.sourceVideo.durationSeconds = Number(result.metadata.durationSeconds || refreshed.sourceVideo.durationSeconds || 0);
      refreshed.sourceVideo.width = Number(result.metadata.width || refreshed.sourceVideo.width || 0);
      refreshed.sourceVideo.height = Number(result.metadata.height || refreshed.sourceVideo.height || 0);
      refreshed.sourceVideo.codec = String(result.metadata.codec || refreshed.sourceVideo.codec || '');
    }
    refreshed.statistics = {
      ...refreshed.statistics?.toObject?.() || refreshed.statistics || {},
      ...(result.statistics || {}),
      detectedProducts: (result.candidates || []).length,
    };
    refreshed.status = 'review_required';
    refreshed.activeRunId = null;
    refreshed.queueJobId = null;
    refreshed.completedAt = new Date();
    refreshed.error = undefined;
    await saveProgress(refreshed, {
      stage: 'ready_for_review',
      percentage: 100,
      currentStep: 'Ready for review',
      message: 'Possible products are ready for admin review.',
      stageStatus: 'completed',
    });
    structuredLog('reel_import_completed', jobId, {
      durationMs: Date.now() - started,
      candidates: result.candidates?.length || 0,
    });
    return result;
  } catch (error) {
    if (error.code === 'REEL_PROCESSING_SUPERSEDED') {
      structuredLog('reel_import_run_superseded', jobId, { runId });
      return { superseded: true };
    }
    const failed = await ReelImport.findOne({ _id: jobId, activeRunId: runId }).select('+activeRunId');
    if (failed && failed.status === 'processing' && !failed.cancellationRequested) {
      failed.status = 'failed';
      failed.activeRunId = null;
      failed.queueJobId = null;
      failed.error = { code: error.code || 'REEL_PROCESSING_FAILED', safeMessage: safeProcessingMessage(error) };
      failed.completedAt = new Date();
      await saveProgress(failed, {
        stage: failed.progress?.stage || 'processing_reel',
        percentage: failed.progress?.percentage || 10,
        currentStep: 'Processing failed',
        message: safeProcessingMessage(error),
        stageStatus: 'failed',
        errorCode: error.code || 'REEL_PROCESSING_FAILED',
      });
    }
    structuredLog('reel_import_failed', jobId, {
      durationMs: Date.now() - started,
      code: error.code || 'REEL_PROCESSING_FAILED',
      message: error.message,
    });
    throw error;
  } finally { clearInterval(heartbeat); }
}

async function processQueuedReelImport(bullJob, token) {
  const result = await processReelImportJob(bullJob.data);
  if (result.busy) {
    // Do not mark a still-running/crashed lease as completed or consume attempts.
    // The same queue job will retry after the live lease has released/expired.
    await bullJob.moveToDelayed(Date.now() + 30000, token);
    throw new (require('bullmq').DelayedError)();
  }
  return result;
}

async function requestAiWorker(job, runId) {
  const config = getReelImportConfig();
  const configuredUrl = String(process.env.AI_VIDEO_WORKER_URL || '').replace(/\/$/, '');
  const baseUrl = configuredUrl && !/^https?:\/\//i.test(configuredUrl)
    ? `http://${configuredUrl}`
    : configuredUrl;
  const token = process.env.AI_VIDEO_WORKER_SERVICE_TOKEN;

  if (!baseUrl || !token) {
    // Local/dev path: process with bundled ffmpeg when the Python worker is not configured.
    try {
      return await require('../services/localReelProcessor.service').processReelLocally(job, { runId });
    } catch (error) {
      throw processingError(error.code || 'REEL_PROCESSING_FAILED', error.message || 'Video processing failed.');
    }
  }

  await updateActiveRunProgress(job._id, runId, {
    stage: 'remote_processing',
    percentage: 20,
    currentStep: 'Analyzing reel',
    message: 'The video worker is extracting, checking, and grouping product frames.',
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMinutes * 60 * 1000);
  try {
    const response = await fetch(`${baseUrl}/internal/reel-processing/jobs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jobId: String(job._id),
        videoSource: {
          provider: job.sourceVideo.provider,
          storageKey: job.sourceVideo.storageKey,
          url: job.sourceVideo.url,
        },
        processingConfig: job.processingConfig,
      }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const safeError = data.detail && typeof data.detail === 'object' ? data.detail : data;
      throw processingError(safeError.code || 'AI_WORKER_FAILED', safeError.message || 'Video processing failed.');
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw processingError('REEL_WORKER_TIMEOUT', 'Video processing timed out. You can retry this import.');
    if (error.code) throw error;
    throw processingError('AI_WORKER_UNAVAILABLE', 'The video processing worker could not be reached.');
  } finally {
    clearTimeout(timeout);
  }
}

async function persistCandidates(job, candidates) {
  if (!candidates.length) throw processingError('NO_USABLE_FRAMES', 'No usable product frames were detected. Try better lighting and slower transitions.');
  await ReelCandidate.bulkWrite(candidates.map((candidate, index) => ({ updateOne: { filter: { job: job._id, groupNumber: index + 1 }, upsert: true, update: { $setOnInsert: {
    job: job._id,
    groupNumber: index + 1,
    status: 'suggested',
    sourceRange: candidate.sourceRange || {},
    frames: (candidate.frames || []).map((frame, frameIndex) => ({
      ...frame,
      selected: frame.selected ?? frameIndex < 4,
    })),
    suggestions: candidate.suggestions || {},
    confidence: candidate.confidence || {},
    analysis: candidate.analysis || {},
    adminOverrides: {},
  } } } })));
}

async function enrichCandidatesWithSmartDetails(job, runId, candidates) {
  if (!isVisionEnabled() || !candidates.some((candidate) => !candidate.analysis)) return candidates;
  const categories = await Category.find({ isActive: { $ne: false } }).select('_id name').lean();
  const enriched = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (candidate.analysis) {
      enriched.push(candidate);
      continue;
    }
    await updateActiveRunProgress(job._id, runId, {
      stage: 'analyzing_details',
      percentage: 82 + Math.round((index / Math.max(1, candidates.length)) * 10),
      currentStep: 'Smart product details',
      message: `Identifying catalog details for product ${index + 1} of ${candidates.length}.`,
    });
    const rankedFrames = [...(candidate.frames || [])].sort((left, right) => {
      if (Boolean(left.selected) !== Boolean(right.selected)) return left.selected ? -1 : 1;
      return Number(right.qualityScore || 0) - Number(left.qualityScore || 0);
    });
    const smart = await analyzeCandidateImages({
      groupNumber: candidate.groupNumber || index + 1,
      imageUrls: rankedFrames.map((frame) => frame.url).filter(Boolean).slice(0, 3),
      categories,
      subcategories: [],
    });
    enriched.push({
      ...candidate,
      suggestions: mergeExistingSuggestions(smart.suggestions, candidate.suggestions),
      confidence: mergeConfidence(smart.confidence, candidate.confidence),
      analysis: smart.analysis,
    });
  }
  return enriched;
}

function mergeExistingSuggestions(smart = {}, existing = {}) {
  const merged = { ...smart };
  Object.entries(existing || {}).forEach(([key, value]) => {
    const isGenericName = key === 'name' && /^product\s+\d+$/i.test(String(value || '').trim());
    const hasValue = Array.isArray(value) ? value.length > 0 : String(value || '').trim().length > 0;
    if (hasValue && !isGenericName) merged[key] = value;
  });
  return merged;
}

function mergeConfidence(smart = {}, existing = {}) {
  const keys = new Set([...Object.keys(smart || {}), ...Object.keys(existing || {})]);
  return Object.fromEntries([...keys].map((key) => [key, Math.max(Number(smart?.[key] || 0), Number(existing?.[key] || 0))]));
}

function safeProcessingMessage(error) {
  const safeCodes = new Set([
    'AI_WORKER_UNAVAILABLE',
    'AI_WORKER_FAILED',
    'REEL_WORKER_TIMEOUT',
    'NO_USABLE_FRAMES',
    'INVALID_VIDEO',
    'FFMPEG_UNAVAILABLE',
    'STORAGE_FAILURE',
    'STORAGE_DOWNLOAD_TIMEOUT',
    'STORAGE_DOWNLOAD_INCOMPLETE',
    'STORAGE_UPLOAD_TIMEOUT',
    'REEL_JOB_NOT_FOUND',
  ]);
  if (safeCodes.has(error.code) && error.message) return error.message;
  return error.message || 'The reel could not be processed. Please retry or upload a clearer video.';
}

function processingError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function structuredLog(event, jobId, details = {}) {
  console.log(JSON.stringify({ event, jobId: String(jobId), ...details }));
}

module.exports = { processReelImportJob, processQueuedReelImport, processingError, safeProcessingMessage };
