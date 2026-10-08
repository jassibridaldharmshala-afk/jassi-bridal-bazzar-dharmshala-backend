const fs = require('fs/promises');
const Order = require('../models/Order');
const ReturnExchange = require('../models/ReturnExchange');
const InventoryItem = require('../models/InventoryItem');
const VerificationEvidence = require('../models/VerificationEvidence');
const { asyncHandler } = require('../middleware/validate');
const { ApiError, notFound } = require('../utils/apiError');
const { andFilter } = require('../services/storeService');
const { getStoreSettings } = require('../services/paymentSettingsService');
const { logAudit } = require('../services/auditService');
const { assessInspection, cleanCode, generateCode, protectionSettings, refreshCustomerRisk } = require('../services/fraudProtectionService');

const imageTypes = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
const videoTypes = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
// Staged labels and customer evidence must never enter the public uploads tree.
const upload = require('../middleware/photoUploadMiddleware').createPhotoUpload({ privateEvidence: true, allowVideo: true, maxFileBytes: 50 * 1024 * 1024 });

exports.evidenceUploadMiddleware = (req, res, next) => upload.array('files', 8)(req, res, next);

async function cleanup(files = []) { await Promise.all(files.map(file => fs.unlink(file.path).catch(() => null))); }

async function validMagic(file) {
  const handle = await fs.open(file.path, 'r');
  const bytes = Buffer.alloc(16);
  try { await handle.read(bytes, 0, 16, 0); } finally { await handle.close(); }
  if (imageTypes.has(file.mimetype)) {
    return (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
      || (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
      || (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP');
  }
  if (file.mimetype === 'video/webm') return bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  return bytes.subarray(4, 8).toString('ascii') === 'ftyp';
}

exports.uploadEvidence = asyncHandler(async (req, res) => {
  if (!req.files?.length && req.body?.resumeUpload !== true) throw new ApiError('VALIDATION_ERROR', 'Choose at least one evidence file.');
  try {
    for (const file of req.files || []) {
      if (imageTypes.has(file.mimetype) && file.size > 8 * 1024 * 1024) throw new ApiError('VALIDATION_ERROR', 'Each private evidence photo must be 8 MB or smaller.');
      if (!await validMagic(file)) throw new ApiError('VALIDATION_ERROR', 'One or more evidence files do not match their declared file type.');
    }
    const saved = await require('../services/privateEvidenceService').upload(req);
    res.status(201).json({ files: saved });
  } catch (error) { await cleanup(req.files || []); throw error; }
});

function barcodeSvgData(uniqueItemId) {
  const patterns = { '0':'nnnwwnwnn','1':'wnnwnnnnw','2':'nnwwnnnnw','3':'wnwwnnnnn','4':'nnnwwnnnw','5':'wnnwwnnnn','6':'nnwwwnnnn','7':'nnnwnnwnw','8':'wnnwnnwnn','9':'nnwwnnwnn','A':'wnnnnwnnw','B':'nnwnnwnnw','C':'wnwnnwnnn','D':'nnnnwwnnw','E':'wnnnwwnnn','F':'nnwnwwnnn','G':'nnnnnwwnw','H':'wnnnnwwnn','I':'nnwnnwwnn','J':'nnnnwwwnn','K':'wnnnnnnww','L':'nnwnnnnww','M':'wnwnnnnwn','N':'nnnnwnnww','O':'wnnnwnnwn','P':'nnwnwnnwn','Q':'nnnnnnwww','R':'wnnnnnwwn','S':'nnwnnnwwn','T':'nnnnwnwwn','U':'wwnnnnnnw','V':'nwwnnnnnw','W':'wwwnnnnnn','X':'nwnnwnnnw','Y':'wwnnwnnnn','Z':'nwwnwnnnn','-':'nwnnnnwnw','*':'nwnnwnwnn' };
  const text = `*${cleanCode(uniqueItemId, 48)}*`; let x = 12; const bars = [];
  for (const char of text) { const pattern = patterns[char] || patterns['-']; pattern.split('').forEach((width, index) => { const size = width === 'w' ? 3 : 1; if (index % 2 === 0) bars.push(`<rect x="${x}" y="8" width="${size}" height="56"/>`); x += size; }); x += 1; }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${x + 12}" height="86" viewBox="0 0 ${x + 12} 86"><rect width="100%" height="100%" fill="white"/><g fill="black">${bars.join('')}</g><text x="50%" y="80" font-family="Arial" font-size="11" text-anchor="middle">${cleanCode(uniqueItemId, 48)}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

exports.generateItemIdentities = asyncHandler(async (req, res) => {
  const order = await Order.findOne(andFilter({ _id: req.params.id }, req.tenantFilter));
  if (!order) throw notFound('Order not found');
  if (!['Pending', 'Confirmed'].includes(order.orderStatus)) throw new ApiError('ORDER_TRANSITION_INVALID', 'Item labels can only be assigned before the order is packed.', { statusCode: 409 });
  const requestedItemId = String(req.body?.orderItemId || '');
  const targets = requestedItemId ? order.orderItems.filter(item => String(item._id) === requestedItemId) : order.orderItems;
  if (!targets.length) throw new ApiError('VALIDATION_ERROR', 'Choose a valid order item.');
  const created = [];
  for (const item of targets) {
    const activeQuantity = Math.max(0, Number(item.quantity || 0) - Number(item.cancelledQuantity || 0));
    const existing = await InventoryItem.find(andFilter({ order: order._id, orderItemId: String(item._id) }, req.tenantFilter));
    for (let index = existing.length; index < activeQuantity; index += 1) {
      let record;
      for (let attempt = 0; attempt < 5 && !record; attempt += 1) {
        try { record = await InventoryItem.create({ product: item.product, variantId: item.variantId || '', sku: item.sku || '', uniqueItemId: generateCode('SC', item.sku || String(item.product).slice(-4)), order: order._id, orderItemId: String(item._id), status: 'RESERVED', assignedAt: new Date(), storeId: order.storeId }); }
        catch (error) { if (error?.code !== 11000) throw error; }
      }
      if (!record) throw new ApiError('ITEM_ID_GENERATION_FAILED', 'A unique item label could not be generated. Please retry.', { statusCode: 503 });
      existing.push(record); created.push(record);
    }
    item.uniqueItemIds = existing.slice(0, activeQuantity).map(record => record.uniqueItemId);
  }
  order.revision = Number(order.revision || 0) + 1; await order.save();
  await logAudit({ req, action: 'ITEM_IDENTITIES_ASSIGNED', entityType: 'Order', entityId: order._id, storeId: order.storeId, after: { generated: created.length, orderItemIds: targets.map(item => String(item._id)) } });
  const items = await InventoryItem.find(andFilter({ order: order._id }, req.tenantFilter)).lean();
  res.status(created.length ? 201 : 200).json({ items: items.map(item => ({ ...item, barcodeDataUrl: barcodeSvgData(item.uniqueItemId), verificationValue: item.uniqueItemId })), revision: order.revision });
});

exports.verifyItemIdentity = asyncHandler(async (req, res) => {
  const uniqueItemId = cleanCode(req.params.uniqueItemId, 64);
  const item = await InventoryItem.findOne(andFilter({ uniqueItemId }, req.tenantFilter)).populate('product', 'name sku').lean();
  if (!item) throw notFound('This item identity does not belong to the active store.');
  res.set('Cache-Control', 'private, no-store').json({ productId: item.product?._id || item.product, productName: item.product?.name, variantId: item.variantId, sku: item.sku, uniqueItemId: item.uniqueItemId, orderItemId: item.orderItemId, status: item.status });
});

exports.verifyPacking = asyncHandler(async (req, res) => {
  const order = await Order.findOne(andFilter({ _id: req.params.id }, req.tenantFilter));
  if (!order) throw notFound('Order not found');
  if (!['Confirmed', 'Packed'].includes(order.orderStatus)) throw new ApiError('ORDER_TRANSITION_INVALID', 'Confirm the order before packing verification.', { statusCode: 409 });
  const settings = protectionSettings(await getStoreSettings(order.storeId ? { storeId: order.storeId } : req.tenantFilter || {}));
  const evidence = await require('../services/privateEvidenceService').attachments(req, req.body?.evidence || [], ['PRODUCT_PHOTO', 'CONDITION_PHOTO', 'PACKAGE_PHOTO', 'SHIPPING_LABEL_PHOTO', 'PACKING_VIDEO']);
  const photoCount = evidence.filter(item => item.type !== 'PACKING_VIDEO').length;
  const videoCount = evidence.filter(item => item.type === 'PACKING_VIDEO').length;
  const sealId = cleanCode(req.body?.sealId);
  const securityTagId = cleanCode(req.body?.securityTagId);
  const weight = Number(req.body?.dispatchWeightGrams);
  if (settings.requirePackingPhotos && !photoCount) throw new ApiError('VALIDATION_ERROR', 'Add the required packing photo evidence.');
  if (settings.requirePackingVideo && !videoCount) throw new ApiError('VALIDATION_ERROR', 'Add the required packing video evidence.');
  if (settings.requireSecuritySeal && !sealId) throw new ApiError('VALIDATION_ERROR', 'Scan or enter the security seal ID.');
  if (settings.enableSecurityTag && !securityTagId) throw new ApiError('VALIDATION_ERROR', 'Scan or enter the return security tag ID.');
  if ((settings.requireDispatchWeight || (settings.highValueVerificationThreshold > 0 && Number(order.finalAmount || 0) >= settings.highValueVerificationThreshold)) && !(weight > 0)) throw new ApiError('VALIDATION_ERROR', 'Enter the dispatch weight in grams.');
  const submitted = Array.isArray(req.body?.items) ? req.body.items : [];
  const expectedIds = [];
  for (const orderItem of order.orderItems) {
    const activeQuantity = Math.max(0, Number(orderItem.quantity || 0) - Number(orderItem.cancelledQuantity || 0));
    const row = submitted.find(item => String(item?.orderItemId) === String(orderItem._id));
    const ids = [...new Set((row?.uniqueItemIds || orderItem.uniqueItemIds || []).map(value => cleanCode(value, 64)).filter(Boolean))];
    if (settings.requireProductQrScan && ids.length !== activeQuantity) throw new ApiError('ITEM_VERIFICATION_REQUIRED', `${orderItem.name || 'Order item'} needs ${activeQuantity} verified item ID(s).`, { statusCode: 409 });
    for (const uniqueItemId of ids) {
      const item = await InventoryItem.findOne(andFilter({ uniqueItemId }, req.tenantFilter));
      if (!item || String(item.product) !== String(orderItem.product) || (orderItem.variantId && item.variantId && String(item.variantId) !== String(orderItem.variantId)) || (item.order && String(item.order) !== String(order._id))) throw new ApiError('ITEM_MISMATCH', `${uniqueItemId} does not match ${orderItem.name || 'the expected order item'}.`, { statusCode: 409 });
      item.order = order._id; item.orderItemId = String(orderItem._id); item.status = 'PACKED'; item.packedAt = new Date(); await item.save(); expectedIds.push(uniqueItemId);
    }
    orderItem.uniqueItemIds = ids;
  }
  await require('../services/privateEvidenceService').bindToStore(evidence, order.storeId);
  if (evidence.length) await VerificationEvidence.insertMany(evidence.map(item => ({ ...item, order: order._id, phase: 'PACKING', uploadedBy: req.user._id, storeId: order.storeId })));
  order.packageVerification = { status: 'VERIFIED', sealId, securityTagId, dispatchWeightGrams: weight > 0 ? Math.round(weight) : undefined, evidenceCount: evidence.length, verifiedAt: new Date(), verifiedBy: req.user._id };
  order.revision = Number(order.revision || 0) + 1; await order.save();
  await logAudit({ req, action: 'ORDER_PACKING_VERIFIED', entityType: 'Order', entityId: order._id, storeId: order.storeId, after: { itemCount: expectedIds.length, sealAssigned: Boolean(sealId), tagAssigned: Boolean(securityTagId), dispatchWeightGrams: order.packageVerification.dispatchWeightGrams, evidenceCount: evidence.length } });
  res.json({ order, verification: order.packageVerification });
});

exports.getEvidence = asyncHandler(async (req, res) => {
  const order = await Order.findOne(andFilter({ _id: req.params.id }, req.tenantFilter));
  if (!order) throw notFound('Order not found');
  const filter = { order: order._id };
  if (req.query.returnId) filter.returnRequest = req.query.returnId;
  res.set('Cache-Control', 'private, no-store').json(require('../services/privateEvidenceService').presentEvidence(await VerificationEvidence.find(andFilter(filter, req.tenantFilter)).sort('uploadedAt').lean()));
});

exports.inspectReturn = asyncHandler(async (req, res) => {
  let request = await ReturnExchange.findOne(andFilter({ _id: req.params.id }, req.tenantFilter));
  if (!request) throw notFound('Return request not found');
  if (!['Received', 'Inspection Pending', 'Mismatch Found', 'Verified'].includes(request.status)) throw new ApiError('RETURN_TRANSITION_INVALID', 'Mark the parcel received before inspecting it.', { statusCode: 409 });
  const expectedRevision = Number(request.revision || 0);
  if (req.body?.revision !== undefined && Number(req.body.revision) !== expectedRevision) throw new ApiError('RETURN_CHANGED', 'This return changed in another session. Reload it before continuing.', { statusCode: 409 });
  const order = await Order.findOne(andFilter({ _id: request.order }, req.tenantFilter));
  if (!order) throw notFound('Order not found');
  const orderItem = order.orderItems.id?.(request.orderItemId) || order.orderItems.find(item => String(item._id) === String(request.orderItemId));
  const expectedIds = (orderItem?.uniqueItemIds || []).map(value => cleanCode(value, 64)).filter(Boolean).slice(0, Number(request.quantity || 1));
  const returnedIds = [...new Set((Array.isArray(req.body?.returnedUniqueItemIds) ? req.body.returnedUniqueItemIds : String(req.body?.returnedUniqueItemIds || '').split(/[\s,]+/)).map(value => cleanCode(value, 64)).filter(Boolean))];
  const settings = protectionSettings(await getStoreSettings(order.storeId ? { storeId: order.storeId } : req.tenantFilter || {}));
  const evidence = await require('../services/privateEvidenceService').attachments(req, req.body?.evidence || [], ['RETURN_PHOTO', 'UNBOXING_VIDEO']);
  if (settings.requireReturnPhotos && !evidence.some(item => item.type === 'RETURN_PHOTO')) throw new ApiError('VALIDATION_ERROR', 'Add the required returned-item photos.');
  if (settings.requireReturnVideo && !evidence.some(item => item.type === 'UNBOXING_VIDEO')) throw new ApiError('VALIDATION_ERROR', 'Add the required return unboxing video.');
  const sealCondition = String(req.body?.sealCondition || 'NOT_CHECKED').toUpperCase();
  const tagCondition = String(req.body?.tagCondition || 'NOT_CHECKED').toUpperCase();
  const condition = String(req.body?.condition || 'GOOD').toUpperCase();
  if (!['NOT_CHECKED', 'INTACT', 'BROKEN', 'MISSING', 'MISMATCH'].includes(sealCondition) || !['NOT_CHECKED', 'PRESENT', 'REMOVED', 'MISSING', 'MISMATCH'].includes(tagCondition) || !['UNOPENED', 'GOOD', 'USED', 'DAMAGED', 'DIFFERENT_ITEM', 'MISSING_ITEM'].includes(condition)) throw new ApiError('VALIDATION_ERROR', 'Choose valid inspection conditions.');
  const assessment = assessInspection({ expectedIds, returnedIds, expectedSeal: order.packageVerification?.sealId, returnedSeal: req.body?.returnedSealId, expectedTag: order.packageVerification?.securityTagId, returnedTag: req.body?.returnedTagId, dispatchWeight: order.packageVerification?.dispatchWeightGrams, returnWeight: req.body?.returnWeightGrams, tolerance: settings.returnWeightToleranceGrams, condition, sealCondition, tagCondition });
  const nextStatus = assessment.result === 'VERIFIED' ? 'Verified' : 'Mismatch Found';
  const inspection = { status: assessment.result === 'VERIFIED' ? 'VERIFIED' : assessment.result === 'MANUAL_REVIEW_REQUIRED' ? 'MANUAL_REVIEW' : 'MISMATCH_FOUND', expectedUniqueItemIds: expectedIds, returnedUniqueItemIds: returnedIds, dispatchWeightGrams: order.packageVerification?.dispatchWeightGrams, returnWeightGrams: Number(req.body?.returnWeightGrams) > 0 ? Math.round(Number(req.body.returnWeightGrams)) : undefined, weightDifferenceGrams: assessment.weightDifference, sealCondition, returnedSealId: cleanCode(req.body?.returnedSealId), tagCondition, returnedTagId: cleanCode(req.body?.returnedTagId), condition, flags: assessment.flags, result: assessment.result, notes: String(req.body?.notes || '').trim().slice(0, 2000), evidenceCount: evidence.length, inspectedAt: new Date(), inspectedBy: req.user._id };
  const set = { inspection, status: nextStatus };
  if (assessment.result === 'VERIFIED' && settings.autoApproveVerifiedReturns) {
    set.refundDecision = {
      decision: 'APPROVED',
      reason: 'Automatically approved after all configured item-verification checks passed.',
      customerMessage: 'Your returned item has passed verification and the refund is approved.',
      decidedAt: new Date(),
      decidedBy: req.user._id,
    };
    set['financial.approvedRefundAmount'] = Number(request.financial?.estimatedRefundAmount || 0);
  }
  const timeline = { status: nextStatus, note: assessment.result === 'VERIFIED' ? 'Returned item matched the dispatch verification record.' : 'Verification flags require staff review. No refund was processed.', source: req.storeMember ? 'SELLER' : 'ADMIN', actor: { id: String(req.user._id), name: req.user.name || 'Staff' }, date: new Date() };
  request = await ReturnExchange.findOneAndUpdate(andFilter({ _id: request._id, revision: expectedRevision, status: request.status }, req.tenantFilter), { $set: set, $inc: { revision: 1 }, $push: { statusTimeline: timeline } }, { new: true, runValidators: true });
  if (!request) throw new ApiError('RETURN_CHANGED', 'This return changed in another session. Reload it before continuing.', { statusCode: 409 });
  await require('../services/privateEvidenceService').bindToStore(evidence, request.storeId);
  if (evidence.length) await VerificationEvidence.insertMany(evidence.map(item => ({ ...item, order: order._id, returnRequest: request._id, orderItemId: request.orderItemId, phase: 'RETURN_INSPECTION', uploadedBy: req.user._id, storeId: request.storeId })));
  const itemStatus = assessment.result === 'VERIFIED' ? 'RETURN_VERIFIED' : 'RETURN_REJECTED';
  if (returnedIds.length) await InventoryItem.updateMany(andFilter({ uniqueItemId: { $in: returnedIds } }, req.tenantFilter), { $set: { status: itemStatus, returnedAt: new Date() } });
  const risk = settings.enableCustomerRiskDetection ? await refreshCustomerRisk({ storeId: request.storeId, userId: request.user }) : null;
  await logAudit({ req, action: assessment.result === 'VERIFIED' ? 'RETURN_ITEM_VERIFIED' : 'RETURN_MISMATCH_DETECTED', entityType: 'ReturnExchange', entityId: request._id, storeId: request.storeId, after: { result: assessment.result, flags: assessment.flags, weightDifferenceGrams: assessment.weightDifference, evidenceCount: evidence.length, autoApproved: request.refundDecision?.decision === 'APPROVED' } });
  res.json({ request, assessment, risk });
});

exports.decideReturn = asyncHandler(async (req, res) => {
  const decision = String(req.body?.decision || '').toUpperCase();
  if (!['APPROVED', 'PARTIAL', 'REJECTED', 'MORE_INFORMATION_REQUIRED'].includes(decision)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid refund decision.');
  let request = await ReturnExchange.findOne(andFilter({ _id: req.params.id }, req.tenantFilter));
  if (!request) throw notFound('Return request not found');
  const expectedRevision = Number(request.revision || 0);
  if (req.body?.revision !== undefined && Number(req.body.revision) !== expectedRevision) throw new ApiError('RETURN_CHANGED', 'This return changed in another session. Reload it before continuing.', { statusCode: 409 });
  if (!['VERIFIED', 'MISMATCH_FOUND', 'MANUAL_REVIEW'].includes(request.inspection?.status)) throw new ApiError('RETURN_INSPECTION_REQUIRED', 'Complete the returned-item inspection before recording the final decision.', { statusCode: 409 });
  const reason = String(req.body?.reason || '').trim().slice(0, 1000);
  if (['REJECTED', 'PARTIAL', 'MORE_INFORMATION_REQUIRED'].includes(decision) && !reason) throw new ApiError('VALIDATION_ERROR', 'Add a clear reason for this decision.');
  if (decision === 'APPROVED' && request.inspection?.status === 'MISMATCH_FOUND' && !reason) throw new ApiError('MANUAL_REVIEW_REQUIRED', 'A mismatch can only be overridden with a documented staff reason.', { statusCode: 409 });
  const customerMessage = String(req.body?.customerMessage || (decision === 'REJECTED' ? 'Your returned item could not be verified against the item originally dispatched. Our team has completed its review.' : decision === 'MORE_INFORMATION_REQUIRED' ? 'We need some additional information before completing your return review.' : 'Your return verification is complete and the refund decision has been approved.')).trim().slice(0, 1000);
  const set = { refundDecision: { decision, reason, customerMessage, decidedAt: new Date(), decidedBy: req.user._id }, adminComment: customerMessage };
  if (decision === 'PARTIAL') {
    const amount = Math.round(Number(req.body?.refundAmount) * 100) / 100;
    if (!(amount > 0) || amount > Number(request.financial?.estimatedRefundAmount || 0)) throw new ApiError('VALIDATION_ERROR', 'Enter a valid partial refund amount.');
    set['financial.approvedRefundAmount'] = amount;
  } else if (decision === 'APPROVED') set['financial.approvedRefundAmount'] = Number(request.financial?.estimatedRefundAmount || 0);
  const timeline = { status: request.status, note: customerMessage, source: req.storeMember ? 'SELLER' : 'ADMIN', actor: { id: String(req.user._id), name: req.user.name || 'Staff' }, date: new Date() };
  request = await ReturnExchange.findOneAndUpdate(andFilter({ _id: request._id, revision: expectedRevision, status: request.status }, req.tenantFilter), { $set: set, $inc: { revision: 1 }, $push: { statusTimeline: timeline } }, { new: true, runValidators: true });
  if (!request) throw new ApiError('RETURN_CHANGED', 'This return changed in another session. Reload it before continuing.', { statusCode: 409 });
  await logAudit({ req, action: `RETURN_DECISION_${decision}`, entityType: 'ReturnExchange', entityId: request._id, storeId: request.storeId, after: { decision, approvedRefundAmount: request.financial?.approvedRefundAmount, reason }, summary: reason || customerMessage });
  res.json(request);
});

exports.getCustomerRisk = asyncHandler(async (req, res) => {
  const userId = String(req.params.userId || '');
  const risk = await refreshCustomerRisk({ storeId: req.store?._id, userId });
  res.set('Cache-Control', 'private, no-store').json(risk || { status: 'LOW', score: 0, counters: {} });
});

