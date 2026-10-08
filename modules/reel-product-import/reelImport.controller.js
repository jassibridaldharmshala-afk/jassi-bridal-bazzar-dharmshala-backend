const fs = require('fs/promises');
const mongoose = require('mongoose');
const path = require('path');
const { asyncHandler } = require('../../middleware/validate');
const Category = require('../../models/Category');
const ProductDraft = require('../../models/ProductDraft');
const DeletedProductDraft = require('../../models/DeletedProductDraft');
const ReelCandidate = require('../../models/ReelCandidate');
const ReelImport = require('../../models/ReelImport');
const { getReelImportConfig } = require('../../config/reelImport');
const { enqueueReelImport, removeQueuedReelImport } = require('../../queues/reelImport.queue');
const { deleteObject, getStorageProvider, objectExists, uploadOriginalVideo } = require('../../services/mediaStorage.service');
const { analyzeStoredCandidate, isVisionEnabled } = require('../../services/reelCandidateVision.service');
const { inspectVideo } = require('../../services/videoMetadata.service');
const { runUploadRequest } = require('../../services/uploadRetryService');
const UploadOperation = require('../../models/UploadOperation');
const { andFilter } = require('../../services/storeService');
const { ApiError } = require('../../utils/apiError');
const { isLocalReelProcessorAvailable } = require('../../services/localReelProcessor.service');
const {
  failStalledJob,
  publicHealth,
  saveProgress,
} = require('../../services/reelImportProgress.service');
const slugify = require('../../utils/slugify');
const {
  escapeRegExp,
  parsePagination,
  safeOriginalFilename,
  validateVideoFile,
  validationError,
} = require('./reelImport.validation');

async function createImport(req, res, next) {
  const file = req.file;
  if (!file && req.body?.sourceVideo) {
    return createImportFromStoredVideo(req, res, next);
  }
  try {
    const resume = req.body?.resumeUpload === true && !file;
    if (!resume) {
      const fileError = validateVideoFile(file);
      if (fileError) throw fileError;
    }
    const config = getReelImportConfig();
    if (!config.enabled) throw serviceUnavailable('REEL_IMPORT_DISABLED', 'Reel Product Import is currently disabled.');
    req.files = file ? [file] : [];
    const ownedJob = id => ReelImport.findOne({ _id: id, createdBy: req.user._id, ...(req.store?._id ? { storeId: req.store._id } : {}) });
    const result = await runUploadRequest(req, async context => {
      const stored = context.resume ? context.storedFiles[0] : await context.upload(file, 0, async options => {
        const metadata = await inspectVideo(file.path);
        if (metadata.durationSeconds > config.maxDurationSeconds) throw validationError('VIDEO_TOO_LONG', `Video duration must be ${config.maxDurationSeconds} seconds or less.`);
        const uploaded = await uploadOriginalVideo(file, options);
        return { ...uploaded, publicId: uploaded.storageKey, originalFilename: safeOriginalFilename(file.originalname), mimeType: file.mimetype, sizeBytes: file.size, ...metadata };
      });
      const id = context.managed ? new mongoose.Types.ObjectId(context.id.slice(0, 24)) : new mongoose.Types.ObjectId();
      if (context.managed) await UploadOperation.updateOne({ _id: context.id, status: 'RUNNING' }, { $set: { recordId: String(id) } });
      let reelImport = context.managed ? await ownedJob(id) : null;
      if (!reelImport) reelImport = await ReelImport.create({
        _id: id,
        createdBy: req.user._id,
        storeId: req.store?._id,
        sourceVideo: stored,
        status: 'uploaded',
        progress: {
          percentage: 5,
          stage: 'validating_video',
          currentStep: 'Validating video',
          message: 'Video uploaded and validated.',
          startedAt: new Date(),
          updatedAt: new Date(),
        },
        processingConfig: {
          framesPerSecond: config.framesPerSecond,
          sceneThreshold: config.sceneThreshold,
          duplicateThreshold: config.exactDuplicateSimilarity,
          clusteringThreshold: config.sameProductSimilarity,
        },
        retentionExpiresAt: new Date(Date.now() + config.originalRetentionDays * 86400000),
      });
      // A record recovered after receipt-save failure must not enqueue again.
      if (reelImport.status !== 'uploaded' && !(reelImport.status === 'queued' && !reelImport.queueJobId && !reelImport.attemptCount)) return { jobId: String(reelImport._id) };
      reelImport.status = 'queued';
      await saveProgress(reelImport, { stage: 'queued', percentage: 8, currentStep: 'Queued', message: 'The reel is waiting for the processing worker.' });
      try {
        const queued = await enqueueReelImport({ jobId: reelImport._id, storageKey: stored.storageKey, attemptNumber: 1 });
        if (queued.queueJobId) {
          reelImport.queueJobId = queued.queueJobId;
          await ReelImport.updateOne({ _id: reelImport._id }, { $set: { queueJobId: queued.queueJobId } });
        }
      } catch (error) {
        // Upload and job creation succeeded. Return the recoverable job, with
        // its existing Retry action, instead of making the UI upload again.
        if (!reelImport.queueJobId) {
          reelImport.status = 'failed';
          reelImport.activeRunId = null;
          reelImport.queueJobId = null;
          reelImport.error = { code: error.code || 'REEL_QUEUE_UNAVAILABLE', safeMessage: error.message };
          await saveProgress(reelImport, {
          stage: reelImport.progress?.stage || 'queued',
          percentage: reelImport.progress?.percentage || 5,
          currentStep: 'Processing unavailable',
          message: error.message,
          stageStatus: 'failed',
          errorCode: error.code || 'REEL_QUEUE_UNAVAILABLE',
          });
        } else throw error;
      }
      return { jobId: String(reelImport._id) };
    }, { resume });
    const reelImport = await ownedJob(result.jobId);
    if (!reelImport) throw new ApiError('UPLOAD_RETRY_CONFLICT', 'This import was removed. Start a new import.', { statusCode: 409 });
    return res.status(202).json({ success: true, data: formatJob(reelImport) });
  } catch (error) {
    if (error.statusCode) res.status(error.statusCode);
    return next(error);
  } finally {
    if (file?.path) await fs.unlink(file.path).catch(() => null);
  }
}

