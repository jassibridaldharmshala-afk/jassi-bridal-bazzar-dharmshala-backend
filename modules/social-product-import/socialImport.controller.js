const crypto = require('node:crypto');
const mongoose = require('mongoose');
const SocialImport = require('../../models/SocialProductImport');
const ProductDraft = require('../../models/ProductDraft');
const DeletedProductDraft = require('../../models/DeletedProductDraft');
const Product = require('../../models/Product');
const Category = require('../../models/Category');
const { asyncHandler } = require('../../middleware/validate');
const { ApiError, notFound } = require('../../utils/apiError');
const { logAudit } = require('../../services/auditService');
const vision = require('../../services/quickAddVision.service');
const { normalizeSocialUrl, validateDraftReview, MAX_IMAGES } = require('./socialImport.validation');
const service = require('./socialImport.service');
const media = require('./socialImport.media');
const { prepareImportedDraft, publishPreparedDraft } = require('../../controllers/productDraftController');
const scope = (req) => ({ createdBy: req.user._id, ...(req.store?._id ? { storeId: req.store._id } : {}) });
function identity(req) {
  if (!/^[a-f\d]{24}$/i.test(String(req.params.id || ''))) throw new ApiError('VALIDATION_ERROR', 'Invalid import reference.');
  return { ...scope(req), _id: req.params.id };
}
function view(job, summary = false) {
  const data = job.toObject ? job.toObject() : { ...job };
  delete data.runId; delete data.sourceKey; delete data.__v;
  if (summary) { delete data.caption; delete data.suggestion; data.images = data.images?.slice(0, 1); delete data.videos; }
  return data;
}
exports.capabilities = (req, res) => res.json({
  enabled: media.storageReady(), photoAnalysis: vision.isVisionEnabled(), maxImages: MAX_IMAGES, maxVideoMb: 80, maxVideoMinutes: 5,
  connectedInstagram: Boolean(process.env.SOCIAL_IMPORT_INSTAGRAM_ACCESS_TOKEN), connectedFacebook: Boolean(process.env.SOCIAL_IMPORT_FACEBOOK_PAGE_TOKEN),
  message: media.storageReady() ? '' : 'Configure permanent catalog media storage to enable imports.',
});
exports.create = asyncHandler(async (req, res) => {
  const source = normalizeSocialUrl(req.body?.url);
  if (!media.storageReady()) throw new ApiError('SOCIAL_STORAGE_REQUIRED', 'Configure permanent catalog media storage before importing products.', { statusCode: 503 });
  const sourceKey = crypto.createHash('sha256').update(`${req.user._id}:${req.store?._id || 'admin'}:${source.platform}:${source.mediaId || source.url}`).digest('hex');
  let job = await SocialImport.findOne({ sourceKey, ...scope(req) }); let duplicate = Boolean(job);
  if (!job) {
    const queued = await SocialImport.countDocuments({ ...scope(req), status: { $in: ['queued', ...service.ACTIVE_STATES] } });
    if (queued >= 5) throw new ApiError('SOCIAL_QUEUE_FULL', 'You already have five imports in progress. Wait for one to finish.', { statusCode: 429 });
    try { job = await SocialImport.create({ ...scope(req), sourceKey, sourceUrl: source.url, platform: source.platform }); }
    catch (error) { if (error.code !== 11000) throw error; job = await SocialImport.findOne({ sourceKey, ...scope(req) }); duplicate = true; if (!job) throw error; }
  }
  if (job.status === 'queued') service.enqueue(job._id);
  res.status(duplicate ? 200 : 202).json({ success: true, duplicate, data: view(job) });
});
exports.list = asyncHandler(async (req, res) => {
  const page = Math.max(1, Math.min(1000, Number(req.query.page) || 1));
  if (!Number.isInteger(page)) throw new ApiError('VALIDATION_ERROR', 'Invalid page.');
  const [jobs, total] = await Promise.all([SocialImport.find(scope(req)).select('-caption -suggestion -runId -sourceKey').sort({ createdAt: -1, _id: -1 }).skip((page - 1) * 10).limit(10).lean(), SocialImport.countDocuments(scope(req))]);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ items: jobs.map((job) => view(job, true)), page, total, totalPages: Math.max(1, Math.ceil(total / 10)) });
});
exports.get = asyncHandler(async (req, res) => {
  const job = await SocialImport.findOne(identity(req));
  if (!job) throw notFound('Import not found.');
  if (job.draftId && !await ProductDraft.exists({ _id: job.draftId }) && !await DeletedProductDraft.exists({ draftId: job.draftId })) {
    job.draftId = undefined; await job.save();
  }
  if (job.status === 'queued') service.enqueue(job._id);
  res.setHeader('Cache-Control', 'no-store'); res.json({ data: await reviewView(job) });
});
exports.retry = asyncHandler(async (req, res) => {
  const job = await SocialImport.findOneAndUpdate({ ...identity(req), $or: [{ status: { $in: ['failed', 'cancelled'] } }, { status: 'ready', 'videos.0': { $exists: true } }], attempts: { $lt: 5 }, draftId: { $exists: false } },
    { $set: { status: 'queued', progress: 0, stage: 'Waiting to retry', error: '', errorCode: '' } }, { new: true });
  if (!job) throw new ApiError('SOCIAL_RETRY_UNAVAILABLE', 'Retry a failed import or recheck an unsaved video import with fewer than five attempts. Saved drafts stay unchanged.', { statusCode: 409 });
  service.enqueue(job._id); res.json({ success: true, data: view(job) });
});
exports.cancel = asyncHandler(async (req, res) => {
  const job = await SocialImport.findOneAndUpdate({ ...identity(req), status: { $in: ['queued', ...service.ACTIVE_STATES] } },
    { $set: { status: 'cancelled', stage: 'Import cancelled', error: '', errorCode: '' } }, { new: true });
  if (!job) throw new ApiError('SOCIAL_CANCEL_UNAVAILABLE', 'This import has already finished. Refresh to view its current status.', { statusCode: 409 });
  service.cancel(job._id); res.json({ success: true, data: view(job) });
});
exports.createDraft = asyncHandler(async (req, res) => {
  const job = await SocialImport.findOne(identity(req));
  if (!job) throw notFound('Import not found.');
  if (job.status !== 'ready') throw new ApiError('SOCIAL_NOT_READY', 'Wait for the import to finish before creating a draft.', { statusCode: 409 });
  let draft = await ProductDraft.findOne({ sourceSocialImportId: job._id });
  let duplicate = Boolean(draft);
  if (!draft) {
    if (await DeletedProductDraft.exists({ sourceSocialImportId: job._id })) throw new ApiError('SOCIAL_ALREADY_PUBLISHED', 'This import was already published and its draft removed. Manage the existing product from Products.', { statusCode: 409 });
    const payload = validateDraftReview(req.body, job);
    if (payload.category && !await Category.exists({ _id: payload.category, ...(job.storeId ? { storeId: job.storeId } : {}) })) throw new ApiError('VALIDATION_ERROR', 'The selected category is unavailable. Choose another category.');
    const draftId = new mongoose.Types.ObjectId();
    try {
      draft = await ProductDraft.create({ ...payload, _id: draftId, createdBy: req.user._id, storeId: job.storeId,
        slug: `social-product-${draftId}`, sku: `SOCIAL-${String(draftId).slice(-10).toUpperCase()}`, status: 'draft',
        sourceType: 'social-import', sourceSocialImportId: job._id, sourceUrl: job.resolvedUrl || job.sourceUrl, sourcePlatform: job.platform,
        videos: req.body.includeVideo === true ? job.videos.map((video) => ({ url: video.url, publicId: video.publicId, thumbnail: video.thumbnail })) : [],
      });
    } catch (error) { if (error.code !== 11000) throw error; draft = await ProductDraft.findOne({ sourceSocialImportId: job._id }); if (!draft) throw error; duplicate = true; }
    if (!duplicate) await logAudit({ req, action: 'SOCIAL_IMPORT_DRAFT_CREATE', entityType: 'ProductDraft', entityId: draft._id, storeId: job.storeId, summary: `Product draft imported from ${job.platform}` });
  }
  await SocialImport.updateOne({ _id: job._id }, { $set: { draftId: draft._id } });
  res.status(duplicate ? 200 : 201).json({ success: true, duplicate, draftId: String(draft._id), data: view(job) });
});

