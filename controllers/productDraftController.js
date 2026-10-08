const { asyncHandler } = require('../middleware/validate');
const { requireObjectId } = require('../utils/validators');
const mongoose = require('mongoose');
const { applyProductStructure } = require('../services/masterConfigurationService');
const fs = require('fs/promises');
const path = require('path');
const slugify = require('../utils/slugify');
const Product = require('../models/Product');
const ProductDraft = require('../models/ProductDraft');
const Category = require('../models/Category');
const { deleteImageFromR2, isR2Configured } = require('../services/r2Upload');
const { deleteFile: deleteCloudinaryFile, isCloudinaryConfigured } = require('../services/cloudinaryUpload');
const { isLocalRequest, normalizeProductImages, normalizeProductPayload, sanitizeProductImages } = require('../utils/imageUtils');
const { normalizeProductSizing, validateProductSizing } = require('../services/productSizingService');
const { validateVariantPayload } = require('../services/variantService');
const { andFilter } = require('../services/storeService');
const { logAudit } = require('../services/auditService');
const { auditSnapshot } = require('../utils/auditData');
const { recordOpeningInventory } = require('../services/inventoryService');
const DeletedProductDraft = require('../models/DeletedProductDraft');
const { ApiError } = require('../utils/apiError');
const { supportsTransactions, runInTransaction } = require('../utils/transaction');
const { runUploadRequest, getUploadStatus } = require('../services/uploadRetryService');
const { storeFiles } = require('../services/mediaUploadService');
const { createRecordOnce } = require('../services/recordCreationService');
const { resolveDraftPhotoGroups } = require('../utils/draftPhotoGroups');

const DRAFT_AUDIT_FIELDS = [
  'name', 'sku', 'category', 'sellingPrice', 'originalPrice', 'stock', 'status',
  'revision', 'publishedProductId', 'sourceType', 'archivedAt',
];
const MAX_DRAFT_PAGE_SIZE = 60;

function draftQuery(req, extra = {}) {
  return andFilter(extra, req.tenantFilter);
}

function withDraftStore(req, payload = {}) {
  const next = { ...payload };
  delete next.storeId;
  if (req.store?._id) next.storeId = req.store._id;
  return next;
}

exports.bulkUploadMiddleware = require('../middleware/photoUploadMiddleware').createPhotoUpload({ files: 30 });

async function replayDraftUpload(req, saved) {
  const drafts = await ProductDraft.find(draftQuery(req, { _id: { $in: saved.data.drafts.map(draft => draft._id) } }));
  if (drafts.length !== saved.data.drafts.length) throw new ApiError('UPLOAD_RETRY_CONFLICT', 'One or more drafts from this upload were removed. Start a new upload.', { statusCode: 409 });
  const byId = new Map(drafts.map(draft => [String(draft._id), draft]));
  return { ...saved, data: { drafts: saved.data.drafts.map(draft => formatDraft(byId.get(String(draft._id)))) } };
}
exports.bulkUploadStatus = asyncHandler(async (req, res) => {
  const result = await getUploadStatus(req, {
    requestPath: req.originalUrl.split('?')[0].replace(/\/status$/, ''),
    replay: saved => replayDraftUpload(req, saved),
  });
  res.json(result);
});

exports.bulkUpload = async (req, res, next) => {
  try {
    const resume = req.body?.resumeUpload === true && !req.files?.length;
    const respondAsync = req.body?.asyncUpload === true || req.body?.asyncUpload === 'true';
    if (respondAsync && !resume && req.files?.length) resolveDraftPhotoGroups(req.body || {}, req.files.length);
    if (!resume && !req.files?.length) return res.status(400).json({ success: false, message: 'Please upload at least one image' });
    if (!isR2Configured() && !isCloudinaryConfigured() && process.env.NODE_ENV === 'production' && !isLocalRequest(req)) {
      throw new ApiError('PERSISTENT_UPLOAD_STORAGE_REQUIRED', 'Draft images need Cloudflare R2 or Cloudinary in production.', { statusCode: 503 });
    }
    const result = await runUploadRequest(req, async context => {
      const fields = context.fields || req.body || {};
      const photoGroups = resolveDraftPhotoGroups(fields, context.resume ? context.storedFiles.length : req.files.length);
      const uploaded = context.resume ? context.storedFiles : await storeFiles(req, context, { folder: 'products' });
      const payloads = photoGroups.map((group, index) => {
        const files = group.photoIndexes.map((photoIndex) => uploaded[photoIndex]);
        return withDraftStore(req, {
          ...(context.managed ? { _id: new mongoose.Types.ObjectId(require('crypto').createHash('sha256').update(`${context.id}:draft:${index}`).digest('hex').slice(0, 24)), uploadOperationId: context.id } : {}),
          name: group.name,
          slug: uniqueDraftSlug(group.name || files[0]?.originalName || `draft-${index + 1}`),
          sku: `DRAFT-${Date.now()}-${String(index + 1).padStart(2, '0')}`,
          image: files[0]?.url,
          images: files.map((file, fileIndex) => ({ ...file, primary: fileIndex === 0 })),
          videos: [],
          category: undefined,
          subCategory: '',
          price: 0,
          originalPrice: 0,
          sellingPrice: 0,
          stock: 0,
          sizes: [],
          sizingMode: 'auto',
          sizeChartProfile: 'auto',
          sizeChart: { unit: 'in', columns: [], rows: [] },
          sizeFitNotes: '',
          colors: [],
          fabric: '',
          occasion: '',
          tags: [],
          description: '',
          highlights: [],
          status: 'draft',
          sourceType: 'manual',
          createdBy: req.user?._id,
        });
      });
      await context.progress?.({ phase: 'saving-drafts' });
      const drafts = await runInTransaction(async session => {
        const rows = [];
        for (const payload of payloads) {
          const existing = context.managed ? await ProductDraft.findById(payload._id).session(session || null) : null;
          rows.push(existing || (await ProductDraft.create([payload], { session }))[0]);
        }
        return rows;
      });

      await Promise.all(drafts.map((draft, index) => logAudit({
        req, action: 'PRODUCT_DRAFT_CREATED', entityType: 'ProductDraft', entityId: draft._id,
        after: auditSnapshot(draft, DRAFT_AUDIT_FIELDS),
        summary: `Created product draft from ${photoGroups[index].photoIndexes.length} photos`,
      })));
      return { success: true, message: 'Drafts created successfully', data: { drafts: drafts.map(formatDraft) } };
    }, { resume, respondAsync, replay: saved => replayDraftUpload(req, saved),
      ...(respondAsync ? { onSettled: () => cleanupTempFiles(req.files) } : {}) });
    if (!result.data?.upload) await cleanupTempFiles(req.files);
    res.status(result.data?.upload ? 202 : 201).json(result);
  } catch (error) {
    await cleanupTempFiles(req.files);
    next(error);
  }
};