async function createImportFromStoredVideo(req, res, next) {
  try {
    const source = req.body.sourceVideo || {};
    const config = getReelImportConfig();
    if (!config.enabled) throw serviceUnavailable('REEL_IMPORT_DISABLED', 'Reel Product Import is currently disabled.');
    const provider = getStorageProvider();
    const sizeBytes = Number(source.sizeBytes || 0);
    if (!provider) {
      throw validationError(
        'REEL_STORAGE_NOT_CONFIGURED',
        'Reel Product Import needs Cloudflare R2 or Cloudinary. Add those keys in backend/.env, then restart the server.',
      );
    }
    if (provider !== source.provider || !source.storageKey) {
      throw validationError(
        'INVALID_STORAGE_REFERENCE',
        'The uploaded video is missing a valid cloud storage reference. Re-upload after R2 or Cloudinary is connected.',
      );
    }
    if (!['video/mp4', 'video/quicktime', 'video/webm'].includes(String(source.mimeType || '').toLowerCase())) {
      throw validationError('UNSUPPORTED_VIDEO_FORMAT', 'Only MP4, MOV, and WebM videos are supported.');
    }
    if (!sizeBytes || sizeBytes > config.maxFileSizeMb * 1024 * 1024) {
      throw validationError('VIDEO_TOO_LARGE', `The reel must be ${config.maxFileSizeMb}MB or smaller.`);
    }
    const storedVideo = {
      provider,
      storageKey: String(source.storageKey),
      url: String(source.url || ''),
    };
    if (!await objectExists(storedVideo)) {
      throw validationError('STORED_VIDEO_NOT_FOUND', 'The uploaded video could not be found in cloud storage.');
    }
    const existing = await ReelImport.findOne(andFilter({
      createdBy: req.user._id,
      'sourceVideo.provider': provider,
      'sourceVideo.storageKey': storedVideo.storageKey,
    }, req.tenantFilter));
    if (existing) return res.status(200).json({ success: true, data: formatJob(existing) });

    const recordId = new mongoose.Types.ObjectId(require('node:crypto').createHash('sha256').update(JSON.stringify([String(req.store?._id || ''), String(req.user._id), provider, storedVideo.storageKey])).digest('hex').slice(0, 24));
    let reelImport;
    try { reelImport = await ReelImport.create({
      _id: recordId,
      storeId: req.store?._id,
      createdBy: req.user._id,
      sourceVideo: {
        ...storedVideo,
        originalFilename: safeOriginalFilename(source.originalFilename),
        mimeType: source.mimeType,
        sizeBytes,
        durationSeconds: 0,
      },
      status: 'uploaded',
      progress: {
        percentage: 5,
        stage: 'validating_video',
        currentStep: 'Validating video',
        message: 'Cloud upload verified. Preparing background processing.',
        startedAt: new Date(),
        updatedAt: new Date(),
      },
      processingConfig: {
        framesPerSecond: config.framesPerSecond,
        sceneThreshold: config.sceneThreshold,
        duplicateThreshold: config.exactDuplicateSimilarity,
        clusteringThreshold: config.sameProductSimilarity,
      },
      retentionExpiresAt: new Date(Date.now() + config.originalRetentionDays * 86400000),
    }); } catch (error) {
      if (error.code !== 11000) throw error;
      const recovered = await ReelImport.findOne({ _id: recordId, createdBy: req.user._id });
      if (!recovered) throw error;
      return res.status(200).json({ success: true, data: formatJob(recovered) });
    }
    try {
      reelImport.status = 'queued';
      await saveProgress(reelImport, {
        stage: 'queued',
        percentage: 8,
        currentStep: 'Queued',
        message: 'The reel is waiting for the processing worker.',
      });
      const queued = await enqueueReelImport({
        jobId: reelImport._id,
        storageKey: storedVideo.storageKey,
        attemptNumber: 1,
      });
      if (queued.queueJobId) {
        reelImport.queueJobId = queued.queueJobId;
        await ReelImport.updateOne({ _id: reelImport._id }, { $set: { queueJobId: queued.queueJobId } });
      }
    } catch (error) {
      reelImport.status = 'failed';
      reelImport.activeRunId = null;
      reelImport.queueJobId = null;
      reelImport.error = {
        code: error.code || 'REEL_QUEUE_UNAVAILABLE',
        safeMessage: 'The video was uploaded, but background processing is not available yet. Configure the worker and retry.',
      };
      await saveProgress(reelImport, {
        stage: reelImport.progress?.stage || 'queued',
        percentage: reelImport.progress?.percentage || 5,
        currentStep: 'Processing unavailable',
        message: reelImport.error.safeMessage,
        stageStatus: 'failed',
        errorCode: reelImport.error.code,
      });
      return res.status(202).json({
        success: true,
        data: formatJob(reelImport),
        warning: reelImport.error.safeMessage,
      });
    }
    return res.status(202).json({ success: true, data: formatJob(reelImport) });
  } catch (error) {
    if (error.statusCode) res.status(error.statusCode);
    return next(error);
  }
}