async function reviewView(job, suppliedDraft) {
  const data = view(job);
  const draft = suppliedDraft || await ProductDraft.findOne({ sourceSocialImportId: job._id });
  if (!draft) {
    const receipt = await DeletedProductDraft.findOne({ sourceSocialImportId: job._id }).lean();
    if (receipt) {
      delete data.draftId;
      data.publishedProductId = String(receipt.productId);
      data.publishedProductDeleted = !await Product.exists({ _id: receipt.productId });
      data.draftRemoved = true;
    }
    return data;
  }
  const value = draft.toObject();
  data.draftId = String(draft._id); data.publishedProductId = value.publishedProductId ? String(value.publishedProductId) : undefined;
  if (value.publishedProductId) data.publishedProductDeleted = !await Product.exists({ _id: value.publishedProductId });
  data.images = [...(data.images || [])];
  // Keep photos added later in the draft editor available when resuming here.
  const selected = (value.images || []).map((image) => {
    let imported = data.images.find((item) => item.url === image.url);
    if (!imported) { imported = { id: 'draft-' + crypto.createHash('sha256').update(image.url).digest('hex').slice(0, 20), url: image.url, publicId: image.publicId, kind: 'photo' }; data.images.push(imported); }
    return { ...imported, primary: image.primary, viewType: image.sourceFrame?.viewType || imported.viewType };
  });
  data.savedReview = Object.fromEntries(['name', 'category', 'subCategory', 'price', 'originalPrice', 'stock', 'description', 'shortDescription', 'colors', 'sizes', 'fabric', 'occasion', 'tags', 'highlights', 'sizingMode', 'sizeChart', 'sizeChartProfile', 'attributeValues'].map((key) => [key, value[key]]));
  data.savedReview.category = String(value.category?._id || value.category || '');
  data.savedReview.price = value.sellingPrice ?? value.price;
  data.savedReview.imageIds = selected.map((image) => image.id);
  data.savedReview.primaryImageId = (selected.find((image) => image.primary) || selected[0])?.id || '';
  data.savedReview.viewTypes = Object.fromEntries(selected.map((image) => [image.id, image.viewType || 'unknown']));
  data.savedReview.includeVideo = Boolean(value.videos?.length);
  data.savedReview.draftUpdatedAt = draft.updatedAt.toISOString();
  if (value.attributeValues instanceof Map) data.savedReview.attributeValues = Object.fromEntries(value.attributeValues);
  return data;
}

