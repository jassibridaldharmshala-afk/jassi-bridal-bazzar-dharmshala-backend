function readNumber(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function isReelImportEnabled() {
  const raw = String(process.env.ENABLE_REEL_PRODUCT_IMPORT ?? 'true').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}

function getReelImportConfig() {
  return {
    enabled: isReelImportEnabled(),
    maxDurationSeconds: readNumber('MAX_REEL_DURATION_SECONDS', 180, { min: 1, max: 1800 }),
    maxFileSizeMb: readNumber('MAX_REEL_FILE_SIZE_MB', 250, { min: 1, max: 1024 }),
    framesPerSecond: readNumber('REEL_FRAMES_PER_SECOND', 3, { min: 0.25, max: 12 }),
    sceneThreshold: readNumber('REEL_SCENE_THRESHOLD', 0.3, { min: 0.01, max: 1 }),
    exactDuplicateSimilarity: readNumber('REEL_EXACT_DUPLICATE_SIMILARITY', 0.96, { min: 0, max: 1 }),
    sameProductSimilarity: readNumber('REEL_SAME_PRODUCT_SIMILARITY', 0.88, { min: 0, max: 1 }),
    differentProductSimilarity: readNumber('REEL_DIFFERENT_PRODUCT_SIMILARITY', 0.8, { min: 0, max: 1 }),
    workerConcurrency: readNumber('REEL_WORKER_CONCURRENCY', 1, { min: 1, max: 8 }),
    timeoutMinutes: readNumber('REEL_PROCESSING_TIMEOUT_MINUTES', 20, { min: 1, max: 120 }),
    maxAttempts: readNumber('REEL_JOB_MAX_ATTEMPTS', 3, { min: 1, max: 10 }),
    originalRetentionDays: readNumber('REEL_ORIGINAL_RETENTION_DAYS', 30, { min: 1, max: 365 }),
    rejectedFrameRetentionDays: readNumber('REEL_REJECTED_FRAME_RETENTION_DAYS', 7, { min: 1, max: 90 }),
    tempFileRetentionHours: readNumber('REEL_TEMP_FILE_RETENTION_HOURS', 24, { min: 1, max: 168 }),
  };
}

module.exports = { getReelImportConfig, isReelImportEnabled };
