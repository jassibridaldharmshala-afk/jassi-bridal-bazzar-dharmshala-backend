const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const mongoose = require('mongoose');
const test = require('node:test');
const assert = require('node:assert/strict');
const { request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createAdmin } = require('./factories');
const Category = require('../models/Category');
const ProductDraft = require('../models/ProductDraft');
const ReelCandidate = require('../models/ReelCandidate');
const ReelImport = require('../models/ReelImport');
const { resumePendingReelImports } = require('../queues/reelImport.queue');
const { applyProgress, getJobHealth } = require('../services/reelImportProgress.service');
const { inspectVideo, resolveFfprobePath } = require('../services/videoMetadata.service');

test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(resetDatabase);

test('admin can inspect reel import readiness and direct-upload support', async () => {
  const { token } = await createAdmin();
  const response = await request('/api/admin/reel-imports/capabilities', { token });

  assert.equal(response.status, 200);
  assert.equal(response.data.data.enabled, true);
  assert.equal(response.data.data.directUploadSupported, true);
  assert.equal(response.data.data.uploadEndpoint, '/api/admin/reel-imports');
  assert.equal(typeof response.data.data.storageConfigured, 'boolean');
  assert.equal(typeof response.data.data.workerConfigured, 'boolean');
  assert.equal(typeof response.data.data.smartSuggestionsEnabled, 'boolean');
  assert.ok(response.data.data.trackedStages.includes('Smart product details'));
  assert.ok(Array.isArray(response.data.data.issues));
});

test('reel import readiness is protected by admin authentication', async () => {
  const response = await request('/api/admin/reel-imports/capabilities');
  assert.equal(response.status, 401);
});

test('video validation uses the bundled ffprobe binary by default', () => {
  const previous = process.env.FFPROBE_PATH;
  delete process.env.FFPROBE_PATH;
  try {
    const binary = resolveFfprobePath();
    assert.ok(binary);
    assert.equal(fs.existsSync(binary), true);
  } finally {
    if (previous === undefined) delete process.env.FFPROBE_PATH;
    else process.env.FFPROBE_PATH = previous;
  }
});