exports.listDrafts = asyncHandler(async (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(MAX_DRAFT_PAGE_SIZE, Math.max(1, Number.parseInt(req.query.limit, 10) || 24));
  const status = ['draft', 'published', 'archived', 'all'].includes(req.query.status) ? req.query.status : 'active';
  const sourceType = ['manual', 'reel-import', 'social-import'].includes(req.query.sourceType) ? req.query.sourceType : '';
  const readiness = ['ready', 'review', 'incomplete'].includes(req.query.readiness) ? req.query.readiness : '';
  const escapedSearch = escapeRegex(String(req.query.q || '').trim().slice(0, 100));
  const category = mongoose.isValidObjectId(req.query.category) ? req.query.category : '';
  const filter = { autosaveKey: { $exists: false } };
  if (status === 'active') filter.status = 'draft';
  else if (status !== 'all') filter.status = status;
  if (sourceType) filter.sourceType = sourceType;
  if (category) filter.category = category;
  if (escapedSearch) filter.$or = [
    { name: { $regex: escapedSearch, $options: 'i' } },
    { sku: { $regex: escapedSearch, $options: 'i' } },
    { barcode: { $regex: escapedSearch, $options: 'i' } },
    { supplierSku: { $regex: escapedSearch, $options: 'i' } },
  ];
  const sort = req.query.sort === 'oldest' ? { updatedAt: 1 }
    : req.query.sort === 'name' ? { name: 1, updatedAt: -1 }
      : { updatedAt: -1 };
  const scoped = draftQuery(req, filter);
  let formatted;
  let total;
  if (readiness) {
    const all = await ProductDraft.find(scoped).populate('category', 'name slug isActive isArchived definitionKey').sort(sort).lean();
    formatted = all.map(formatDraft).filter((draft) => draft.readiness?.state === readiness);
    total = formatted.length;
    formatted = formatted.slice((page - 1) * limit, page * limit);
  } else {
    const [drafts, count] = await Promise.all([
      ProductDraft.find(scoped).populate('category', 'name slug isActive isArchived definitionKey').sort(sort).skip((page - 1) * limit).limit(limit).lean(),
      ProductDraft.countDocuments(scoped),
    ]);
    formatted = drafts.map(formatDraft);
    total = count;
  }
  const publishedIds = formatted.filter(item => item.publishedProductId).map(item => item.publishedProductId);
  if (publishedIds.length) {
    const products = await Product.find({ _id: { $in: publishedIds } }).select('_id').lean();
    const existingIds = new Set(products.map(item => String(item._id)));
    formatted = formatted.map(item => item.publishedProductId ? { ...item, publishedProductDeleted: !existingIds.has(String(item.publishedProductId)) } : item);
  }
  const summaryBase = draftQuery(req, { autosaveKey: { $exists: false } });
  const [draftCount, publishedCount, archivedCount, attentionDocuments] = await Promise.all([
    ProductDraft.countDocuments(andFilter({ status: 'draft' }, summaryBase)),
    ProductDraft.countDocuments(andFilter({ status: 'published' }, summaryBase)),
    ProductDraft.countDocuments(andFilter({ status: 'archived' }, summaryBase)),
    ProductDraft.find(andFilter({ status: 'draft' }, summaryBase)).select('name sku category images image price sellingPrice originalPrice stock sizes sizingMode sizeChart variants description shippingWeightKg metaTitle metaDescription').populate('category', 'name isActive isArchived').lean(),
  ]);
  const readinessCounts = attentionDocuments.map(formatDraft).reduce((counts, draft) => {
    counts[draft.readiness.state] = (counts[draft.readiness.state] || 0) + 1;
    return counts;
  }, { ready: 0, review: 0, incomplete: 0 });
  res.json({
    success: true,
    data: formatted,
    meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)), photoGrouping: { version: 1, maxPhotos: 30 }, summary: { draft: draftCount, published: publishedCount, archived: archivedCount, ...readinessCounts } },
  });
});

exports.getAutosave = asyncHandler(async (req, res) => {
  const autosaveKey = readAutosaveKey(req.query.key);
  const draft = await ProductDraft.findOne(draftQuery(req, {
    createdBy: req.user?._id,
    autosaveKey,
    status: 'draft',
  })).populate('category');
  res.json({ success: true, data: draft ? formatDraft(draft) : null });
});

exports.saveAutosave = asyncHandler(async (req, res) => {
  await require('../services/storefrontDiscoveryService').validateComplements(req, req.body || {});
  const autosaveKey = readAutosaveKey(req.body?.autosaveKey);
  const payload = normalizeDraftPayload(req.body);
  for (const key of ['_id', 'id', '__v', 'createdAt', 'updatedAt', 'storeId', 'status', 'publishedProductId', 'createdBy', 'sourceType', 'autosaveKey']) delete payload[key];
  const payloadError = validateDraftPayload(payload);
  if (payloadError) return res.status(400).json({ success: false, message: payloadError });
  const categoryError = await validateDraftCategory(req, payload.category);
  if (categoryError) return res.status(400).json({ success: false, message: categoryError });
  if (!isMeaningfulDraft(payload)) return res.status(400).json({ success: false, message: 'Add a product name, SKU, description or photo before syncing a draft' });
  const query = draftQuery(req, { createdBy: req.user?._id, autosaveKey, status: 'draft' });
  let draft = await ProductDraft.findOne(query);
  if (!draft) {
    draft = new ProductDraft(withDraftStore(req, {
      ...payload,
      autosaveKey,
      status: 'draft',
      sourceType: 'manual',
      createdBy: req.user?._id,
      slug: payload.slug || uniqueDraftSlug(payload.name || 'manual-product'),
    }));
  } else {
    Object.assign(draft, payload);
    if (payload.name && !payload.slug) draft.slug = uniqueDraftSlug(payload.name, draft._id);
    draft.revision = Number(draft.revision || 0) + 1;
    draft.lastSavedBy = req.user?._id;
  }
  await draft.save();
  await draft.populate('category');
  res.json({ success: true, message: 'Draft synced', data: formatDraft(draft) });
});