async function getUploadCapabilities(req, res) {
  const config = getReelImportConfig();
  const storageProvider = getStorageProvider();
  const remoteWorkerConfigured = Boolean(String(process.env.AI_VIDEO_WORKER_URL || '').trim())
    && Boolean(String(process.env.AI_VIDEO_WORKER_SERVICE_TOKEN || '').trim());
  const localProcessorAvailable = isLocalReelProcessorAvailable();
  const processingConfigured = remoteWorkerConfigured || localProcessorAvailable;
  const issues = [];
  if (!config.enabled) issues.push('Reel Product Import is disabled on the server.');
  if (!storageProvider) issues.push('Connect Cloudflare R2 or Cloudinary before uploading reels.');
  if (!processingConfigured) issues.push('No video-processing worker or local FFmpeg runtime is available.');
  res.json({
    success: true,
    data: {
      enabled: config.enabled,
      ready: config.enabled && Boolean(storageProvider) && processingConfigured,
      directUploadSupported: true,
      uploadEndpoint: '/api/admin/reel-imports',
      formats: ['MP4', 'MOV', 'WebM'],
      maxDurationSeconds: config.maxDurationSeconds,
      maxFileSizeMb: config.maxFileSizeMb,
      storageConfigured: Boolean(storageProvider),
      storageProvider: storageProvider || null,
      queueConfigured: Boolean(String(process.env.REDIS_URL || '').trim()),
      queueMode: process.env.REDIS_URL ? 'redis' : 'in-process',
      workerConfigured: processingConfigured,
      processingMode: remoteWorkerConfigured ? 'remote-worker' : (localProcessorAvailable ? 'local-ffmpeg' : null),
      remoteWorkerConfigured,
      localProcessorAvailable,
      smartSuggestionsEnabled: isVisionEnabled(),
      smartSuggestionsMessage: isVisionEnabled()
        ? 'Smart Reel Assistant reads product views, video text and speech. Stated product prices can be filled automatically.'
        : 'The Gemini API key is missing. Add GEMINI_API_KEY in backend/.env, restart the backend, then check the connection here.',
      smartSuggestionsReason: isVisionEnabled() ? '' : 'GEMINI_KEY_MISSING',
      progressTracking: true,
      processingTimeoutMinutes: config.timeoutMinutes,
      trackedStages: [
        'Queued',
        'Preparing video',
        'Downloading video',
        'Reading video',
        'Extracting frames',
        'Grouping products',
        'Smart product details',
        'Saving product photos',
        'Finalizing results',
        'Ready for review',
      ],
      issues,
    },
  });
}

function serviceUnavailable(code, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 503;
  return error;
}

