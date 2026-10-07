const crypto = require('node:crypto');
const Order = require('../models/Order');
const ReturnExchange = require('../models/ReturnExchange');
const CustomerRisk = require('../models/CustomerRisk');

const cleanCode = (value, max = 80) => String(value || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, max);

function generateCode(prefix, hint = '') {
  const safeHint = cleanCode(hint, 8).replace(/^-+|-+$/g, '');
  const token = crypto.randomInt(100000, 999999);
  return [prefix, safeHint, token].filter(Boolean).join('-');
}

function protectionSettings(settings = {}) {
  return {
    requireProductQrScan: Boolean(settings.requireProductQrScan),
    requirePackingPhotos: Boolean(settings.requirePackingPhotos),
    requirePackingVideo: Boolean(settings.requirePackingVideo),
    requireDispatchWeight: Boolean(settings.requireDispatchWeight),
    requireSecuritySeal: Boolean(settings.requireSecuritySeal),
    requireReturnPhotos: Boolean(settings.requireReturnPhotos),
    requireReturnVideo: Boolean(settings.requireReturnVideo),
    enableSecurityTag: Boolean(settings.enableSecurityTag),
    enableCustomerRiskDetection: settings.enableCustomerRiskDetection !== false,
    autoApproveVerifiedReturns: Boolean(settings.autoApproveVerifiedReturns),
    returnWeightToleranceGrams: Math.max(0, Number(settings.returnWeightToleranceGrams ?? 100)),
    highValueVerificationThreshold: Math.max(0, Number(settings.highValueVerificationThreshold ?? 5000)),
  };
}

function requiresPackingVerification(snapshot = {}, finalAmount = 0) {
  return Boolean(snapshot.requireProductQrScan || snapshot.requirePackingPhotos || snapshot.requirePackingVideo
    || snapshot.requireSecuritySeal || snapshot.enableSecurityTag || snapshot.requireDispatchWeight
    || (Number(snapshot.highValueThreshold || 0) > 0 && Number(finalAmount || 0) >= Number(snapshot.highValueThreshold)));
}

function snapshotForOrder(settings = {}, finalAmount = 0) {
  const normalized = protectionSettings(settings);
  const snapshot = {
    capturedAt: new Date(), requireProductQrScan: normalized.requireProductQrScan, requirePackingPhotos: normalized.requirePackingPhotos,
    requirePackingVideo: normalized.requirePackingVideo, requireDispatchWeight: normalized.requireDispatchWeight,
    requireSecuritySeal: normalized.requireSecuritySeal, enableSecurityTag: normalized.enableSecurityTag,
    highValueThreshold: normalized.highValueVerificationThreshold,
  };
  return { ...snapshot, packageStatus: requiresPackingVerification(snapshot, finalAmount) ? 'PENDING' : 'NOT_REQUIRED' };
}