exports.createDraft = asyncHandler(async (req, res) => {
  await require('../services/storefrontDiscoveryService').validateComplements(req, req.body || {});
  const payload = normalizeDraftPayload(req.body);
  for (const key of ['_id', 'id', '__v', 'createdAt', 'updatedAt', 'storeId', 'status', 'publishedProductId', 'createdBy', 'autosaveKey']) delete payload[key];
  const payloadError = validateDraftPayload(payload);
  if (payloadError) return res.status(400).json({ success: false, message: payloadError });
  payload.slug = payload.slug || uniqueDraftSlug(payload.name || 'manual-product');
  const categoryError = await validateDraftCategory(req, payload.category);
  if (categoryError) return res.status(400).json({ success: false, message: categoryError });
  const draft = await createRecordOnce(req, { Model: ProductDraft, filter: draftQuery(req), create: async identity => {
    const record = await ProductDraft.create(withDraftStore(req, { ...payload, ...identity, status: 'draft', sourceType: 'manual', createdBy: req.user?._id }));
    await logAudit({ req, action: 'PRODUCT_DRAFT_CREATED', entityType: 'ProductDraft', entityId: record._id, after: auditSnapshot(record, DRAFT_AUDIT_FIELDS), summary: 'Created product draft' });
    return record;
  } });
  await draft.populate('category');
  res.status(201).json({ success: true, message: 'Product draft saved', data: formatDraft(draft) });
});

exports.getDraft = asyncHandler(async (req, res) => {
  requireObjectId(req.params.id, 'draft id');
  const draft = await ProductDraft.findOne(draftQuery(req, { _id: req.params.id })).populate('category');
  if (!draft) return res.status(404).json({ success: false, message: 'Draft not found' });
  res.json({ success: true, data: formatDraft(draft) });
});

exports.updateDraft = asyncHandler(async (req, res) => {
  requireObjectId(req.params.id, 'draft id');
  const draft = await ProductDraft.findOne(draftQuery(req, { _id: req.params.id }));
  if (!draft) return res.status(404).json({ success: false, message: 'Draft not found' });
  await require('../services/storefrontDiscoveryService').validateComplements(req, req.body || {}, null, draft.storeId);
  if (draft.status === 'published') return res.status(409).json({ success: false, message: 'This draft is already published. Open the published product to edit its details.' });
  if (draft.status === 'archived') return res.status(409).json({ success: false, message: 'Restore this draft before editing it.' });
  const saveMode = req.body?.saveMode === 'auto' ? 'auto' : 'manual';
  const baseRevision = req.body?.baseRevision;
  if (baseRevision !== undefined && (!Number.isSafeInteger(Number(baseRevision)) || Number(baseRevision) < 0)) {
    return res.status(400).json({ success: false, message: 'Draft revision is invalid. Refresh the draft and try again.' });
  }
  const payload = normalizeDraftPayload(req.body);
  // Publication state, identity and source provenance are never client-editable.
  for (const key of ['_id', 'id', '__v', 'baseRevision', 'revision', 'readiness', 'saveMode', 'createdAt', 'updatedAt', 'sourceType', 'sourceSocialImportId', 'sourceJobId', 'sourceCandidateId', 'sourceUrl', 'sourcePlatform', 'createdBy', 'lastSavedBy', 'storeId', 'status', 'archivedAt', 'publishedProductId', 'importContext', 'lastPublishAttemptAt', 'lastPublishError']) delete payload[key];
  const payloadError = validateDraftPayload(payload);
  if (payloadError) return res.status(400).json({ success: false, message: payloadError });
  const categoryError = await validateDraftCategory(req, payload.category);
  if (categoryError) return res.status(400).json({ success: false, message: categoryError });
  if (payload.name && !payload.slug) payload.slug = uniqueDraftSlug(payload.name, draft._id);
  const currentRevision = Number(draft.revision || 0);
  const revisionFilter = baseRevision === undefined ? {} : Number(baseRevision) === 0
    ? { $or: [{ revision: 0 }, { revision: { $exists: false } }] }
    : { revision: Number(baseRevision) };
  const before = auditSnapshot(draft, DRAFT_AUDIT_FIELDS);
  const updated = await ProductDraft.findOneAndUpdate(
    draftQuery(req, { _id: draft._id, status: 'draft', publishingToken: { $exists: false }, ...revisionFilter }),
    { $set: { ...payload, lastSavedBy: req.user?._id }, $inc: { revision: 1 } },
    { new: true, runValidators: true },
  ).populate('category');
  if (!updated) {
    const latest = await ProductDraft.findOne(draftQuery(req, { _id: draft._id })).select('revision updatedAt status');
    return res.status(409).json({
      success: false,
      code: 'DRAFT_STALE',
      message: latest?.status !== 'draft' ? 'This draft can no longer be edited.' : 'This draft changed in another tab or by another team member. Reload it before saving.',
      data: { currentRevision: Number(latest?.revision ?? currentRevision), updatedAt: latest?.updatedAt },
    });
  }
  if (saveMode !== 'auto') await logAudit({ req, action: 'PRODUCT_DRAFT_UPDATED', entityType: 'ProductDraft', entityId: updated._id, before, after: auditSnapshot(updated, DRAFT_AUDIT_FIELDS), summary: 'Updated product draft' });
  res.json({ success: true, message: 'Draft updated successfully', data: formatDraft(updated) });
});

