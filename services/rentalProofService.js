const crypto = require('node:crypto');
const sharp = require('sharp');
const M = require('../models/Rental');
const A = require('./rentalAlgorithms');
const { ApiError } = require('../utils/apiError');
const error = message => { throw new ApiError('VALIDATION_ERROR', message); };
function stage(value) { if (!['HANDOVER', 'RETURN'].includes(value)) error('Choose handover or return evidence.'); return value; }
function allowed(b, phase) { return phase === 'HANDOVER' ? ['CONFIRMED', 'PREPARING', 'READY'].includes(b.status) : b.status === 'OUT'; }
function ids(b, values) {
  if (!Array.isArray(values) || !values.length || values.length > b.allocations.length || new Set(values).size !== values.length || values.some(id => !b.allocations.some(a => String(a.assetId) === String(id)))) error('Choose physical pieces from this booking.');
  return values.map(String).sort();
}
async function rows(b, session) { return M.Proof.find({ storeId: b.storeId, bookingId: b._id, withdrawnAt: null }).select('-bytes').session(session || null).sort('_id').lean(); }
function fingerprint(b, phase, assetIds, evidence) {
  return crypto.createHash('sha256').update(JSON.stringify({ phase, assetIds, pieces: b.allocations.filter(a => assetIds.includes(String(a.assetId))).map(a => [String(a.assetId), a.code]), photos: evidence.filter(p => p.stage === phase && assetIds.includes(String(p.assetId))).map(p => [String(p._id), p.digest]), pickupAt: b.schedule.pickupAt, returnDueAt: b.schedule.returnDueAt, total: b.quote.totalPaise, policyRevision: b.policyRevision })).digest('hex');
}
async function upload(store, bookingId, input, files, actorId) {
  stage(input.stage); A.id(input.assetId);
  if (input.consent !== 'true') error('Record customer consent before storing condition photos.');
  if (!Array.isArray(files) || !files.length || files.length > 4) error('Upload 1–4 condition photos for this piece.');
  const images = [];
  for (const file of files) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) error('Use JPEG, PNG or WebP condition photos.');
    if (!Buffer.isBuffer(file.buffer) || file.buffer.length > 1024 * 1024) error('Each uploaded photo must be below 1 MB.');
    let bytes;
    try {
      const processor = sharp(file.buffer, { limitInputPixels: 20000000 });
      const metadata = await processor.metadata();
      if (!['jpeg', 'png', 'webp'].includes(metadata.format) || (metadata.pages || 1) > 1) error('Use a single JPEG, PNG or WebP photo, not SVG or animation.');
      bytes = await processor.rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).webp({ quality: 75 }).toBuffer();
    }
    catch { error('One condition photo is invalid.'); }
    if (bytes.length > 1024 * 1024) error('Compress the condition photo below 1 MB.');
    images.push({ bytes, mimeType: 'image/webp', digest: crypto.createHash('sha256').update(bytes).digest('hex') });
  }
  const S = require('./rentalService');
  return S.transaction(store, async session => {
    const b = await S.getBooking(store, bookingId, session);
    if (b.revision !== Number(input.revision) || !allowed(b, input.stage)) error('Reload the booking; condition photos are not editable in this state.');
    ids(b, [input.assetId]);
    const allocation = b.allocations.find(a => String(a.assetId) === input.assetId);
    if (input.stage === 'RETURN' && (allocation.receivedAt || allocation.lostAt)) error('This piece has already been received or declared lost; its return evidence is locked.');
    const current = await rows(b, session);
    const relevant = current.filter(p => p.stage === input.stage && String(p.assetId) === input.assetId);
    const fresh = images.filter((p, i) => !relevant.some(r => r.digest === p.digest) && images.findIndex(r => r.digest === p.digest) === i);
    const historicalCount = await M.Proof.countDocuments({ storeId: store._id, bookingId: b._id }).session(session);
    if (relevant.length + fresh.length > 4 || current.length + fresh.length > 100 || historicalCount + fresh.length > 200) error('Evidence limit: 4 active photos per piece/stage, 100 active per booking, 200 including corrections.');
    if (fresh.length) {
      await M.Proof.insertMany(fresh.map(p => ({ ...p, storeId: store._id, bookingId: b._id, assetId: input.assetId, stage: input.stage, uploadedBy: actorId, consentRecordedAt: new Date() })), { session });
      b.events.push({ type: 'CONDITION_PHOTOS', note: `${input.stage}: condition evidence stored privately.`, actorId, at: new Date() });
      b.revision += 1; await b.save({ session });
    }
    return { booking: S.present(b), photos: await rows(b, session) };
  });
}
async function acknowledge(store, bookingId, input, user) {
  const S = require('./rentalService');
  stage(input.stage); A.operation(input.operationId);
  if (!user?.isPhoneVerified || user.offlineSession || input.accepted !== true) error('Sign in with your verified phone and explicitly acknowledge the piece condition.');
  return S.transaction(store, async session => {
    const b = await S.getBooking(store, bookingId, session, user._id);
    if (b.acknowledgements.some(a => a.operationId === input.operationId)) return S.present(b, { staff: false });
    if (b.revision !== input.revision || !allowed(b, input.stage)) error('Booking changed. Review the latest pieces and evidence.');
    const assetIds = ids(b, input.assetIds), photos = await rows(b, session);
    if (input.stage === 'RETURN' && b.allocations.some(a => assetIds.includes(String(a.assetId)) && (a.receivedAt || a.lostAt))) error('Acknowledge only pieces currently awaiting return.');
    const currentFingerprint = fingerprint(b, input.stage, assetIds, photos);
    if (b.acknowledgements.some(a => a.stage === input.stage && a.fingerprint === currentFingerprint)) return S.present(b, { staff: false });
    if (b.acknowledgements.length >= 200) error('Acknowledgement history needs owner review before another revision.');
    if (b.policy.requireConditionPhotos && assetIds.some(id => !photos.some(p => p.stage === input.stage && String(p.assetId) === id))) error('The store must upload condition photos for every selected piece first.');
    b.acknowledgements.push({ operationId: input.operationId, stage: input.stage, assetIds, userId: user._id, phone: user.phone, at: new Date(), fingerprint: fingerprint(b, input.stage, assetIds, photos), note: A.text(input.note || 'Piece checklist and condition acknowledged.', 1000) });
    b.revision += 1; await b.save({ session });
    return S.present(b, { staff: false });
  });
}
async function ensure(b, phase, assetIds, session) {
  const selected = ids(b, assetIds), photos = await rows(b, session);
  if (b.policy.requireConditionPhotos && selected.some(id => !photos.some(p => p.stage === phase && String(p.assetId) === id))) error('Upload condition photos for every selected piece before continuing.');
  if (b.policy.requireCustomerAcknowledgement && !b.acknowledgements.some(a => a.stage === phase && selected.every(id => a.assetIds?.includes(id)) && a.fingerprint === fingerprint(b, phase, a.assetIds, photos))) error('Ask the customer to acknowledge the current piece checklist/photos in My rentals before continuing.');
}
async function list(store, bookingId, userId) {
  const b = await require('./rentalService').getBooking(store, bookingId, null, userId);
  return { photos: (await rows(b)).map(({ digest, uploadedBy, ...p }) => p), pieces: b.allocations.map(a => ({ assetId: String(a.assetId), code: a.code, label: a.label, receivedAt: a.receivedAt, lostAt: a.lostAt })) };
}
async function photo(store, bookingId, photoId, userId) {
  await require('./rentalService').getBooking(store, bookingId, null, userId);
  const image = await M.Proof.findOne({ _id: A.id(photoId), storeId: store._id, bookingId: A.id(bookingId), withdrawnAt: null }).select('+bytes').lean();
  if (!image?.bytes) throw new ApiError('NOT_FOUND', 'Condition photo not found.');
  const bytes = Buffer.isBuffer(image.bytes) ? image.bytes : Buffer.from(image.bytes.buffer);
  return { mimeType: image.mimeType, base64: bytes.toString('base64') };
}
async function withdraw(store, bookingId, photoId, input, actorId) {
  const S = require('./rentalService');
  const reason = A.text(input.note || '', 1000); if (!reason) error('Record why this photo needs correction.');
  return S.transaction(store, async session => {
    const b = await S.getBooking(store, bookingId, session);
    const row = await M.Proof.findOne({ _id: A.id(photoId), storeId: store._id, bookingId: b._id, withdrawnAt: null }).session(session);
    if (!row) throw new ApiError('NOT_FOUND', 'Active condition photo not found.');
    const piece = b.allocations.find(a => String(a.assetId) === String(row.assetId));
    if (b.revision !== input.revision || !allowed(b, row.stage) || !piece || (row.stage === 'RETURN' && (piece.receivedAt || piece.lostAt))) error('Evidence is locked after its physical handover/return. Reload before correcting it.');
    row.withdrawnAt = new Date(); row.withdrawnBy = actorId; row.withdrawnReason = reason; await row.save({ session });
    b.events.push({ type: 'CONDITION_PHOTO_WITHDRAWN', note: reason, actorId, at: new Date() }); b.revision += 1; await b.save({ session });
    return { booking: S.present(b), photos: await rows(b, session) };
  });
}
module.exports = { upload, acknowledge, ensure, list, photo, fingerprint, withdraw };