test('bundled video tools generate and validate an MP4 reel', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'samira-reel-test-'));
  const videoPath = path.join(workspace, 'valid-reel.mp4');
  try {
    const generated = spawnSync(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=white:s=320x480:d=1',
      '-pix_fmt', 'yuv420p', videoPath,
    ], { windowsHide: true, encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr || 'FFmpeg failed to create the test reel.');

    const metadata = await inspectVideo(videoPath);
    assert.equal(metadata.width, 320);
    assert.equal(metadata.height, 480);
    assert.ok(metadata.durationSeconds > 0);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('pending in-process imports are re-queued after a server restart', async () => {
  const { user } = await createAdmin();
  const previousRedisUrl = process.env.REDIS_URL;
  delete process.env.REDIS_URL;
  const job = await ReelImport.create({
    createdBy: user._id,
    sourceVideo: {
      provider: 'r2',
      storageKey: 'reel-imports/original/recovery.mp4',
      url: 'https://example.test/recovery.mp4',
      originalFilename: 'recovery.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 1024,
      durationSeconds: 12,
    },
    status: 'processing',
    progress: { percentage: 40, currentStep: 'Reading video', message: 'Processing' },
  });
  const scheduled = [];

  try {
    const result = await resumePendingReelImports({ schedule: async (payload) => scheduled.push(payload) });
    const refreshed = await ReelImport.findById(job._id);

    assert.equal(result.resumed, 1);
    assert.equal(scheduled.length, 1);
    assert.equal(String(scheduled[0].jobId), String(job._id));
    assert.equal(refreshed.status, 'queued');
    assert.match(refreshed.progress.message, /resumed/i);
  } finally {
    if (previousRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previousRedisUrl;
  }
});

test('download-stage jobs become stalled after their heartbeat deadline', () => {
  const now = new Date('2026-09-05T00:10:00.000Z');
  const job = {
    status: 'processing',
    updatedAt: new Date('2026-09-05T00:05:00.000Z'),
    progress: { stage: 'downloading_video', currentStep: 'Downloading video' },
  };

  const health = getJobHealth(job, { now, timeoutMinutes: 20 });

  assert.equal(health.stage, 'downloading_video');
  assert.equal(health.stale, true);
  assert.equal(health.recoverable, true);
  assert.equal(health.staleAfterSeconds, 240);
});

test('progress tracking completes the previous stage and records the current attempt', () => {
  const job = new ReelImport({
    createdBy: new mongoose.Types.ObjectId(),
    sourceVideo: {
      provider: 'r2',
      storageKey: 'reel-imports/original/tracking.mp4',
      originalFilename: 'tracking.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 1024,
      durationSeconds: 10,
    },
    status: 'processing',
    attemptCount: 2,
  });
  const first = new Date('2026-09-05T00:00:00.000Z');
  const second = new Date('2026-09-05T00:00:10.000Z');

  applyProgress(job, {
    stage: 'downloading_video',
    percentage: 20,
    currentStep: 'Downloading video',
    message: 'Fetching the reel.',
    now: first,
  });
  applyProgress(job, {
    stage: 'reading_video',
    percentage: 32,
    currentStep: 'Reading video',
    message: 'Inspecting the reel.',
    now: second,
  });

  assert.equal(job.stageHistory.length, 2);
  assert.equal(job.stageHistory[0].status, 'completed');
  assert.equal(job.stageHistory[0].durationMs, 10000);
  assert.equal(job.stageHistory[1].status, 'running');
  assert.equal(job.stageHistory[1].attempt, 2);
  assert.equal(job.progress.stage, 'reading_video');
});

test('polling an abandoned download converts it to a retryable terminal failure', async () => {
  const { user, token } = await createAdmin();
  const job = await ReelImport.create({
    createdBy: user._id,
    sourceVideo: {
      provider: 'r2',
      storageKey: 'reel-imports/original/stalled.mp4',
      url: 'https://example.test/stalled.mp4',
      originalFilename: 'stalled.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 1024,
      durationSeconds: 12,
    },
    status: 'processing',
    attemptCount: 1,
    activeRunId: 'abandoned-run',
    progress: {
      percentage: 20,
      stage: 'downloading_video',
      currentStep: 'Downloading video',
      message: 'Fetching the reel from storage.',
    },
  });
  const old = new Date(Date.now() - 5 * 60 * 1000);
  await ReelImport.collection.updateOne({ _id: job._id }, {
    $set: {
      updatedAt: old,
      lastHeartbeatAt: old,
      'progress.updatedAt': old,
    },
  });

  const response = await request(`/api/admin/reel-imports/${job._id}`, { token });

  assert.equal(response.status, 200);
  assert.equal(response.data.data.status, 'failed');
  assert.equal(response.data.data.error.code, 'REEL_PROCESSING_STALLED');
  assert.equal(response.data.data.health.recoverable, true);
  assert.equal(response.data.data.health.stalled, false);
  assert.match(response.data.data.error.safeMessage, /retried/i);
});

test('smart reel suggestions are preserved when a candidate becomes a product draft', async () => {
  const { user, token } = await createAdmin();
  const category = await Category.create({ name: 'Sarees', slug: 'sarees', isActive: true });
  const job = await ReelImport.create({
    createdBy: user._id,
    sourceVideo: {
      provider: 'r2',
      storageKey: 'reel-imports/original/smart-draft.mp4',
      originalFilename: 'smart-draft.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 1024,
      durationSeconds: 10,
    },
    status: 'review_required',
    progress: { percentage: 100, stage: 'ready_for_review', currentStep: 'Ready for review' },
  });
  const candidate = await ReelCandidate.create({
    job: job._id,
    groupNumber: 1,
    frames: [{
      provider: 'r2',
      storageKey: 'reel-imports/frames/saree.jpg',
      url: 'https://example.test/saree.jpg',
      timestampSeconds: 2,
      qualityScore: 0.9,
      selected: true,
    }],
    suggestions: {
      name: 'Teal Zari Silk Saree',
      category: String(category._id),
      categoryName: 'Sarees',
      primaryColor: 'Teal',
      secondaryColors: ['Magenta'],
      pattern: 'Zari woven',
      fabric: 'Silk blend',
      occasion: ['Festive'],
      tags: ['zari', 'festive', 'reel-import'],
      shortDescription: 'A teal saree with a magenta zari border.',
      description: 'A teal silk-look saree with a contrasting magenta zari border.',
      sizingMode: 'free-size',
    },
    confidence: { overall: 0.86 },
    analysis: { status: 'completed', source: 'gemini-vision', model: 'gemini-test' },
  });

  const response = await request(`/api/admin/reel-imports/${job._id}/create-drafts`, {
    method: 'POST',
    token,
    body: { candidateIds: [String(candidate._id)] },
  });
  const draft = await ProductDraft.findOne({ sourceCandidateId: candidate._id });

  assert.equal(response.status, 201);
  assert.equal(draft.name, 'Teal Zari Silk Saree');
  assert.equal(String(draft.category), String(category._id));
  assert.equal(draft.fabric, 'Silk blend');
  assert.equal(draft.sizingMode, 'free-size');
  assert.deepEqual(draft.colors, ['Teal', 'Magenta']);
  assert.match(draft.description, /magenta zari border/i);
});