exports.deleteDraft = asyncHandler(async (req, res) => {
  requireObjectId(req.params.id, 'draft id');
  const draft = await ProductDraft.findOne(draftQuery(req, { _id: req.params.id })).select('+uploadOperationId');
  if (!draft) return res.status(404).json({ success: false, message: 'Draft not found' });
  // Add-product autosaves are disposable working state. Ordinary drafts must
  // pass through archive so accidental deletion is reversible.
  if (!draft.autosaveKey) {
    if (req.query.baseRevision !== undefined && Number(req.query.baseRevision) !== Number(draft.revision || 0)) throw new ApiError('DRAFT_STALE', 'This draft changed. Refresh before deleting it.', { statusCode: 409 });
    if (!['archived', 'published'].includes(draft.status)) return res.status(409).json({ success: false, message: 'Archive this draft before deleting it permanently.' });
    const expected = String(draft.name || draft._id).trim();
    if (String(req.query.confirm || '').trim() !== expected) return res.status(400).json({ success: false, message: `Type "${expected}" to permanently delete this draft.` });
  }
  const filter = draftQuery(req, { _id: draft._id, status: draft.status, updatedAt: draft.updatedAt, publishingToken: { $exists: false } });
  if (draft.publishedProductId) {
    if (!await supportsTransactions()) throw new ApiError('SERVICE_UNAVAILABLE', 'Safe published-draft removal requires a transaction-capable MongoDB deployment.');
    await runInTransaction(async session => {
      if (!session) throw new ApiError('SERVICE_UNAVAILABLE', 'Safe published-draft removal is unavailable.');
      const removed = await ProductDraft.findOneAndDelete(filter, { session });
      if (!removed) throw new ApiError('DRAFT_STALE', 'This draft changed or is being published. Refresh before deleting.', { statusCode: 409 });
      await DeletedProductDraft.create([{
        draftId: draft._id, productId: draft.publishedProductId, storeId: draft.storeId,
        sourceSocialImportId: draft.sourceSocialImportId, sourceCandidateId: draft.sourceCandidateId, deletedBy: req.user?._id,
      }], { session });
      await logAudit({ req, action: 'PRODUCT_DRAFT_DELETED', entityType: 'ProductDraft', entityId: draft._id, storeId: draft.storeId,
        before: auditSnapshot(draft, DRAFT_AUDIT_FIELDS), after: { publishedProductUnchanged: true }, summary: 'Removed published draft; publication receipt retained', session, strict: true });
    });
  } else {
    const removed = await ProductDraft.findOneAndDelete(filter);
    if (!removed) throw new ApiError('DRAFT_STALE', 'This draft changed or is being published. Refresh before deleting.', { statusCode: 409 });
  }
  // Never remove published media: it may still be used by the live product.
  if (draft.uploadOperationId) await require('../models/UploadOperation').updateOne({ _id: draft.uploadOperationId }, { $set: { status: 'REMOVED' } });
  if (draft.sourceType === 'manual' && !draft.publishedProductId) await cleanupUnreferencedDraftMedia(draft);
  if (!draft.publishedProductId) await logAudit({ req, action: 'PRODUCT_DRAFT_DELETED', entityType: 'ProductDraft', entityId: draft._id, before: auditSnapshot(draft, DRAFT_AUDIT_FIELDS), summary: draft.autosaveKey ? 'Deleted product form autosave' : 'Permanently deleted archived product draft' });
  res.json({ success: true, message: draft.publishedProductId ? 'Published draft removed. Its product is unchanged.' : 'Draft deleted permanently' });
});

exports.archiveDraft = asyncHandler(async (req, res) => {
  requireObjectId(req.params.id, 'draft id');
  const draft = await ProductDraft.findOne(draftQuery(req, { _id: req.params.id, autosaveKey: { $exists: false } }));
  if (!draft) return res.status(404).json({ success: false, message: 'Draft not found' });
  if (draft.status === 'archived') return res.json({ success: true, message: 'Draft is already archived', data: formatDraft(draft) });
  const before = auditSnapshot(draft, DRAFT_AUDIT_FIELDS);
  const updated = await ProductDraft.findOneAndUpdate(draftQuery(req, { _id: draft._id, updatedAt: draft.updatedAt, publishingToken: { $exists: false } }),
    { $set: { status: 'archived', archivedAt: new Date(), lastSavedBy: req.user?._id }, $inc: { revision: 1 } }, { new: true });
  if (!updated) throw new ApiError('DRAFT_STALE', 'This draft changed or is being published. Refresh before archiving.', { statusCode: 409 });
  draft.set(updated.toObject());
  await draft.populate('category');
  await logAudit({ req, action: 'PRODUCT_DRAFT_ARCHIVED', entityType: 'ProductDraft', entityId: draft._id, before, after: auditSnapshot(draft, DRAFT_AUDIT_FIELDS), summary: 'Archived product draft' });
  res.json({ success: true, message: 'Draft archived', data: formatDraft(draft) });
});

exports.restoreDraft = asyncHandler(async (req, res) => {
  requireObjectId(req.params.id, 'draft id');
  const draft = await ProductDraft.findOne(draftQuery(req, { _id: req.params.id, autosaveKey: { $exists: false } }));
  if (!draft) return res.status(404).json({ success: false, message: 'Draft not found' });
  if (draft.status !== 'archived') return res.json({ success: true, message: 'Draft is already active', data: formatDraft(draft) });
  const before = auditSnapshot(draft, DRAFT_AUDIT_FIELDS);
  const updated = await ProductDraft.findOneAndUpdate(draftQuery(req, { _id: draft._id, updatedAt: draft.updatedAt, publishingToken: { $exists: false } }),
    { $set: { status: draft.publishedProductId ? 'published' : 'draft', archivedAt: null, lastSavedBy: req.user?._id }, $inc: { revision: 1 } }, { new: true });
  if (!updated) throw new ApiError('DRAFT_STALE', 'This draft changed. Refresh before restoring.', { statusCode: 409 });
  draft.set(updated.toObject());
  await draft.populate('category');
  await logAudit({ req, action: 'PRODUCT_DRAFT_RESTORED', entityType: 'ProductDraft', entityId: draft._id, before, after: auditSnapshot(draft, DRAFT_AUDIT_FIELDS), summary: 'Restored product draft' });
  res.json({ success: true, message: 'Draft restored', data: formatDraft(draft) });
});

