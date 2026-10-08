const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const Category = require('../models/Category');
const { downloadObject, getStorageProvider, uploadGeneratedImage } = require('./mediaStorage.service');
const { analyzeCandidateFiles, isVisionEnabled, toContextCandidateAnalysis } = require('./reelCandidateVision.service');
const { analyzeProductContext } = require('./productImportContext.service');
const { updateActiveRunProgress } = require('./reelImportProgress.service');
const { selectProductFrames } = require('./productFrameSelection.service');
const { generatedUploadId, fileDigest } = require('./generatedMediaService');

const MAX_PRODUCTS = 8;
const FRAMES_PER_PRODUCT = 3;

function run(binary, args, { timeoutMs = 120000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      child.kill('SIGKILL');
      fail(Object.assign(new Error('Video processing was cancelled or timed out.'), { code: 'REEL_WORKER_TIMEOUT' }));
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(Object.assign(new Error('Video processing timed out.'), { code: 'REEL_WORKER_TIMEOUT' }));
    }, timeoutMs);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => {
      fail(Object.assign(new Error(error.code === 'ENOENT' ? 'FFmpeg is not available for local reel processing.' : error.message), {
        code: 'FFMPEG_UNAVAILABLE',
      }));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(stderr.slice(-280) || 'FFmpeg failed.'), { code: 'FFMPEG_UNAVAILABLE' }));
    });
  });
}

async function probeVideo(filePath, { signal } = {}) {
  const { stdout } = await run(ffprobePath, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ], { timeoutMs: 60000, signal });

  const payload = JSON.parse(stdout || '{}');
  const videoStream = (payload.streams || []).find((stream) => stream.codec_type === 'video') || {};
  const durationSeconds = Number(payload.format?.duration || videoStream.duration || 0);
  return {
    durationSeconds: Math.max(0, Math.round(durationSeconds * 1000) / 1000),
    width: Number(videoStream.width || 0),
    height: Number(videoStream.height || 0),
    codec: String(videoStream.codec_name || ''),
  };
}

function chunkFrames(frames) {
  if (!frames.length) return [];
  const groups = [];
  for (let index = 0; index < frames.length; index += FRAMES_PER_PRODUCT) {
    groups.push(frames.slice(index, index + FRAMES_PER_PRODUCT));
    if (groups.length >= MAX_PRODUCTS) break;
  }
  return groups;
}

async function uploadFrame(frame, jobId, groupNumber, storeId) {
  if (!getStorageProvider()) {
    throw Object.assign(new Error('Cloud storage is required to save product frames.'), { code: 'STORAGE_FAILURE' });
  }
  const stored = await uploadGeneratedImage({
    path: frame.path,
    originalname: `${jobId}-${String(groupNumber).padStart(3, '0')}-${String(Math.round(frame.timestampSeconds * 1000)).padStart(10, '0')}.jpg`,
    mimetype: 'image/jpeg',
  }, { uploadId: generatedUploadId({ namespace: 'reel-frame', ownerId: jobId, storeId, slot: Math.round(frame.timestampSeconds * 1000), recipe: ['frame-v2', frame.selectionVersion || '', await fileDigest({ path: frame.path })] }), recovering: true });
  return {
    provider: stored.provider,
    storageKey: stored.storageKey,
    url: stored.url,
    variants: stored.variants,
    timestampSeconds: Math.round(frame.timestampSeconds * 1000) / 1000,
    qualityScore: frame.qualityScore,
    sharpnessScore: frame.sharpnessScore,
    exposureScore: frame.exposureScore,
    recommended: frame.recommended,
    recommendedCover: frame.recommendedCover,
    viewType: frame.viewType,
    qualityWarnings: frame.qualityWarnings,
    width: frame.width, height: frame.height, selectionVersion: frame.selectionVersion,
  };
}

async function updateProgress(job, runId, stage, percentage, currentStep, message) {
  return updateActiveRunProgress(job._id, runId, {
    stage,
    percentage,
    currentStep,
    message,
  });
}

/**
 * Local reel processor used when the Python AI worker is not configured.
 * Extracts a small set of frames with bundled ffmpeg and groups them into review candidates.
 */