function assessInspection({ expectedIds = [], returnedIds = [], expectedSeal = '', returnedSeal = '', expectedTag = '', returnedTag = '', dispatchWeight, returnWeight, tolerance = 100, condition, sealCondition, tagCondition }) {
  const expected = [...new Set(expectedIds.map(value => cleanCode(value, 64)).filter(Boolean))].sort();
  const returned = [...new Set(returnedIds.map(value => cleanCode(value, 64)).filter(Boolean))].sort();
  const flags = [];
  const idsMatch = expected.length > 0 && expected.length === returned.length && expected.every((value, index) => value === returned[index]);
  if (expected.length && !idsMatch) flags.push('ITEM_ID_MISMATCH');
  if (expectedSeal && (cleanCode(returnedSeal) !== cleanCode(expectedSeal) || ['BROKEN', 'MISSING', 'MISMATCH'].includes(sealCondition))) flags.push('SECURITY_SEAL_ISSUE');
  if (expectedTag && (cleanCode(returnedTag) !== cleanCode(expectedTag) || ['REMOVED', 'MISSING', 'MISMATCH'].includes(tagCondition))) flags.push('SECURITY_TAG_ISSUE');
  const weightDifference = Number.isFinite(Number(dispatchWeight)) && Number.isFinite(Number(returnWeight)) ? Math.round(Number(returnWeight) - Number(dispatchWeight)) : null;
  if (weightDifference !== null && Math.abs(weightDifference) > Number(tolerance || 0)) flags.push('WEIGHT_MISMATCH');
  if (['DIFFERENT_ITEM', 'MISSING_ITEM'].includes(condition)) flags.push('PRODUCT_CONDITION_MISMATCH');
  let result = 'VERIFIED';
  if (flags.some(flag => ['ITEM_ID_MISMATCH', 'PRODUCT_CONDITION_MISMATCH'].includes(flag))) result = 'POSSIBLE_PRODUCT_SWAP';
  else if (flags.includes('SECURITY_TAG_ISSUE') || flags.includes('SECURITY_SEAL_ISSUE')) result = 'SECURITY_TAG_ISSUE';
  else if (flags.includes('WEIGHT_MISMATCH')) result = 'WEIGHT_DIFFERENCE';
  if (!expected.length || !returned.length) { flags.push('LEGACY_OR_MISSING_ITEM_ID'); result = 'MANUAL_REVIEW_REQUIRED'; }
  return { flags: [...new Set(flags)], result, weightDifference, idsMatch };
}

async function refreshCustomerRisk({ storeId, userId }) {
  if (!userId) return null;
  const storeFilter = storeId ? { storeId } : { storeId: { $exists: false } };
  const [totalOrders, successfulOrders, cancelledOrders, returns, rejectedReturns, productMismatchReturns, codRefusals] = await Promise.all([
    Order.countDocuments({ ...storeFilter, user: userId }),
    Order.countDocuments({ ...storeFilter, user: userId, orderStatus: { $in: ['Delivered', 'Returned', 'Refunded'] } }),
    Order.countDocuments({ ...storeFilter, user: userId, orderStatus: 'Cancelled' }),
    ReturnExchange.countDocuments({ ...storeFilter, user: userId }),
    ReturnExchange.countDocuments({ ...storeFilter, user: userId, $or: [{ status: 'Rejected' }, { 'refundDecision.decision': 'REJECTED' }] }),
    ReturnExchange.countDocuments({ ...storeFilter, user: userId, 'inspection.flags': { $in: ['ITEM_ID_MISMATCH', 'PRODUCT_CONDITION_MISMATCH'] } }),
    Order.countDocuments({ ...storeFilter, user: userId, paymentMethod: 'COD', 'rto.status': { $nin: ['NONE', null] } }),
  ]);
  const score = Math.min(100, rejectedReturns * 12 + productMismatchReturns * 35 + codRefusals * 15 + (returns >= 4 ? 10 : 0));
  const reasons = [];
  if (productMismatchReturns) reasons.push(`${productMismatchReturns} item verification mismatch case(s)`);
  if (rejectedReturns >= 2) reasons.push(`${rejectedReturns} rejected return(s)`);
  if (codRefusals >= 2) reasons.push(`${codRefusals} COD return-to-origin case(s)`);
  const status = productMismatchReturns >= 2 || score >= 70 ? 'MANUAL_REVIEW' : score >= 45 ? 'HIGH' : score >= 20 ? 'MEDIUM' : 'LOW';
  return CustomerRisk.findOneAndUpdate({ ...storeFilter, user: userId }, {
    $set: { counters: { totalOrders, successfulOrders, cancelledOrders, returns, rejectedReturns, productMismatchReturns, codRefusals }, score, status, reasons, lastCalculatedAt: new Date() },
    $setOnInsert: { storeId: storeId || undefined, user: userId },
  }, { new: true, upsert: true, setDefaultsOnInsert: true });
}

module.exports = { assessInspection, cleanCode, generateCode, protectionSettings, refreshCustomerRisk, requiresPackingVerification, snapshotForOrder };