exports.publishSelected = asyncHandler(async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? [...new Set(req.body.ids.filter(Boolean).map(id => String(requireObjectId(id, 'draft id'))))] : [];
  if (!ids.length) return res.status(400).json({ success: false, message: 'Please select at least one draft' });

  const drafts = await ProductDraft.find(draftQuery(req, { _id: { $in: ids }, autosaveKey: { $exists: false } })).populate('category');
  if (drafts.length !== ids.length) return res.status(404).json({ success: false, message: 'One or more selected drafts no longer exist. Refresh the list before publishing.' });
  const draftMap = new Map(drafts.map((draft) => [String(draft._id), draft]));
  const payloads = new Map();
  const results = [];
  const published = [];
  for (const id of ids) {
    const draft = draftMap.get(id);
    if (draft.status === 'archived') {
      results.push({ id, name: draft.name || '', status: 'failed', message: 'Restore this draft before publishing it.' });
      continue;
    }
    if (draft.status === 'published' && draft.publishedProductId) {
      const product = await Product.findById(draft.publishedProductId);
      if (!product) {
        results.push({ id, name: draft.name || '', status: 'failed', message: 'The published product was permanently removed. This draft cannot recreate it.' });
        continue;
      }
      if (product) published.push(product);
      results.push({ id, name: draft.name || '', status: 'already-published', productId: draft.publishedProductId });
      continue;
    }
    const prepared = await applyProductStructure(buildProductPayloadFromDraft(draft));
    try { await require('../services/storefrontDiscoveryService').validateComplements(req, { completeLookProductIds: (draft.completeLookProductIds || []).map(String) }, null, draft.storeId); }
    catch (error) { results.push({ id, name: draft.name || '', status: 'failed', message: error.message }); continue; }
    payloads.set(id, prepared);
    const validationMessage = validatePublishDraft(draft, prepared) || await validateCommercialDuplicates(draft, prepared);
    if (validationMessage) {
      await ProductDraft.updateOne(draftQuery(req, { _id: draft._id }), { $set: { lastPublishAttemptAt: new Date(), lastPublishError: validationMessage } });
      results.push({ id, name: draft.name || '', status: 'failed', message: validationMessage });
      continue;
    }
    try {
      const product = await publishPreparedDraft(draft, prepared, { userId: req.user?._id });
      if (product) published.push(product);
      results.push({ id, name: draft.name || '', status: 'published', productId: product?._id });
      await logAudit({ req, action: 'PRODUCT_DRAFT_PUBLISHED', entityType: 'ProductDraft', entityId: draft._id, before: { status: 'draft' }, after: { status: 'published', publishedProductId: product?._id }, summary: `Published product draft ${draft.name || draft._id}` });
    } catch (error) {
      const message = error.message || 'Product could not be published';
      await ProductDraft.updateOne(draftQuery(req, { _id: draft._id }), { $set: { lastPublishAttemptAt: new Date(), lastPublishError: message } });
      results.push({ id, name: draft.name || '', status: 'failed', message });
    }
  }
  const failed = results.filter((result) => result.status === 'failed');
  if (!published.length && failed.length) {
    return res.status(400).json({ success: false, message: failed[0].message, data: { products: [], results, errors: failed.map((item) => item.message), summary: summarizePublishResults(results) } });
  }
  res.json({
    success: true,
    message: failed.length ? `${published.length} draft${published.length === 1 ? '' : 's'} published; ${failed.length} need attention.` : 'Selected drafts published successfully',
    data: { products: await Promise.all(published.filter(Boolean).map(async product => ({ ...product.toObject(), rentalOffers: await require('../services/productRentalPricing').offers(product) }))), results, summary: summarizePublishResults(results) },
  });
});

async function publishPreparedDraft(draft, prepared, { userId } = {}) {
    await require('../services/productRentalPricing').prepare(draft.rentalPricing);
    const token = require('node:crypto').randomUUID();
    const baseRevision = Number(draft.revision || 0);
    // On replica sets the claim, product, inventory and publication state
    // commit together. A crashed process cannot leave a stuck publish claim.
    return runInTransaction(async session => {
    let claimed;
    // Coordinate publication with archive/delete without requiring transactions
    // in existing standalone publishing deployments. Concurrent retries wait
    // briefly for the winning request and converge on its product.
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const current = await ProductDraft.findById(draft._id).select('+publishingToken').session(session || null);
      if (!current) throw new ApiError('NOT_FOUND', 'This draft was removed. Refresh the list.');
      if (current.status === 'published' && current.publishedProductId) {
        const product = await Product.findById(current.publishedProductId).session(session || null);
        if (!product) throw new ApiError('NOT_FOUND', 'The published product was deleted. This draft cannot recreate it.');
        return product;
      }
      if (current.status !== 'draft') throw new ApiError('DRAFT_STALE', 'This draft is archived. Restore it before publishing.', { statusCode: 409 });
      if (!current.publishingToken) {
        if (Number(current.revision || 0) !== baseRevision) throw new ApiError('DRAFT_STALE', 'This draft changed. Reload before publishing.', { statusCode: 409 });
        claimed = await ProductDraft.findOneAndUpdate({ _id: draft._id, status: 'draft', updatedAt: current.updatedAt, publishingToken: { $exists: false } },
          { $set: { publishingToken: token }, $inc: { revision: 1 } }, { new: true, session: session || undefined }).select('+publishingToken');
        if (claimed) break;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!claimed) throw new ApiError('DRAFT_STALE', 'This draft is already being published. Refresh shortly.', { statusCode: 409 });
    draft.revision = claimed.revision;
    try {
    const productPayload = prepared || await prepareImportedDraft(draft);
    await require('../services/storefrontDiscoveryService').validateComplements({}, { completeLookProductIds: (productPayload.completeLookProductIds || []).map(String) }, null, draft.storeId);
    if (draft.sourceType && !productPayload.sku) productPayload.sku = `IMPORT-${String(draft._id).slice(-10).toUpperCase()}`;
    productPayload.slug = await ensureUniqueProductSlug(productPayload.slug || productPayload.name, draft._id, draft.storeId);
    if (productPayload.sku && !prepared) productPayload.sku = await ensureUniqueSku(productPayload.sku, draft._id, draft.storeId);
    // The unique sourceDraftId index makes retries and concurrent publication
    // converge on one product for ordinary uploads as well as imported drafts.
    let product = await Product.findOne({ sourceDraftId: draft._id }).session(session || null);
    if (!product) {
      const productData = { ...normalizeProductPayload(productPayload), sourceDraftId: draft._id };
      if (Number(productData.stock || 0) > 0) {
        productData.lastInventoryChangeAt = new Date();
        productData.lastInventoryChangedBy = userId;
      }
      try { product = session ? (await Product.create([productData], { session }))[0] : await Product.create(productData); }
      catch (error) { if (session || error.code !== 11000) throw error; product = await Product.findOne({ sourceDraftId: draft._id }); if (!product) throw error; }
    }
    await recordOpeningInventory(product, { userId, reference: `Draft ${draft._id}`, reason: 'Draft opening inventory' }, session);
    if (draft.rentalPricing) {
      const store = await require('../models/Store').findById(draft.storeId).session(session);
      await require('../services/productRentalPricing').save(store, product, draft.rentalPricing, session);
    }
    if (session) await ProductDraft.updateOne({ _id: draft._id, publishingToken: token }, { $unset: { publishingToken: 1 } }, { session });
    draft.status = 'published';
    draft.publishedProductId = product._id;
    draft.archivedAt = null;
    draft.lastPublishAttemptAt = new Date();
    draft.lastPublishError = '';
    draft.revision = Number(draft.revision || 0) + 1;
    for (const field of ['status', 'publishedProductId', 'archivedAt', 'lastPublishAttemptAt', 'lastPublishError', 'revision']) draft.markModified(field);
    await draft.save(session ? { session } : undefined);
    return product;
    } finally {
      if (!session) await ProductDraft.updateOne({ _id: draft._id, publishingToken: token }, { $unset: { publishingToken: 1 } });
    }
    });
}

