const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const mongoose = require('mongoose');
const ReelImport = require('../models/ReelImport');
const { downloadObject } = require('../services/mediaStorage.service');
const { applyProgress, getJobHealth } = require('../services/reelImportProgress.service');

test('download-stage jobs become stalled after their heartbeat deadline', () => {
  const health = getJobHealth({
    status: 'processing',
    updatedAt: new Date('2026-09-05T00:05:00.000Z'),
    progress: { stage: 'downloading_video', currentStep: 'Downloading video' },
  }, {
    now: new Date('2026-09-05T00:10:00.000Z'),
    timeoutMinutes: 20,
  });

  assert.equal(health.stage, 'downloading_video');
  assert.equal(health.stale, true);
  assert.equal(health.recoverable, true);
  assert.equal(health.staleAfterSeconds, 240);
});

test('legacy jobs infer the real stage instead of trusting a newly-applied schema default', () => {
  const job = new ReelImport({
    createdBy: new mongoose.Types.ObjectId(),
    sourceVideo: {
      provider: 'r2',
      storageKey: 'reel-imports/original/legacy.mp4',
      originalFilename: 'legacy.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 1024,
      durationSeconds: 10,
    },
    status: 'processing',
    progress: { percentage: 20, currentStep: 'Downloading video' },
  });

  assert.equal(getJobHealth(job).stage, 'downloading_video');
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

  applyProgress(job, {
    stage: 'downloading_video',
    percentage: 20,
    currentStep: 'Downloading video',
    message: 'Fetching the reel.',
    now: new Date('2026-09-05T00:00:00.000Z'),
  });
  applyProgress(job, {
    stage: 'reading_video',
    percentage: 32,
    currentStep: 'Reading video',
    message: 'Inspecting the reel.',
    now: new Date('2026-09-05T00:00:10.000Z'),
  });

  assert.equal(job.stageHistory.length, 2);
  assert.equal(job.stageHistory[0].status, 'completed');
  assert.equal(job.stageHistory[0].durationMs, 10000);
  assert.equal(job.stageHistory[1].status, 'running');
  assert.equal(job.stageHistory[1].attempt, 2);
  assert.equal(job.progress.stage, 'reading_video');
});

test('storage downloads stream to disk and verify the expected byte count', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'samira-reel-download-test-'));
  const destination = path.join(workspace, 'source.mp4');
  const payload = Buffer.from('video-content');
  try {
    await downloadObject({
      provider: 'cloudinary',
      storageKey: 'source.mp4',
      url: `data:video/mp4;base64,${payload.toString('base64')}`,
    }, destination, { expectedSizeBytes: payload.length, timeoutMs: 1000 });

    assert.deepEqual(await fs.readFile(destination), payload);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('a storage request that never responds ends with a retryable timeout', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'samira-reel-timeout-test-'));
  const destination = path.join(workspace, 'source.mp4');
  const originalFetch = global.fetch;
  global.fetch = (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
  try {
    await assert.rejects(
      downloadObject({ provider: 'cloudinary', storageKey: 'source.mp4', url: 'https://storage.invalid/source.mp4' }, destination, { timeoutMs: 25 }),
      (error) => error.code === 'STORAGE_DOWNLOAD_TIMEOUT',
    );
  } finally {
    global.fetch = originalFetch;
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