async function saveReviewedImport(req, res, publish) {
  const job = await SocialImport.findOne(identity(req));
  if (!job) throw notFound('Import not found.');
  if (job.status !== 'ready') throw new ApiError('SOCIAL_NOT_READY', 'Wait for the import to finish before saving.', { statusCode: 409 });
  let draft = await ProductDraft.findOne({ sourceSocialImportId: job._id });
  if (!draft) {
    const receipt = await DeletedProductDraft.findOne({ sourceSocialImportId: job._id }).lean();
    if (receipt) {
      if (!await Product.exists({ _id: receipt.productId })) throw new ApiError('SOCIAL_ALREADY_PUBLISHED', 'The published product was permanently deleted. This import cannot recreate it.', { statusCode: 409 });
      return res.json({ success: true, duplicate: true, productId: String(receipt.productId), data: await reviewView(job) });
    }
  }
  if (draft?.status === 'published' && draft.publishedProductId) {
    if (!await Product.exists({ _id: draft.publishedProductId })) throw new ApiError('SOCIAL_ALREADY_PUBLISHED', 'The published product was permanently deleted. This import cannot recreate it.', { statusCode: 409 });
    return res.json({ success: true, duplicate: true, draftId: String(draft._id), productId: String(draft.publishedProductId), data: await reviewView(job, draft) });
  }
  if (draft && req.body.draftUpdatedAt !== draft.updatedAt.toISOString()) throw new ApiError('SOCIAL_REVIEW_CHANGED', 'This draft changed in another screen. Reload this import to keep the latest edits.', { statusCode: 409 });
  const ownedReview = await reviewView(job, draft);
  const payload = validateDraftReview(req.body, ownedReview);
  const category = payload.category ? await Category.findOne({ _id: payload.category, ...(job.storeId ? { storeId: job.storeId } : {}) }) : null;
  if (payload.category && !category) throw new ApiError('VALIDATION_ERROR', 'The selected category is unavailable. Choose another category.');
  const draftId = draft?._id || new mongoose.Types.ObjectId();
  const retainedVideos = draft?.videos?.length ? draft.videos.map((video) => video.toObject()) : job.videos.map((video) => ({ url: video.url, publicId: video.publicId, thumbnail: video.thumbnail }));
  const data = { ...payload, videos: req.body.includeVideo === true ? retainedVideos : [],
    importContext: { fieldSources: job.suggestion?.fieldSources, contextStatus: job.suggestion?.contextStatus, contextInputs: job.suggestion?.contextInputs },
  };
  const preview = new ProductDraft({ ...(draft ? draft.toObject() : {}), ...data, _id: draftId, category: category?._id,
    createdBy: job.createdBy, storeId: job.storeId, sourceType: 'social-import', sourceSocialImportId: job._id,
    sourceUrl: job.resolvedUrl || job.sourceUrl, sourcePlatform: job.platform, status: 'draft',
    slug: draft?.slug || `social-product-${draftId}`, sku: draft?.sku || `SOCIAL-${String(draftId).slice(-10).toUpperCase()}` });
  // Apply the same inventory, sizing and custom-field requirements as normal
  // publishing before creating/updating anything. Missing fields stay editable.
  const prepared = publish ? await prepareImportedDraft(preview) : null;
  if (draft) {
    draft = await ProductDraft.findOneAndUpdate({ _id: draft._id, updatedAt: draft.updatedAt, status: 'draft', publishingToken: { $exists: false } }, { $set: data, $inc: { revision: 1 } }, { new: true, runValidators: true });
    if (!draft) throw new ApiError('SOCIAL_REVIEW_CHANGED', 'This draft changed in another screen. Reload this import before saving.', { statusCode: 409 });
  } else {
    try { draft = await ProductDraft.create(preview); }
    catch (error) { if (error.code !== 11000) throw error; throw new ApiError('SOCIAL_REVIEW_CHANGED', 'This import was saved in another request. Reload it to continue.', { statusCode: 409 }); }
  }
  await SocialImport.updateOne({ _id: job._id }, { $set: { draftId: draft._id } });
  let product;
  if (publish) product = await publishPreparedDraft(draft, prepared, { userId: req.user?._id });
  await logAudit({ req, action: publish ? 'SOCIAL_IMPORT_PUBLISH' : 'SOCIAL_IMPORT_REVIEW_SAVE', entityType: publish ? 'Product' : 'ProductDraft', entityId: product?._id || draft._id, storeId: job.storeId, summary: publish ? 'Product published from import review' : 'Imported product review saved' });
  res.json({ success: true, draftId: String(draft._id), ...(product ? { productId: String(product._id) } : {}), data: await reviewView(job, draft) });
}
exports.saveReview = asyncHandler((req, res) => saveReviewedImport(req, res, false));
exports.publishReview = asyncHandler((req, res) => saveReviewedImport(req, res, true));