async function prepareImportedDraft(draft) {
  if (draft.category && !draft.category.name) await draft.populate('category');
  const payload = await applyProductStructure(buildProductPayloadFromDraft(draft));
  const message = validatePublishDraft(draft, payload);
  if (message) throw Object.assign(new Error(message), { statusCode: 400 });
  return payload;
}

exports.prepareImportedDraft = prepareImportedDraft;
exports.publishPreparedDraft = publishPreparedDraft;

function formatDraft(draft) {
  const data = typeof draft.toObject === 'function' ? draft.toObject() : { ...draft };
  delete data.uploadOperationId;
  data.id = String(data._id || data.id);
  if (data.attributeValues instanceof Map) data.attributeValues = Object.fromEntries(data.attributeValues);
  data.readiness = draftReadiness(data);
  return data;
}

function draftReadiness(data = {}) {
  if (data.status === 'published') return { state: 'published', score: 100, issues: [], warnings: [] };
  if (data.status === 'archived') return { state: 'archived', score: 0, issues: [], warnings: [] };
  const issues = [];
  const warnings = [];
  const price = Number(data.sellingPrice ?? data.price);
  const originalPrice = Number(data.originalPrice ?? price);
  const images = Array.isArray(data.images) ? data.images.filter((image) => image?.url) : [];
  if (String(data.name || '').trim().length < 3) issues.push('Add a product name');
  if (!data.category) issues.push('Choose a category');
  else if (data.category?.isArchived) issues.push('Choose an active category');
  if (!images.length && !data.image) issues.push('Add at least one product photo');
  if (!Number.isFinite(price) || price <= 0) issues.push('Add a valid selling price');
  if (data.commerceMode && data.commerceMode !== 'SALE_ONLY') { try { require('../services/productRentalPricing').values(data.rentalPricing); } catch (error) { issues.push(error.message); } }
  if (!Number.isFinite(originalPrice) || originalPrice < price) issues.push('MRP must be equal to or above the selling price');
  if (!Number.isSafeInteger(Number(data.stock)) || Number(data.stock) < 0) issues.push('Add a whole-number stock quantity');
  if (!issues.length) {
    try {
      const sizingError = validateProductSizing(buildProductPayloadFromDraft(data), data.category?.name || '');
      if (sizingError) issues.push(sizingError);
    } catch {
      issues.push('Review the size and variant information');
    }
  }
  if (String(data.description || '').trim().length < 20) warnings.push('Add a useful product description');
  if (!String(data.sku || '').trim()) warnings.push('Add a SKU for easier inventory control');
  if (!(Number(data.shippingWeightKg) > 0)) warnings.push('Add packed weight for accurate shipping');
  if (!String(data.metaTitle || '').trim() || !String(data.metaDescription || '').trim()) warnings.push('Complete search preview details');
  const requiredChecks = 6 + (data.commerceMode && data.commerceMode !== 'SALE_ONLY' ? 1 : 0);
  const completedRequired = Math.max(0, requiredChecks - issues.length);
  const score = Math.max(0, Math.min(100, Math.round((completedRequired / requiredChecks) * 80 + ((4 - Math.min(4, warnings.length)) / 4) * 20)));
  return { state: issues.length ? 'incomplete' : warnings.length ? 'review' : 'ready', score, issues: issues.slice(0, 8), warnings: warnings.slice(0, 8) };
}

function summarizePublishResults(results = []) {
  return results.reduce((summary, result) => {
    const key = result.status === 'already-published' ? 'alreadyPublished' : result.status;
    summary[key] = (summary[key] || 0) + 1;
    return summary;
  }, { published: 0, failed: 0, alreadyPublished: 0 });
}