async function listImports(req, res) {
  const { page, limit, skip } = parsePagination(req.query);
  const query = { createdBy: req.user._id };
  const allowedStatuses = ReelImport.schema.path('status').enumValues;
  if (req.query.status && allowedStatuses.includes(req.query.status)) query.status = req.query.status;
  if (req.query.search) {
    query['sourceVideo.originalFilename'] = { $regex: escapeRegExp(req.query.search).slice(0, 100), $options: 'i' };
  }
  const [foundItems, total] = await Promise.all([
    ReelImport.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit),
    ReelImport.countDocuments(query),
  ]);
  const items = await Promise.all(foundItems.map((job) => failStalledJob(job)));
  res.json({
    success: true,
    data: items.map(formatJob),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
}

async function getImport(req, res) {
  let job = await findOwnedJob(req);
  if (!job) return res.status(404).json({ success: false, message: 'Reel import not found.' });
  job = await failStalledJob(job);
  res.json({ success: true, data: formatJob(job) });
}

async function listCandidates(req, res) {
  const job = await findOwnedJob(req);
  if (!job) return res.status(404).json({ success: false, message: 'Reel import not found.' });
  const candidates = await ReelCandidate.find({ job: job._id }).sort({ groupNumber: 1 });
  const drafts = await ProductDraft.find({ sourceCandidateId: { $in: candidates.map((item) => item._id) } }).lean();
  const receipts = await DeletedProductDraft.find({ sourceCandidateId: { $in: candidates.map((item) => item._id) } }).lean();
  const productIds = [...drafts.map(item => item.publishedProductId), ...receipts.map(item => item.productId)].filter(Boolean);
  const products = productIds.length ? await require('../../models/Product').find({ _id: { $in: productIds } }).select('name').lean() : [];
  const productMap = new Map(products.map(item => [String(item._id), item]));
  for (const draft of drafts) if (draft.publishedProductId) draft.publishedProductDeleted = !productMap.has(String(draft.publishedProductId));
  drafts.push(...receipts.map(item => ({ _id: item.draftId, name: productMap.get(String(item.productId))?.name || 'Deleted product', sourceCandidateId: item.sourceCandidateId, status: 'published', publishedProductId: item.productId, publishedProductDeleted: !productMap.has(String(item.productId)), draftRemoved: true })));
  res.json({ success: true, data: candidates.map((candidate) => ({ ...formatCandidate(candidate), savedDraft: drafts.find((draft) => String(draft.sourceCandidateId) === String(candidate._id)) })) });
}

async function retryImport(req, res, next) {
  try {
    let job = await findOwnedJob(req, '+sourceVideo.url +activeRunId');
    if (!job) return res.status(404).json({ success: false, message: 'Reel import not found.' });
    job = await failStalledJob(job);
    if (!['failed', 'cancelled'].includes(job.status)) {
      return res.status(409).json({ success: false, message: 'This import is still active. Cancel it before starting a new attempt.' });
    }
    job.status = 'queued';
    job.cancellationRequested = false;
    job.completedAt = undefined;
    job.activeRunId = null;
    job.queueJobId = null;
    job.error = undefined;
    await saveProgress(job, {
      stage: 'queued',
      percentage: 8,
      currentStep: 'Queued',
      message: `Retry attempt ${Number(job.attemptCount || 0) + 1} is waiting for the processing worker.`,
    });
    try {
      const queued = await enqueueReelImport({
        jobId: job._id,
        storageKey: job.sourceVideo.storageKey,
        attemptNumber: Number(job.attemptCount || 0) + 1,
      });
      if (queued.queueJobId) {
        job.queueJobId = queued.queueJobId;
        await ReelImport.updateOne({ _id: job._id }, { $set: { queueJobId: queued.queueJobId } });
      }
    } catch (error) {
      job.status = 'failed';
      job.queueJobId = null;
      job.error = { code: error.code || 'REEL_QUEUE_UNAVAILABLE', safeMessage: error.message };
      await saveProgress(job, {
        stage: 'queued',
        percentage: 8,
        currentStep: 'Retry unavailable',
        message: error.message,
        stageStatus: 'failed',
        errorCode: job.error.code,
      });
      throw error;
    }
    res.status(202).json({ success: true, data: formatJob(job) });
  } catch (error) {
    if (error.statusCode) res.status(error.statusCode);
    next(error);
  }
}

async function cancelImport(req, res) {
  const job = await findOwnedJob(req, '+activeRunId');
  if (!job) return res.status(404).json({ success: false, message: 'Reel import not found.' });
  if (['completed', 'review_required'].includes(job.status)) {
    return res.status(409).json({ success: false, message: 'This import has already finished processing.' });
  }
  await removeQueuedReelImport(job.queueJobId || job._id).catch(() => false);
  job.cancellationRequested = true;
  job.status = 'cancelled';
  job.activeRunId = null;
  job.queueJobId = null;
  job.completedAt = new Date();
  await saveProgress(job, {
    stage: job.progress?.stage || 'processing_reel',
    percentage: job.progress?.percentage || 0,
    currentStep: 'Cancelled',
    message: 'Processing was cancelled.',
    stageStatus: 'cancelled',
  });
  res.json({ success: true, data: formatJob(job) });
}

async function deleteImport(req, res, next) {
  try {
    const job = await findOwnedJob(req, '+sourceVideo.url');
    if (!job) return res.status(404).json({ success: false, message: 'Reel import not found.' });
    if (['processing', 'creating_drafts'].includes(job.status)) {
      return res.status(409).json({ success: false, message: 'Cancel processing before deleting this import.' });
    }
    const hasDraft = await ReelCandidate.exists({ job: job._id, productDraft: { $ne: null } });
    if (hasDraft) return res.status(409).json({ success: false, message: 'Imports linked to product drafts cannot be deleted.' });
    await deleteObject(job.sourceVideo).catch(() => false);
    await ReelCandidate.deleteMany({ job: job._id });
    await job.deleteOne();
    await require('../../services/recordCreationService').invalidateRecordCreation(job._id);
    res.json({ success: true, message: 'Reel import deleted.' });
  } catch (error) {
    next(error);
  }
}

async function updateCandidate(req, res) {
  const context = await findOwnedCandidate(req);
  if (!context) return res.status(404).json({ success: false, message: 'Candidate not found.' });
  const { candidate } = context;
  const body = req.body || {};
  if (candidate.productDraft && (await ProductDraft.exists({ _id: candidate.productDraft, status: 'published' }) || await DeletedProductDraft.exists({ draftId: candidate.productDraft }))) return res.status(409).json({ success: false, message: 'This product is published. Use Edit product to change its catalog details.' });
  if (body.status && ['suggested', 'approved', 'ignored'].includes(body.status)) candidate.status = body.status;
  if (body.suggestions && typeof body.suggestions === 'object') {
    candidate.suggestions = { ...candidate.suggestions?.toObject?.() || candidate.suggestions || {}, ...pickSuggestions(body.suggestions) };
  }
  if (body.adminOverrides && typeof body.adminOverrides === 'object') {
    candidate.adminOverrides = { ...(candidate.adminOverrides || {}), ...pickAdminOverrides(body.adminOverrides) };
  }
  if (Array.isArray(body.selectedFrameIds)) {
    const selected = new Set(body.selectedFrameIds.map(String));
    candidate.frames.forEach((frame) => { frame.selected = selected.has(String(frame._id)); });
  }
  candidate.audit.push({ action: 'updated', by: req.user._id, details: { fields: Object.keys(body) } });
  await candidate.save();
  if (candidate.productDraft) {
    const draft = await ProductDraft.findById(candidate.productDraft);
    if (draft && draft.status !== 'published') {
      const overrides = pickAdminOverrides(body.adminOverrides || {});
      for (const key of ['name', 'subCategory', 'fabric', 'description', 'shortDescription', 'highlights', 'careInstructions', 'metaTitle', 'metaDescription', 'metaKeywords', 'sizeChart', 'sizeChartProfile', 'attributeValues']) if (overrides[key] !== undefined) draft[key] = overrides[key];
      if (overrides.category !== undefined) draft.category = (await resolveCategory(overrides.category))?._id;
      if (overrides.primaryColor !== undefined) draft.colors = listValue(overrides.primaryColor);
      if (overrides.occasion !== undefined) draft.occasion = listValue(overrides.occasion).join(', ');
      for (const key of ['sizes', 'tags']) if (overrides[key] !== undefined) draft[key] = listValue(overrides[key]);
      if (overrides.sizingMode !== undefined) draft.sizingMode = normalizeSizingMode(overrides.sizingMode);
      for (const key of ['price', 'originalPrice', 'stock']) if (overrides[key] !== undefined) draft[key] = overrides[key] === '' ? undefined : overrides[key];
      if (overrides.price !== undefined) draft.sellingPrice = draft.price;
      if (draft.originalPrice === 0 && overrides.originalPrice === undefined) draft.originalPrice = undefined;
      if (Array.isArray(body.selectedFrameIds)) {
        const frames = candidate.frames.filter((frame) => frame.selected).sort((a, b) => Number(String(b._id) === String(candidate.adminOverrides.primaryFrameId)) - Number(String(a._id) === String(candidate.adminOverrides.primaryFrameId)));
        const addedPhotos = draft.images.filter((image) => !candidate.frames.some((frame) => frame.url === image.url)).map((image) => image.toObject());
        const chosenFrame = frames.some((frame) => String(frame._id) === String(candidate.adminOverrides.primaryFrameId));
        const addedCover = !chosenFrame && addedPhotos.find((image) => image.primary);
        draft.images = [...frames.map((frame, index) => ({ url: frame.url, publicId: frame.storageKey, variants: frame.variants, primary: !addedCover && index === 0, sourceFrame: { timestampSeconds: frame.timestampSeconds, qualityScore: frame.qualityScore, viewType: frame.viewType, width: frame.width, height: frame.height, selectionVersion: frame.selectionVersion } })), ...addedPhotos.map((image) => ({ ...image, primary: image === addedCover }))];
        if (draft.images.length && !draft.images.some((image) => image.primary)) draft.images[0].primary = true;
        draft.image = draft.images.find((image) => image.primary)?.url || '';
      }
      await draft.save();
    }
  }
  res.json({ success: true, data: formatCandidate(candidate) });
}

async function analyzeCandidate(req, res, next) {
  try {
    if (!isVisionEnabled()) {
      throw serviceUnavailable(
        'SMART_SUGGESTIONS_UNAVAILABLE',
        'The Gemini API key is missing. Add GEMINI_API_KEY in backend/.env and restart the backend to enable Smart Reel Assistant.',
      );
    }
    const context = await findOwnedCandidate(req);
    if (!context) return res.status(404).json({ success: false, message: 'Candidate not found.' });
    const { candidate, job } = context;
    const linkedDraft = candidate.productDraft ? await ProductDraft.findById(candidate.productDraft) : null;
    if (candidate.status === 'merged' || linkedDraft?.status === 'published' || await DeletedProductDraft.exists({ sourceCandidateId: candidate._id })) {
      return res.status(409).json({ success: false, message: 'This candidate can no longer be analyzed.' });
    }
    if (Array.isArray(req.body?.selectedFrameIds)) {
      const selected = new Set(req.body.selectedFrameIds.map(String));
      candidate.frames.forEach((frame) => { frame.selected = selected.has(String(frame._id)); });
    }
    const rankedFrames = candidate.frames.filter((frame) => frame.selected).sort((left, right) => {
      if (Boolean(left.selected) !== Boolean(right.selected)) return left.selected ? -1 : 1;
      return Number(right.qualityScore || 0) - Number(left.qualityScore || 0);
    });
    const imageUrls = rankedFrames.map((frame) => frame.url).filter(Boolean).slice(0, 3);
    if (!imageUrls.length) {
      return res.status(400).json({ success: false, message: 'Select at least one saved candidate photo first.' });
    }
    const categories = await Category.find({ isActive: { $ne: false } }).select('_id name').lean();
    const configuration = await require('../../services/masterConfigurationService').readConfiguration();
    const sourceJob = await ReelImport.findById(job._id).select('+sourceVideo.url');
    const result = await analyzeStoredCandidate({
      groupNumber: candidate.groupNumber,
      frames: rankedFrames,
      sourceVideo: sourceJob.sourceVideo, sourceRange: candidate.sourceRange,
      categories,
      attributes: configuration.structure.attributes,
      structure: configuration.structure,
    });
    // A failed refresh must never replace useful suggestions with "Product N".
    if (result.analysis.status === 'completed') {
      candidate.suggestions = result.suggestions;
      candidate.confidence = result.confidence;
    }
    candidate.analysis = result.analysis;
    candidate.audit.push({
      action: result.analysis.status === 'completed' ? 'smart_analyzed' : 'smart_analysis_failed',
      by: req.user._id,
      details: { photoCount: imageUrls.length, source: result.analysis.source, error: result.analysis.error, errorCode: result.analysis.errorCode },
    });
    await candidate.save();
    res.json({
      success: true,
      data: { ...formatCandidate(candidate), ...(linkedDraft ? { savedDraft: linkedDraft.toObject() } : {}) },
      warning: result.analysis.status === 'failed' ? result.analysis.error : undefined,
    });
  } catch (error) {
    if (error.statusCode) res.status(error.statusCode);
    next(error);
  }
}

async function mergeCandidates(req, res) {
  const ids = uniqueIds(req.body?.candidateIds);
  if (ids.length < 2) return res.status(400).json({ success: false, message: 'Select at least two candidates to merge.' });
  const job = await findOwnedJob(req);
  if (!job) return res.status(404).json({ success: false, message: 'Reel import not found.' });
  const candidates = await ReelCandidate.find({ _id: { $in: ids }, job: job._id, status: { $ne: 'merged' } });
  if (candidates.length !== ids.length) return res.status(400).json({ success: false, message: 'One or more candidates cannot be merged.' });
  if (candidates.some((item) => item.productDraft)) {
    return res.status(409).json({ success: false, message: 'A candidate linked to a draft cannot be merged.' });
  }
  const maxGroup = await ReelCandidate.findOne({ job: job._id }).sort({ groupNumber: -1 }).select('groupNumber');
  const frames = selectBestFrames(dedupeFrames(candidates.flatMap((candidate) => candidate.frames)));
  const best = [...candidates].sort((a, b) => Number(b.confidence?.overall || 0) - Number(a.confidence?.overall || 0))[0];
  const merged = await ReelCandidate.create({
    job: job._id,
    groupNumber: Number(maxGroup?.groupNumber || 0) + 1,
    status: 'suggested',
    sourceRange: calculateRange(frames),
    frames,
    suggestions: best.suggestions,
    confidence: best.confidence,
    analysis: best.analysis,
    adminOverrides: Object.assign({}, ...candidates.map((item) => item.adminOverrides || {})),
    mergedFrom: candidates.map((item) => item._id),
    audit: [{ action: 'merged', by: req.user._id, details: { sources: candidates.map((item) => String(item._id)) } }],
  });
  await ReelCandidate.updateMany({ _id: { $in: ids } }, {
    $set: { status: 'merged', mergedInto: merged._id },
    $push: { audit: { action: 'merged_into', by: req.user._id, at: new Date(), details: { target: String(merged._id) } } },
  });
  res.status(201).json({ success: true, data: formatCandidate(merged) });
}

async function splitCandidate(req, res) {
  const context = await findOwnedCandidate(req);
  if (!context) return res.status(404).json({ success: false, message: 'Candidate not found.' });
  const { job, candidate } = context;
  if (candidate.productDraft || candidate.status === 'merged') {
    return res.status(409).json({ success: false, message: 'This candidate cannot be split.' });
  }
  const selectedIds = new Set(uniqueIds(req.body?.frameIds));
  const timestamp = Number(req.body?.fromTimestamp);
  const moved = candidate.frames.filter((frame) => (
    selectedIds.size ? selectedIds.has(String(frame._id)) : Number.isFinite(timestamp) && frame.timestampSeconds >= timestamp
  ));
  const remaining = candidate.frames.filter((frame) => !moved.some((selected) => String(selected._id) === String(frame._id)));
  if (!moved.length || !remaining.length) {
    return res.status(400).json({ success: false, message: 'A split must leave at least one frame in both products.' });
  }
  const maxGroup = await ReelCandidate.findOne({ job: job._id }).sort({ groupNumber: -1 }).select('groupNumber');
  candidate.frames = selectBestFrames(remaining);
  candidate.sourceRange = calculateRange(candidate.frames);
  candidate.audit.push({ action: 'split_source', by: req.user._id, details: { movedFrames: moved.length } });
  await candidate.save();
  const created = await ReelCandidate.create({
    job: job._id,
    groupNumber: Number(maxGroup?.groupNumber || 0) + 1,
    status: 'suggested',
    sourceRange: calculateRange(moved),
    frames: selectBestFrames(moved),
    suggestions: candidate.suggestions,
    confidence: candidate.confidence,
    analysis: candidate.analysis,
    adminOverrides: {},
    audit: [{ action: 'split_created', by: req.user._id, details: { source: String(candidate._id) } }],
  });
  res.status(201).json({ success: true, data: { source: formatCandidate(candidate), created: formatCandidate(created) } });
}

async function moveFrame(req, res) {
  const context = await findOwnedCandidate(req);
  if (!context) return res.status(404).json({ success: false, message: 'Candidate not found.' });
  const { job, candidate: source } = context;
  if (source.productDraft || ['merged', 'draft_created'].includes(source.status)) {
    return res.status(409).json({ success: false, message: 'Photos linked to a saved product draft cannot be moved. Edit the saved draft instead.' });
  }
  if (String(req.body?.targetCandidateId) === String(source._id)) {
    return res.status(400).json({ success: false, message: 'Choose another product group to move this photo.' });
  }
  const target = await ReelCandidate.findOne({ _id: req.body?.targetCandidateId, job: job._id, status: { $nin: ['merged', 'draft_created'] } });
  if (!target) return res.status(404).json({ success: false, message: 'Target candidate not found.' });
  const frame = source.frames.id(req.body?.frameId);
  if (!frame) return res.status(404).json({ success: false, message: 'Frame not found.' });
  const plainFrame = frame.toObject();
  frame.deleteOne();
  target.frames.push(plainFrame);
  source.frames = selectBestFrames(source.frames);
  target.frames = selectBestFrames(dedupeFrames(target.frames));
  source.sourceRange = calculateRange(source.frames);
  target.sourceRange = calculateRange(target.frames);
  if (!source.frames.length) source.status = 'ignored';
  source.audit.push({ action: 'frame_moved_out', by: req.user._id, details: { target: String(target._id) } });
  target.audit.push({ action: 'frame_moved_in', by: req.user._id, details: { source: String(source._id) } });
  await Promise.all([source.save(), target.save()]);
  res.json({ success: true, data: { source: formatCandidate(source), target: formatCandidate(target) } });
}

async function createDrafts(req, res, next) {
  let job;
  try {
    job = await findOwnedJob(req);
    if (!job) return res.status(404).json({ success: false, message: 'Reel import not found.' });
    const requested = uniqueIds(req.body?.candidateIds);
    const query = {
      job: job._id,
      status: { $nin: ['ignored', 'merged'] },
      ...(requested.length ? { _id: { $in: requested } } : {}),
    };
    const candidates = await ReelCandidate.find(query);
    if (!candidates.length) return res.status(400).json({ success: false, message: 'Select at least one candidate.' });
    job.status = 'creating_drafts';
    job.error = undefined;
    await saveProgress(job, {
      stage: 'creating_drafts',
      percentage: 95,
      currentStep: 'Creating product drafts',
      message: 'Saving selected candidates as drafts.',
    });
    const drafts = [];
    for (const candidate of candidates) {
      const draft = await createDraftForCandidate(job, candidate, req.user._id);
      drafts.push(draft);
    }
    job.statistics.createdDrafts = await ReelCandidate.countDocuments({ job: job._id, productDraft: { $ne: null } });
    job.status = 'completed';
    job.completedAt = new Date();
    await saveProgress(job, {
      stage: 'drafts_created',
      percentage: 100,
      currentStep: 'Completed',
      message: 'Selected product drafts were created.',
      stageStatus: 'completed',
    });
    res.status(201).json({ success: true, data: { drafts: drafts.map(formatDraftReference), job: formatJob(job) } });
  } catch (error) {
    if (job?.status === 'creating_drafts') {
      job.status = 'review_required';
      job.error = {
        code: error.code || 'DRAFT_CREATION_FAILED',
        safeMessage: 'Some product drafts could not be created. Your review is saved; please try creating the drafts again.',
      };
      await saveProgress(job, {
        stage: 'creating_drafts',
        percentage: 95,
        currentStep: 'Draft creation needs attention',
        message: job.error.safeMessage,
        stageStatus: 'failed',
        errorCode: job.error.code,
      }).catch(() => null);
    }
    next(error);
  }
}

async function createDraftForCandidate(job, candidate, userId) {
  if (candidate.productDraft) {
    const existing = await ProductDraft.findById(candidate.productDraft);
    if (existing) return existing;
  }
  const duplicate = await ProductDraft.findOne({ sourceCandidateId: candidate._id });
  if (duplicate) {
    candidate.productDraft = duplicate._id;
    candidate.status = 'draft_created';
    await candidate.save();
    return duplicate;
  }
  if (await DeletedProductDraft.exists({ sourceCandidateId: candidate._id })) throw validationError('ALREADY_PUBLISHED', 'This candidate was already published and its draft removed. Manage the existing product from Products.');
  const overrides = candidate.adminOverrides || {};
  const suggestions = candidate.suggestions || {};
  const name = String(overrides.name || suggestions.name || `Reel product ${candidate.groupNumber}`).trim();
  const selectedFrames = candidate.frames.filter((frame) => frame.selected);
  if (!selectedFrames.length) throw validationError('NO_SELECTED_FRAMES', 'Select at least one product photo before creating a draft.');
  const primaryId = String(overrides.primaryFrameId || '');
  const frames = [...selectedFrames].sort((a, b) => Number(String(b._id) === primaryId) - Number(String(a._id) === primaryId));
  const category = await resolveCategory(overrides.category || suggestions.category || suggestions.categoryName);
  const suggestedColors = listValue(suggestions.primaryColor).concat(listValue(suggestions.secondaryColors));
  const colors = listValue(overrides.colors || overrides.primaryColor || suggestedColors);
  const sizes = listValue(overrides.sizes ?? suggestions.sizes);
  const tags = listValue(overrides.tags || suggestions.tags);
  const price = numberOrZero(overrides.price ?? overrides.sellingPrice ?? suggestions.price);
  const statedMrp = overrides.originalPrice ?? suggestions.originalPrice;
  const originalPrice = Number(statedMrp) > 0 ? Number(statedMrp) : undefined;
  const draft = await ProductDraft.create({
    name,
    slug: `${slugify(name || 'reel-product')}-${String(candidate._id).slice(-6)}`,
    sku: `REEL-${String(candidate._id).slice(-10).toUpperCase()}`,
    image: frames[0]?.url || '',
    images: frames.map((frame, index) => ({ url: frame.url, publicId: frame.storageKey, variants: frame.variants, primary: index === 0,
      sourceFrame: { timestampSeconds: frame.timestampSeconds, qualityScore: frame.qualityScore, viewType: frame.viewType || 'unknown', width: frame.width, height: frame.height, selectionVersion: frame.selectionVersion } })),
    videos: [],
    category: category?._id,
    subCategory: overrides.subCategory || suggestions.subcategory || '',
    price,
    originalPrice,
    sellingPrice: price,
    stock: numberOrZero(overrides.stock),
    sizes,
    sizingMode: normalizeSizingMode(overrides.sizingMode || suggestions.sizingMode),
    sizeChart: overrides.sizeChart || suggestions.sizeChart,
    sizeChartProfile: overrides.sizeChartProfile || 'auto',
    attributeValues: overrides.attributeValues || suggestions.attributeValues,
    importContext: { fieldSources: suggestions.fieldSources, source: candidate.analysis?.source },
    colors,
    fabric: String(overrides.fabric || suggestions.fabric || ''),
    occasion: listValue(overrides.occasion || suggestions.occasion).join(', '),
    tags,
    description: String(overrides.description || suggestions.description || suggestions.shortDescription || ''),
    highlights: listValue(overrides.highlights || suggestions.highlights),
    shortDescription: String(overrides.shortDescription || suggestions.shortDescription || ''),
    careInstructions: String(overrides.careInstructions || suggestions.careInstructions || ''),
    metaTitle: String(overrides.metaTitle || suggestions.metaTitle || name).slice(0, 100),
    metaDescription: String(overrides.metaDescription || suggestions.metaDescription || suggestions.shortDescription || '').slice(0, 300),
    metaKeywords: String(overrides.metaKeywords || suggestions.metaKeywords || tags.join(', ')).slice(0, 1000),
    status: 'draft',
    createdBy: userId,
    sourceType: 'reel-import',
    sourceJobId: job._id,
    sourceCandidateId: candidate._id,
    storeId: job.storeId,
    confidence: Number(candidate.confidence?.overall || 0),
    detectedColors: suggestedColors,
    detectedPattern: suggestions.pattern || '',
    suggestedCategory: suggestions.category || suggestions.categoryName || '',
    suggestedTags: tags,
    draftTitle: name,
    draftDescription: String(overrides.description || suggestions.description || suggestions.shortDescription || suggestions.altText || ''),
  });
  candidate.productDraft = draft._id;
  candidate.status = 'draft_created';
  candidate.audit.push({ action: 'draft_created', by: userId, details: { draft: String(draft._id) } });
  await candidate.save();
  return draft;
}

async function resolveCategory(value) {
  if (!value) return null;
  if (mongoose.isValidObjectId(value)) return Category.findById(value);
  return Category.findOne({ name: { $regex: `^${escapeRegExp(String(value).trim())}$`, $options: 'i' } });
}

async function findOwnedJob(req, select = '') {
  if (!mongoose.isValidObjectId(req.params.jobId)) return null;
  return ReelImport.findOne({ _id: req.params.jobId, createdBy: req.user._id }).select(select);
}

async function findOwnedCandidate(req) {
  const job = await findOwnedJob(req);
  if (!job || !mongoose.isValidObjectId(req.params.candidateId)) return null;
  const candidate = await ReelCandidate.findOne({ _id: req.params.candidateId, job: job._id });
  return candidate ? { job, candidate } : null;
}

function dedupeFrames(frames) {
  const seen = new Set();
  return frames.filter((frame) => {
    const key = String(frame.storageKey || frame.url || frame._id);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((frame) => frame.toObject ? frame.toObject() : { ...frame });
}

function selectBestFrames(frames) {
  const sorted = [...frames].sort((a, b) => Number(b.recommendedCover) - Number(a.recommendedCover) || Number(b.qualityScore || 0) - Number(a.qualityScore || 0));
  const selectedKeys = new Set(sorted.filter((frame) => frame.recommended !== false).slice(0, 4).map((frame) => String(frame.storageKey || frame.url || frame._id)));
  return sorted.map((frame) => ({
    ...(frame.toObject ? frame.toObject() : frame),
    selected: selectedKeys.has(String(frame.storageKey || frame.url || frame._id)),
  }));
}

function calculateRange(frames) {
  const times = frames.map((frame) => Number(frame.timestampSeconds)).filter(Number.isFinite);
  return { startSeconds: times.length ? Math.min(...times) : 0, endSeconds: times.length ? Math.max(...times) : 0 };
}

function pickSuggestions(value) {
  return pick(value, [
    'name', 'category', 'categoryName', 'subcategory', 'primaryColor', 'secondaryColors',
    'pattern', 'fabric', 'occasion', 'tags', 'altText', 'shortDescription', 'description', 'sizingMode',
  ]);
}

function pickAdminOverrides(value) {
  return pick(value, [
    'name', 'category', 'subCategory', 'primaryColor', 'colors', 'pattern', 'fabric', 'occasion',
    'tags', 'description', 'shortDescription', 'highlights', 'careInstructions', 'metaTitle', 'metaDescription', 'metaKeywords', 'price', 'originalPrice', 'sellingPrice', 'sizes', 'sizingMode', 'stock', 'primaryFrameId', 'sizeChart', 'sizeChartProfile', 'attributeValues',
  ]);
}

function pick(source, keys) {
  return Object.fromEntries(keys.filter((key) => Object.prototype.hasOwnProperty.call(source, key)).map((key) => [key, source[key]]));
}

function uniqueIds(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(String).filter(mongoose.isValidObjectId))];
}

function listValue(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function normalizeSizingMode(value) {
  return ['sized', 'free-size'].includes(value) ? value : 'auto';
}

function formatJob(job) {
  const data = job.toObject ? job.toObject() : { ...job };
  delete data.sourceVideo?.url;
  delete data.activeRunId;
  data.id = String(data._id);
  data.health = publicHealth(job);
  return data;
}

function formatCandidate(candidate) {
  const data = candidate.toObject ? candidate.toObject() : { ...candidate };
  data.id = String(data._id);
  return data;
}

function formatDraftReference(draft) {
  return { id: String(draft._id), name: draft.name, status: draft.status };
}

module.exports = Object.fromEntries(Object.entries({
  analyzeCandidate,
  cancelImport,
  createDrafts,
  createImport,
  deleteImport,
  getImport,
  getUploadCapabilities,
  listCandidates,
  listImports,
  mergeCandidates,
  moveFrame,
  retryImport,
  splitCandidate,
  updateCandidate,
}).map(([name, handler]) => [name, asyncHandler(handler)]));