async function processReelLocally(job, { runId } = {}) {
  if (!ffmpegPath || !ffprobePath) {
    throw Object.assign(new Error('FFmpeg is not available for local reel processing.'), { code: 'FFMPEG_UNAVAILABLE' });
  }
  if (!getStorageProvider()) {
    throw Object.assign(new Error('Cloud storage is required for reel processing.'), { code: 'STORAGE_FAILURE' });
  }

  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), `samira-reel-${String(job._id).slice(0, 8)}-`));
  const extension = String(job.sourceVideo?.mimeType || '').includes('webm') ? '.webm' : '.mp4';
  const videoPath = path.join(workspace, `source-video${extension}`);
  const framesDir = path.join(workspace, 'frames');

  try {
    await updateProgress(job, runId, 'downloading_video', 20, 'Downloading video', 'Fetching the reel from storage.');
    await downloadObject({
      provider: job.sourceVideo.provider,
      storageKey: job.sourceVideo.storageKey,
      url: job.sourceVideo.url,
    }, videoPath, {
      expectedSizeBytes: job.sourceVideo.sizeBytes,
      timeoutMs: 3 * 60 * 1000,
    });

    await updateProgress(job, runId, 'reading_video', 32, 'Reading video', 'Checking the reel duration, dimensions, and format.');
    const metadata = await probeVideo(videoPath);

    await updateProgress(job, runId, 'extracting_frames', 45, 'Extracting frames', 'Finding clear product moments throughout the reel.');
    const selection = await selectProductFrames(videoPath, framesDir, { durationSeconds: metadata.durationSeconds, maxFrames: 24, recommendedCount: 24, chronological: true,
      onProgress: (statistics) => updateProgress(job, runId, 'analyzing_frames', 55, 'Checking photo quality', `Checked ${statistics.analyzedFrames} moments; removed ${statistics.rejectedFrames} unclear and ${statistics.duplicateFrames} repeated frames.`) });
    const frames = selection.frames;
    if (!frames.length) {
      throw Object.assign(new Error('No usable product frames were detected. Try a clearer, slower reel.'), { code: 'NO_USABLE_FRAMES' });
    }

    await updateProgress(job, runId, 'analyzing_frames', 58, 'Grouping products', `Found ${frames.length} possible photos. Grouping nearby product views.`);
    const categories = isVisionEnabled()
      ? await Category.find({ isActive: { $ne: false }, isArchived: { $ne: true } }).select('_id name parent definitionKey attributeOverrides').lean()
      : [];
    const structure = isVisionEnabled() ? (await require('./masterConfigurationService').readConfiguration(job.storeId)).structure : {};
    const attributes = structure.attributes || [];
    const context = isVisionEnabled() ? await analyzeProductContext({ videoFiles: [{ path: videoPath }], filePaths: frames.slice(0, 6).map((frame) => frame.path), directory: workspace, categories, attributes, structure }) : null;
    const singleProduct = context?.contextStatus === 'completed' && !context.multipleProducts && Boolean(context.name);
    const groups = singleProduct ? [frames.slice(0, 20)] : chunkFrames(frames);
    const smartDetails = [];
    for (let index = 0; index < groups.length; index += 1) {
      const groupNumber = index + 1;
      const percentage = 62 + Math.round((index / Math.max(1, groups.length)) * 12);
      await updateProgress(
        job,
        runId,
        'analyzing_details',
        percentage,
        'Smart product details',
        isVisionEnabled()
          ? `Identifying product ${groupNumber} of ${groups.length} from multiple reel views.`
          : 'Preparing product groups for admin confirmation.',
      );
      smartDetails.push(singleProduct ? toContextCandidateAnalysis(context, groupNumber, categories) : await analyzeCandidateFiles({
        groupNumber,
        filePaths: groups[index].map((frame) => frame.path),
        videoFiles: [{ path: videoPath, startSeconds: Math.max(0, groups[index][0].timestampSeconds - 2), durationSeconds: Math.min(metadata.durationSeconds, groups[index].at(-1).timestampSeconds - groups[index][0].timestampSeconds + 5) }], directory: workspace, attributes,
        categories, structure,
        subcategories: [],
      }));
    }

    const candidates = [];
    for (let index = 0; index < groups.length; index += 1) {
      const groupNumber = index + 1;
      const group = [...groups[index]].sort((a, b) => Number(b.recommendedCover) - Number(a.recommendedCover) || Number(b.recommended) - Number(a.recommended) || b.qualityScore - a.qualityScore);
      const percentage = 75 + Math.round((index / Math.max(1, groups.length)) * 14);
      await updateProgress(
        job,
        runId,
        'saving_frames',
        percentage,
        'Saving product photos',
        `Saving product group ${groupNumber} of ${groups.length} for review.`,
      );
      const persisted = [];
      for (const frame of group) {
        const uploaded = await uploadFrame(frame, String(job._id), groupNumber, job.storeId);
        persisted.push({ ...uploaded, selected: frame.recommended !== false && persisted.length < (singleProduct ? 6 : 4) });
      }
      candidates.push({
        groupNumber,
        sourceRange: {
          startSeconds: Math.round(Math.min(...group.map((frame) => frame.timestampSeconds)) * 1000) / 1000,
          endSeconds: Math.round(Math.max(...group.map((frame) => frame.timestampSeconds)) * 1000) / 1000,
        },
        frames: persisted,
        ...smartDetails[index],
      });
    }

    await updateProgress(job, runId, 'saving_frames', 90, 'Product photos saved', `${candidates.length} possible product group${candidates.length === 1 ? '' : 's'} prepared.`);

    return {
      jobId: String(job._id),
      status: 'review_required',
      metadata,
      statistics: {
        extractedFrames: selection.statistics.analyzedFrames,
        rejectedFrames: selection.statistics.rejectedFrames,
        duplicateFrames: selection.statistics.duplicateFrames,
        candidateFrames: frames.length,
        detectedProducts: candidates.length,
      },
      candidates,
    };
  } finally {
    if (path.dirname(path.resolve(workspace)) === path.resolve(os.tmpdir()) && path.basename(workspace).startsWith('samira-reel-')) await fsp.rm(workspace, { recursive: true, force: true }).catch(() => null);
  }
}

module.exports = {
  isLocalReelProcessorAvailable: () => Boolean(ffmpegPath && ffprobePath),
  processReelLocally,
};