async function validateCommercialDuplicates(draft, prepared = {}) {
  const scope = draft.storeId ? { storeId: draft.storeId } : {};
  const checks = [
    ['sku', prepared.sku, 'SKU'],
    ['barcode', prepared.barcode, 'barcode'],
    ['supplierSku', prepared.supplierSku, 'supplier SKU'],
  ];
  for (const [field, rawValue, label] of checks) {
    const value = String(rawValue || '').trim();
    if (!value) continue;
    const duplicate = await Product.exists(andFilter({ [field]: value, sourceDraftId: { $ne: draft._id } }, scope));
    if (duplicate) return `Draft "${draft.name}": ${label} "${value}" is already used by another product`;
  }
  return '';
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeDraftPayload(body = {}) {
  const payload = { ...body };
  delete payload.publishingToken;
  delete payload.uploadOperationId;
  if (typeof payload.images === 'string') {
    try {
      payload.images = JSON.parse(payload.images);
    } catch {
      payload.images = [];
    }
  }
  if (typeof payload.videos === 'string') {
    try {
      payload.videos = JSON.parse(payload.videos);
    } catch {
      payload.videos = [];
    }
  }
  if (typeof payload.tags === 'string') payload.tags = splitList(payload.tags);
  if (typeof payload.sizes === 'string') payload.sizes = splitList(payload.sizes);
  if (typeof payload.colors === 'string') payload.colors = splitList(payload.colors);
  if (typeof payload.highlights === 'string') payload.highlights = splitList(payload.highlights);
  if (payload.images) payload.images = sanitizeProductImages(payload.images);
  if (payload.price !== undefined) payload.price = Number(payload.price);
  if (payload.originalPrice !== undefined) payload.originalPrice = Number(payload.originalPrice);
  if (payload.salePrice !== undefined) payload.salePrice = Number(payload.salePrice);
  if (payload.sellingPrice !== undefined) payload.sellingPrice = Number(payload.sellingPrice);
  if (payload.stock !== undefined) payload.stock = Number(payload.stock);
  for (const key of ['costPrice', 'gstRate', 'lowStockAlert', 'reorderQuantity', 'shippingWeightKg']) if (payload[key] !== undefined) payload[key] = Number(payload[key]);
  if (payload.returnWindowDays === '' || payload.returnWindowDays === null) delete payload.returnWindowDays;
  else if (payload.returnWindowDays !== undefined) payload.returnWindowDays = Number(payload.returnWindowDays);
  if (payload.packageDimensions && typeof payload.packageDimensions === 'object') payload.packageDimensions = {
    lengthCm: Number(payload.packageDimensions.lengthCm || 0),
    widthCm: Number(payload.packageDimensions.widthCm || 0),
    heightCm: Number(payload.packageDimensions.heightCm || 0),
  };
  for (const key of ['restockAt', 'publishAt', 'saleStartAt', 'saleEndAt']) if (payload[key] === '' || payload[key] === null) payload[key] = null;
  if (payload.sizeChart) payload.sizeChart = normalizeSizeChart(payload.sizeChart);
  return payload;
}

async function validateDraftCategory(req, categoryId) {
  if (categoryId === undefined || categoryId === null || categoryId === '') return '';
  const id = typeof categoryId === 'object' ? categoryId._id : categoryId;
  if (!mongoose.Types.ObjectId.isValid(id)) return 'Choose a valid product category';
  const category = await Category.findOne(draftQuery(req, { _id: id })).select('isArchived');
  if (!category) return 'Choose a category from this store';
  return category.isArchived ? 'Choose an active category. The selected category is archived.' : '';
}

function validateDraftPayload(payload) {
  for (const key of ['stock', 'lowStockAlert', 'reorderQuantity']) {
    if (payload[key] !== undefined && (!Number.isSafeInteger(payload[key]) || payload[key] < 0)) return `${draftFieldLabel(key)} must be a whole number of zero or more`;
  }
  for (const key of ['price', 'sellingPrice', 'originalPrice', 'salePrice', 'costPrice']) {
    if (payload[key] !== undefined && (!Number.isFinite(payload[key]) || payload[key] < 0)) return 'Product amounts must be finite values of zero or more';
  }
  if (payload.gstRate !== undefined && (!Number.isFinite(payload.gstRate) || payload.gstRate < 0 || payload.gstRate > 100)) return 'GST rate must be between 0 and 100';
  if (payload.shippingWeightKg !== undefined && (!Number.isFinite(payload.shippingWeightKg) || payload.shippingWeightKg < 0 || payload.shippingWeightKg > 1000)) return 'Packed unit weight must be between 0 and 1000 kg';
  if (payload.returnWindowDays !== undefined && (!Number.isSafeInteger(payload.returnWindowDays) || payload.returnWindowDays < 0 || payload.returnWindowDays > 365)) return 'Product return window must be a whole number between 0 and 365 days';
  if (payload.packageDimensions && ['lengthCm', 'widthCm', 'heightCm'].some((field) => !Number.isFinite(payload.packageDimensions[field]) || payload.packageDimensions[field] < 0 || payload.packageDimensions[field] > 1000)) return 'Package dimensions must be between 0 and 1000 cm';
  for (const key of ['restockAt', 'publishAt', 'saleStartAt', 'saleEndAt']) if (payload[key] && Number.isNaN(new Date(payload[key]).getTime())) return 'Choose valid product schedule dates';
  if (payload.saleStartAt && payload.saleEndAt && new Date(payload.saleStartAt) >= new Date(payload.saleEndAt)) return 'Sale end must be after sale start';
  return '';
}

function draftFieldLabel(key) {
  return { stock: 'Stock', lowStockAlert: 'Low-stock alert', reorderQuantity: 'Reorder quantity' }[key] || 'Value';
}

function readAutosaveKey(value) {
  const key = String(value || '').trim();
  if (!/^[a-z0-9][a-z0-9:_-]{2,79}$/i.test(key)) throw Object.assign(new Error('Choose a valid autosave key'), { statusCode: 400 });
  return key;
}

function isMeaningfulDraft(payload = {}) {
  return Boolean(String(payload.name || payload.sku || payload.description || '').trim() || payload.images?.length);
}

function buildProductPayloadFromDraft(draft) {
  const data = typeof draft.toObject === 'function' ? draft.toObject() : { ...draft };
  const sellingPrice = Number(data.sellingPrice ?? data.price ?? 0);
  const originalPrice = Number(data.originalPrice ?? sellingPrice);
  return normalizeProductSizing({
    ...(data.storeId ? { storeId: data.storeId } : {}),
    name: data.name,
    commerceMode: data.commerceMode || 'SALE_ONLY',
    attributeValues: data.attributeValues,
    slug: data.slug || slugify(data.name || 'product'),
    sku: data.sku,
    brand: data.brand || '',
    shortDescription: data.shortDescription || '',
    description: data.description || '',
    category: data.category?._id || data.category || undefined,
    subCategory: data.subCategory || '',
    price: sellingPrice,
    originalPrice,
    costPrice: Number(data.costPrice || 0),
    gstRate: Number(data.gstRate || 0),
    hsnCode: data.hsnCode || '',
    barcode: data.barcode || '',
    discountPercentage: originalPrice > sellingPrice ? Math.round(((originalPrice - sellingPrice) / originalPrice) * 100) : 0,
    images: data.images || (data.image ? [{ url: data.image, primary: true }] : []),
    videos: data.videos || [],
    sizes: data.sizes || [],
    sizingMode: data.sizingMode || 'auto',
    sizeChartProfile: data.sizeChartProfile || 'auto',
    sizeChart: normalizeSizeChart(data.sizeChart),
    sizeFitNotes: data.sizeFitNotes || '',
    colors: data.colors || [],
    fabric: data.fabric || '',
    occasion: data.occasion || '',
    completeLookProductIds: data.completeLookProductIds || [],
    stock: Number(data.stock || 0),
    lowStockAlert: Number(data.lowStockAlert ?? 5),
    reorderQuantity: Number(data.reorderQuantity || 0),
    shippingWeightKg: Number(data.shippingWeightKg || 0),
    packageDimensions: data.packageDimensions || {},
    countryOfOrigin: data.countryOfOrigin || 'India',
    manufacturerDetails: data.manufacturerDetails || '',
    warranty: data.warranty || '',
    supplierName: data.supplierName || '',
    supplierSku: data.supplierSku || '',
    restockAt: data.restockAt || null,
    publishAt: data.publishAt || null,
    salePrice: Number(data.salePrice || 0) || undefined,
    saleStartAt: data.saleStartAt || null,
    saleEndAt: data.saleEndAt || null,
    variants: data.variants || [],
    tags: data.tags || [],
    highlights: data.highlights || [],
    careInstructions: data.careInstructions || '',
    returnPolicy: data.returnPolicy || '',
    returnable: data.returnable !== false,
    exchangeable: data.exchangeable !== false,
    returnWindowDays: data.returnWindowDays === '' || data.returnWindowDays === null || data.returnWindowDays === undefined ? undefined : Number(data.returnWindowDays),
    metaTitle: data.metaTitle || '',
    metaDescription: data.metaDescription || '',
    metaKeywords: data.metaKeywords || '',
    isFeatured: Boolean(data.isFeatured),
    isNewArrival: Boolean(data.isNewArrival),
    isBestSeller: Boolean(data.isBestSeller),
    showOnHomepage: Boolean(data.showOnHomepage),
    showInTrending: Boolean(data.showInTrending),
    showInFestive: Boolean(data.showInFestive),
    isActive: true,
  }, data.category?.name || '');
}

function validatePublishDraft(draft, prepared) {
  if (draft.commerceMode && draft.commerceMode !== 'SALE_ONLY') { try { require('../services/productRentalPricing').values(draft.rentalPricing); } catch (error) { return `Draft "${draft.name}": ${error.message}`; } }
  if (!Number.isSafeInteger(draft.stock) || draft.stock < 0) return `Draft "${draft.name}" needs a whole-number stock quantity`;
  if (draft.sourceType === 'social-import' && (!Number.isFinite(draft.sellingPrice ?? draft.price) || (draft.sellingPrice ?? draft.price) <= 0)) return `Draft "${draft.name}" needs a valid selling price`;
  if (!draft?.name || String(draft.name).trim().length < 3) return `Draft "${draft?.slug || draft?._id}" needs a product name`;
  if (!draft.category) return `Draft "${draft.name}" needs a category`;
  if (draft.category?.isArchived) return `Draft "${draft.name}" uses an archived category. Choose an active category`;
  const sellingPrice = Number(draft.sellingPrice ?? draft.price);
  const originalPrice = Number(draft.originalPrice ?? sellingPrice);
  if (!Number.isFinite(sellingPrice) || sellingPrice <= 0) return `Draft "${draft.name}" needs a selling price`;
  if (!Number.isFinite(originalPrice) || originalPrice < 0) return `Draft "${draft.name}" needs a valid original price`;
  if (Number(draft.stock) < 0) return `Draft "${draft.name}" has invalid stock`;
  if (!Array.isArray(draft.images) || !draft.images.length) return `Draft "${draft.name}" needs at least one image`;
  if (sellingPrice > originalPrice) return `Draft "${draft.name}" selling price cannot exceed original price`;
  if (Number(draft.salePrice) > 0) {
    if (!(Number(draft.salePrice) > 0) || Number(draft.salePrice) >= sellingPrice) return `Draft "${draft.name}" needs a scheduled sale price below its regular selling price`;
    if (!draft.saleStartAt || !draft.saleEndAt || new Date(draft.saleStartAt) >= new Date(draft.saleEndAt)) return `Draft "${draft.name}" needs a valid sale start and end`;
  }
  const variantError = validateVariantPayload(prepared?.variants ?? draft.variants);
  if (variantError) return `Draft "${draft.name}": ${variantError}`;
  const sizingError = validateProductSizing(prepared || buildProductPayloadFromDraft(draft), draft.category?.name || '');
  if (sizingError) return `Draft "${draft.name}": ${sizingError}`;
  return '';
}

async function ensureUniqueProductSlug(baseSlug, draftId, storeId) {
  const cleanBase = slugify(baseSlug || `draft-${draftId}`);
  let candidate = cleanBase;
  let suffix = 1;
  while (await Product.exists(andFilter({ slug: candidate }, storeId ? { storeId } : {}))) {
    suffix += 1;
    candidate = `${cleanBase}-${suffix}`;
  }
  return candidate;
}

async function ensureUniqueSku(baseSku, draftId, storeId) {
  const cleanBase = String(baseSku || `DRAFT-${draftId}`).trim();
  let candidate = cleanBase;
  let suffix = 1;
  while (await Product.exists(andFilter({ sku: candidate }, storeId ? { storeId } : {}))) {
    suffix += 1;
    candidate = `${cleanBase}-${suffix}`;
  }
  return candidate;
}

function uniqueDraftSlug(value, draftId) {
  return `${slugify(value || 'draft')}-${String(draftId || Date.now()).slice(-6)}`;
}

function splitList(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function normalizeSizeChart(value = {}) {
  const allowedFields = ['acrossShoulder', 'sleeveLength', 'bust', 'chest', 'waist', 'frontLength', 'bottomLength', 'hips', 'outseamLength', 'inseamLength'];
  const columns = (Array.isArray(value?.columns) ? value.columns : []).filter((field) => allowedFields.includes(field));
  const rows = (Array.isArray(value?.rows) ? value.rows : []).map((row) => {
    const next = { size: String(row?.size || '').trim() };
    columns.forEach((field) => {
      const measurement = Number(row?.[field]);
      if (Number.isFinite(measurement) && measurement > 0) next[field] = measurement;
    });
    return next;
  }).filter((row) => row.size);
  return { unit: value?.unit === 'cm' ? 'cm' : 'in', columns, rows };
}

async function cleanupTempFiles(files = []) {
  await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => null)));
}

async function cleanupUnreferencedDraftMedia(draft) {
  const entries = [
    ...(Array.isArray(draft.images) ? draft.images.flatMap(item => [item, ...(item.variants || []), item.background?.original, ...(item.background?.original?.variants || []), item.background?.edited, ...(item.background?.edited?.variants || [])].filter(Boolean)).map((item) => ({ ...item, resourceType: 'image' })) : []),
    ...(Array.isArray(draft.videos) ? draft.videos.map((item) => ({ ...item, resourceType: 'video' })) : []),
  ].filter((item) => item?.url || item?.publicId);
  await Promise.allSettled(entries.map(async (entry) => {
    if (await require('../services/mediaReferenceService').referenced(entry)) return;
    const mediaUrl = String(entry.url || '');
    if (mediaUrl.startsWith('/uploads/') || /\/uploads\//i.test(mediaUrl)) { await deleteLocalUpload(mediaUrl); return; }
    const r2Base = String(process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
    if (isR2Configured() && (r2Base && mediaUrl.startsWith(r2Base))) { await deleteImageFromR2(entry); return; }
    if (isCloudinaryConfigured() && entry.publicId && /res\.cloudinary\.com/i.test(mediaUrl)) { await deleteCloudinaryFile(entry, entry.resourceType); }
  }));
}

async function deleteLocalUpload(url) {
  let pathname = String(url || '');
  try { if (/^https?:\/\//i.test(pathname)) pathname = new URL(pathname).pathname; } catch { return; }
  if (!pathname.startsWith('/uploads/')) return;
  const uploadsRoot = path.resolve(__dirname, '..', 'uploads');
  const target = path.resolve(uploadsRoot, pathname.slice('/uploads/'.length));
  if (target !== uploadsRoot && !target.startsWith(`${uploadsRoot}${path.sep}`)) return;
  await fs.unlink(target).catch(() => null);
}
