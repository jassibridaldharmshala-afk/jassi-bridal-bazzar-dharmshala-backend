const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { startTestEnvironment, stopTestEnvironment, resetDatabase, request, getBaseUrl } = require('./helpers');
const { createCustomer, createAdmin, createProduct, setSettings, validAddress } = require('./factories');
const { ensureDefaultStore } = require('../services/storeService');
const Product = require('../models/Product');
const Store = require('../models/Store');
const M = require('../models/Rental');
const S = require('../services/rentalService');
const A = require('../services/rentalAlgorithms');
const P = require('../services/rentalProofService');
const C = require('../services/rentalCourierService');
const convert = require('../services/rentalAssetConversionService').convert;
const op = () => `enhancement_${crypto.randomUUID()}`;
let store, customer, admin, product, listing, asset;
const dates = (offset = 3) => {
  const key = new Date(Date.now() + offset * A.DAY).toISOString().slice(0, 10);
  const pickupAt = `${key}T10:00:00+05:30`;
  return { pickupAt, returnDueAt: new Date(+new Date(pickupAt) + 2 * A.DAY).toISOString() };
};
before(startTestEnvironment); after(stopTestEnvironment);
beforeEach(async () => {
  await resetDatabase(); store = await ensureDefaultStore(); customer = await createCustomer(); admin = await createAdmin();
  product = await createProduct({ storeId: store._id, commerceMode: 'SALE_AND_RENTAL' });
  await S.saveConfiguration(store, { revision: 0, mode: 'SALE_AND_RENTAL', policy: { ...A.DEFAULT_POLICY } });
  listing = await S.saveListing(store, { productId: String(product._id), title: 'Rental outfit', active: true, dailyRatePaise: 100000, depositPaise: 500000, requirements: [{ poolKey: 'outfit', label: 'Outfit', quantity: 1 }] });
  asset = await S.saveAsset(store, { poolKey: 'outfit', code: 'OUTFIT-001', label: 'Outfit' });
});
async function policy(changes) { const current = await S.readConfiguration(store); return S.saveConfiguration(store, { ...current, policy: { ...current.policy, ...changes } }); }
async function hold(extra = {}, counter = false) {
  const config = await S.readConfiguration(store), payload = { ...dates(), items: [{ listingId: String(listing._id), quantity: 1 }], attemptId: op(), acceptTerms: true, policyRevision: config.revision, ...extra };
  const quote = await S.publicQuote(store, payload, { counter });
  return S.hold(store, { ...payload, quoteFingerprint: quote.quoteFingerprint }, counter ? admin.user : customer.user, { counter });
}
async function collect(b, amountPaise = b.quote.totalPaise) { return S.recordCollection(store, b._id, { operationId: op(), revision: b.revision, amountPaise, method: 'CASH', reference: op() }, admin.user._id); }
async function action(b, action, input = {}) { return S.mutateBooking(store, b._id, { operationId: op(), revision: b.revision, action, ...input }, admin.user._id); }
async function ready(b) { return action(await action(b, 'PREPARE'), 'READY'); }
async function dispatch(b) {
  await M.Booking.updateOne({ _id: b._id }, { $set: { 'schedule.pickupAt': new Date(Date.now() - 60000), 'schedule.returnDueAt': new Date(Date.now() + 2 * A.DAY) } });
  b = await S.getBooking(store, b._id);
  return action(b, 'HANDOVER', { assetIds: b.allocations.map(a => String(a.assetId)), note: 'Physical checklist verified.' });
}
async function upload(b, stage = 'HANDOVER', colour = '#ff0000', pieceId = asset._id) {
  const buffer = await sharp({ create: { width: 30, height: 30, channels: 3, background: colour } }).png().toBuffer();
  return P.upload(store, b._id, { stage, assetId: String(pieceId), revision: String(b.revision), consent: 'true' }, [{ mimetype: 'image/png', buffer }], admin.user._id);
}
function carrierMocks(t, overrides = {}) {
  const adapter = require('../services/blueDartProvider');
  const methods = { readiness: () => ({ mode: 'test', liveBooking: true, reverse: true, trackingLookup: true }), serviceability: async () => ({ service: { productCode: 'A' }, pickupArea: 'JAI' }), book: async () => ({ awb: '12345678901', labelPdf: Buffer.from('%PDF-test-label') }), pickup: async () => ({ token: '12345' }), cancel: async () => ({}), track: async () => ({ awb: '12345678901', status: 'IN_TRANSIT', providerStatus: 'In transit' }), ...overrides };
  return Object.fromEntries(Object.entries(methods).map(([key, value]) => [key, t.mock.method(adapter, key, value)]));
}
async function courierReady() {
  await policy({ courierIntegrationEnabled: true, deliveryModes: ['STORE_PICKUP', 'COURIER'] });
  await setSettings({ storeId: store._id, shippingProvider: 'bluedart', shippingPickup: validAddress({ fullName: 'Rental store' }) });
  return ready(await collect(await hold({ deliveryMode: 'COURIER', address: 'Customer address' })));
}
function courierInput(b, extra = {}) { const at = b.status === 'OUT' ? new Date(Date.now() + A.DAY) : new Date(+new Date(b.schedule.pickupAt) - 2 * A.HOUR); return { operationId: op(), revision: b.revision, declaredValuePaise: 1000000, address: validAddress(), date: A.localKey(at, 'Asia/Kolkata'), time: '08:00', closeTime: '18:00', ...extra }; }

test('owner fixed advance and pickup deposit require real money, with original bookings unchanged', async () => {
  const old = await hold();
  await policy({ advanceMode: 'FIXED', advanceAmountPaise: 25000, depositTiming: 'PICKUP' });
  assert.equal((await S.getBooking(store, old._id)).quote.dueNowPaise, 560000);
  await action(old, 'CANCEL', { note: 'Free dates', ownerFault: true });
  let b = await hold(); assert.equal(b.status, 'HELD'); assert.equal(b.quote.dueNowPaise, 25000); assert.equal(b.quote.depositDueNowPaise, 0);
  b = await collect(b, 24999); assert.equal(b.status, 'HELD');
  b = await collect(b, 1); assert.equal(b.status, 'CONFIRMED'); assert.equal(b.financial.depositHeldPaise, 0);
  b = await ready(b); await assert.rejects(() => action(b, 'HANDOVER', { assetIds: [String(asset._id)], note: 'Unpaid balance' }), /full rent\/deposit/);
});
test('counter rentals cannot bypass mandatory advance or required verified acknowledgement', async () => {
  await policy({ requireCustomerAcknowledgement: true });
  await assert.rejects(() => hold({ customer: { name: 'Unregistered', phone: '9876543210' } }, true), /register\/verify/);
  let b = await hold({ customer: { name: customer.user.name, phone: customer.user.phone } }, true);
  assert.equal(b.status, 'HELD'); assert.equal(String(b.userId), String(customer.user._id));
  b = await collect(b, b.quote.dueNowPaise); assert.equal(b.status, 'CONFIRMED');
});
test('sale-only or scheduled products cannot be rented and captured money remains refundable if product disabled', async () => {
  const b = await hold();
  await Product.updateOne({ _id: product._id }, { $set: { commerceMode: 'SALE_ONLY' } });
  await assert.rejects(() => S.saveListing(store, { ...listing, active: true }), /Enable rental availability/);
  assert.equal((await S.catalogue(store)).rows.length, 0); await assert.rejects(() => hold(), /unavailable/);
  const paid = await collect(b, b.quote.dueNowPaise); assert.equal(paid.status, 'EXPIRED'); assert.equal(paid.financial.refundablePaise, b.quote.dueNowPaise);
  await Product.updateOne({ _id: product._id }, { $set: { commerceMode: 'SALE_AND_RENTAL', publishAt: new Date(Date.now() + A.DAY) } });
  assert.equal((await S.catalogue(store)).rows.length, 0); await assert.rejects(() => hold(), /unavailable/);
});
test('new offers reject wrong product/size pieces and unsafe multi-component mappings', async () => {
  listing = await S.saveListing(store, { ...listing, size: 'M' });
  asset = await S.saveAsset(store, { ...asset, size: 'L' });
  await assert.rejects(() => hold(), /unavailable/);
  asset = await S.saveAsset(store, { ...asset, size: 'M' });
  const b = await hold(); assert.equal(String(b.allocations[0].assetId), String(asset._id));
  await assert.rejects(() => S.saveAsset(store, { ...asset, size: 'L' }), /reserved/i);
  await assert.rejects(() => S.saveListing(store, { ...listing, requirements: [{ poolKey: 'outfit', label: 'Outfit', quantity: 1 }, { poolKey: 'jewel', label: 'Necklace', quantity: 1 }] }), /every component/);
});
test('piece replacement enforces accepted mapping even if the offer has since changed', async () => {
  listing = await S.saveListing(store, { ...listing, size: 'M' }); asset = await S.saveAsset(store, { ...asset, size: 'M' });
  const wrong = await S.saveAsset(store, { productId: String(product._id), poolKey: 'outfit', size: 'L', code: 'OUTFIT-L', label: 'L outfit' });
  let b = await collect(await hold()); listing = await S.saveListing(store, { ...listing, size: 'L' });
  await assert.rejects(() => S.replacePiece(store, b._id, { revision: b.revision, operationId: op(), assetId: String(asset._id), replacementId: String(wrong._id), customerAcknowledged: true, note: 'Wrong size' }), /accepted product\/variant\/size/);
});
test('trial appointments before the rental period appear in the scoped calendar', async () => {
  let b = await collect(await hold({ ...dates(7) })); const trialAt = dates(3).pickupAt;
  b = await action(b, 'TRIAL', { at: trialAt, measurements: 'Private measurement', note: 'Fitting' });
  const range = { from: new Date(+new Date(trialAt) - A.HOUR).toISOString(), to: new Date(+new Date(trialAt) + A.HOUR).toISOString() };
  assert.equal((await S.listBookings(store, range)).rows[0].number, b.number);
  const other = await Store.create({ name: 'Other', slug: 'other' }); assert.equal((await S.listBookings(other, range)).total, 0);
});
test('stock transfer is reservation-safe, exact and idempotent; a sold code cannot be restored', async () => {
  const b = await hold(), input = { operationId: op(), revision: asset.revision, confirmTransfer: true, note: 'Move to sale' };
  await assert.rejects(() => convert(store, asset._id, input, admin.user._id), /reservations/);
  await action(b, 'CANCEL', { ownerFault: true, note: 'Release stock' });
  const changed = await convert(store, asset._id, input, admin.user._id); assert.equal(changed.status, 'RETIRED');
  await convert(store, asset._id, input, admin.user._id); assert.equal((await Product.findById(product._id)).stock, product.stock + 1);
  await assert.rejects(() => S.changeAsset(store, asset._id, { revision: changed.revision, operationId: op(), status: 'READY', note: 'Try restore' }), /sale|retired|transfer/i);
  await assert.rejects(() => S.saveAsset(store, { ...changed, code: 'RESTORED' }), /sale|transfer/i);
});
test('rental-only store and wrong variant cannot increase sale stock', async () => {
  await S.saveConfiguration(store, { ...(await S.readConfiguration(store)), mode: 'RENTAL_ONLY' });
  await assert.rejects(() => convert(store, asset._id, { operationId: op(), revision: asset.revision, confirmTransfer: true, note: 'Convert' }), /Enable sale operations/);
  assert.equal((await Product.findById(product._id)).stock, product.stock);
});
test('proof photos are private, normalized, tenant-scoped and bound to fresh verified acknowledgement', async () => {
  await policy({ requireConditionPhotos: true, requireCustomerAcknowledgement: true });
  let b = await ready(await collect(await hold()));
  await assert.rejects(async () => P.ensure(await S.getBooking(store, b._id), 'HANDOVER', [String(asset._id)]), /photos/);
  const uploaded = await upload(b); b = uploaded.booking;
  const metadata = await P.list(store, b._id, customer.user._id); assert.equal(metadata.photos.length, 1); assert.ok(!metadata.photos[0].bytes); assert.ok(!metadata.photos[0].digest);
  const photo = await P.photo(store, b._id, metadata.photos[0]._id, customer.user._id); assert.equal(photo.mimeType, 'image/webp'); assert.equal((await sharp(Buffer.from(photo.base64, 'base64')).metadata()).format, 'webp');
  const foreign = await createCustomer(); await assert.rejects(() => P.photo(store, b._id, metadata.photos[0]._id, foreign.user._id));
  await assert.rejects(() => P.acknowledge(store, b._id, { operationId: op(), revision: b.revision, stage: 'HANDOVER', accepted: true, assetIds: [String(asset._id)] }, { ...customer.user.toObject(), isPhoneVerified: false }), /verified/);
  b = await P.acknowledge(store, b._id, { operationId: op(), revision: b.revision, stage: 'HANDOVER', accepted: true, assetIds: [String(asset._id)] }, customer.user);
  await P.ensure(await S.getBooking(store, b._id), 'HANDOVER', [String(asset._id)]);
  b = (await upload(b, 'HANDOVER', '#0000ff')).booking;
  await assert.rejects(async () => P.ensure(await S.getBooking(store, b._id), 'HANDOVER', [String(asset._id)]), /acknowledge/);
  assert.equal((await request(`/api/rentals/bookings/${b._id}/proofs`, { token: foreign.token })).status, 404);
});
test('condition uploads reject missing consent, spoofed SVG and excessive source size', async () => {
  const b = await ready(await collect(await hold()));
  const input = { stage: 'HANDOVER', assetId: String(asset._id), revision: b.revision, consent: 'true' };
  await assert.rejects(() => P.upload(store, b._id, { ...input, consent: 'false' }, []), /consent/);
  await assert.rejects(() => P.upload(store, b._id, input, [{ mimetype: 'image/jpeg', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>') }]), /invalid/);
  await assert.rejects(() => P.upload(store, b._id, input, [{ mimetype: 'image/png', buffer: Buffer.alloc(1024 * 1024 + 1) }]), /1 MB/);
});
test('no-show cannot retain the deposit or run before owner grace period', async () => {
  let b = await collect(await hold(), 560000);
  await assert.rejects(() => action(b, 'NO_SHOW', { note: 'Absent' }), /grace period/);
  await M.Booking.updateOne({ _id: b._id }, { $set: { 'schedule.pickupAt': new Date(Date.now() - 2 * A.DAY) } }); b = await S.getBooking(store, b._id);
  b = await action(b, 'NO_SHOW', { note: 'Customer absent after grace' }); assert.equal(b.status, 'CANCELLED'); assert.equal(b.adjustedRentalPaise, 60000); assert.equal(b.financial.refundablePaise, 500000);
  assert.equal(await M.Reservation.countDocuments({ bookingId: b._id, active: true }), 0);
});
test('actual-day early return reduces rent without changing agreed quote or automatically restocking', async () => {
  await policy({ earlyReturnPolicy: 'ACTUAL_DAYS' });
  let b = await dispatch(await ready(await collect(await hold())));
  b = await action(b, 'RECEIVE', { assetIds: [String(asset._id)] }); assert.equal(b.status, 'RETURNED'); assert.equal(b.adjustedRentalPaise, 100000); assert.equal(b.quote.rentalPaise, 200000); assert.equal(b.acceptedQuote.rentalPaise, 200000); assert.equal(b.financial.refundablePaise, 600000);
  assert.equal((await M.Asset.findById(asset._id)).status, 'INSPECTION'); assert.equal((await Product.findById(product._id)).stock, 10);
});
test('rental documents have stable numbers, separate deposits and owner tax snapshots', async () => {
  await policy({ rentalTaxBasisPoints: 1800, rentalServiceCode: 'OWNER-CODE' });
  let b = await hold(); const proforma = b.documents.invoice.number;
  b = await collect(b, b.quote.dueNowPaise); assert.notEqual(b.documents.invoice.number, proforma); assert.equal(b.documents.invoice.taxPaise, 30508); assert.equal(b.documents.invoice.depositPaise, 500000);
  const old = b.documents; await policy({ rentalTaxBasisPoints: 500 });
  const reloaded = S.present(await S.getBooking(store, b._id)); assert.equal(reloaded.documents.invoice.basisPoints, 1800); assert.equal(reloaded.documents.receipts[0].number, old.receipts[0].number);
});
test('connected courier book is idempotent, protected from manual overwrite and cannot restock pieces', async t => {
  const mocks = carrierMocks(t); let b = await courierReady(); const input = courierInput(b);
  const row = await C.operate(store, b._id, 'outbound', 'book', input, admin.user._id); assert.equal(row.awb, '12345678901'); assert.ok(!row.labelPdf); assert.ok(!row.destination);
  await C.operate(store, b._id, 'outbound', 'book', input, admin.user._id); assert.equal(mocks.book.mock.callCount(), 1);
  b = S.present(await S.getBooking(store, b._id)); assert.equal(b.status, 'READY'); assert.equal(b.logistics.outbound.integrated, true);
  await assert.rejects(() => action(b, 'LOGISTICS', { direction: 'outbound', mode: 'COURIER', scheduledAt: dates().pickupAt }), /Cancel\/reconcile/);
  await assert.rejects(() => action(b, 'CANCEL', { note: 'Do not duplicate parcel' }), /Cancel\/reconcile/);
  const label = await C.label(store, b._id, 'outbound'); assert.equal(Buffer.from(label.base64, 'base64').toString(), '%PDF-test-label');
  assert.equal((await M.Asset.findById(asset._id)).status, 'READY');
});
test('unknown courier booking is review-only and interrupted requests never automatically repeat', async t => {
  const mocks = carrierMocks(t, { book: async () => { throw new Error('Response lost'); } }); const b = await courierReady();
  await assert.rejects(() => C.operate(store, b._id, 'outbound', 'book', courierInput(b)), /No automatic duplicate/);
  await assert.rejects(() => C.operate(store, b._id, 'outbound', 'book', courierInput(b)), /uncertain/); assert.equal(mocks.book.mock.callCount(), 1);
  let row = await M.Courier.findOne({ bookingId: b._id }); assert.equal(row.status, 'REVIEW');
  await C.operate(store, b._id, 'outbound', 'reconcile', courierInput(b, { confirmNotCreated: true, note: 'Checked carrier dashboard: no order' }));
  row = await M.Courier.findOne({ bookingId: b._id }); assert.equal(row.status, 'FAILED');
  row.operation = 'pickup'; row.operationStartedAt = new Date(Date.now() - 10 * 60000); await row.save();
  await C.recoverInterrupted(store); row = await M.Courier.findById(row._id); assert.equal(row.operation, ''); assert.equal(row.uncertainOperation, 'pickup'); assert.equal(row.status, 'REVIEW');
});
test('uncertain pickup cannot be blindly retried even after tracking succeeds', async t => {
  const mocks = carrierMocks(t, { pickup: async () => { throw new Error('Response lost'); } }); let b = await courierReady();
  await C.operate(store, b._id, 'outbound', 'book', courierInput(b)); b = await S.getBooking(store, b._id);
  await assert.rejects(() => C.operate(store, b._id, 'outbound', 'pickup', courierInput(b)), /No automatic duplicate/);
  let row = await C.operate(store, b._id, 'outbound', 'sync', courierInput(b)); assert.equal(row.status, 'REVIEW'); b = await S.getBooking(store, b._id);
  await assert.rejects(() => C.operate(store, b._id, 'outbound', 'pickup', courierInput(b)), /uncertain/); assert.equal(mocks.pickup.mock.callCount(), 1);
  row = await C.operate(store, b._id, 'outbound', 'reconcile', courierInput(b, { pickupToken: '98765', note: 'Verified token in carrier dashboard' })); assert.equal(row.pickup.token, '98765'); assert.equal(row.status, 'IN_TRANSIT');
});
test('reverse courier tracking never receives stock and cross-store access is denied', async t => {
  carrierMocks(t); let b = await dispatch(await courierReady());
  await C.operate(store, b._id, 'inbound', 'book', courierInput(b)); b = await S.getBooking(store, b._id);
  const row = await C.operate(store, b._id, 'inbound', 'sync', courierInput(b)); assert.equal(row.status, 'IN_TRANSIT');
  assert.equal((await M.Booking.findById(b._id)).status, 'OUT'); assert.equal((await M.Asset.findById(asset._id)).status, 'OUT');
  const other = await Store.create({ name: 'Other courier shop', slug: 'other-courier' }); await assert.rejects(() => C.list(other, b._id)); await assert.rejects(() => C.label(other, b._id, 'inbound'));
});
test('real multipart proof endpoint preserves fields and denies customer uploads', async () => {
  const b = await ready(await collect(await hold()));
  const buffer = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#ff0000' } }).png().toBuffer();
  const form = () => { const data = new FormData(); data.append('stage', 'HANDOVER'); data.append('assetId', String(asset._id)); data.append('revision', String(b.revision)); data.append('consent', 'true'); data.append('images', new Blob([buffer], { type: 'image/png' }), 'proof.png'); return data; };
  const bad = await fetch(`${getBaseUrl()}/api/admin/rentals/bookings/${b._id}/proofs`, { method: 'POST', headers: { Authorization: `Bearer ${customer.token}` }, body: form() }); assert.equal(bad.status, 403);
  const response = await fetch(`${getBaseUrl()}/api/admin/rentals/bookings/${b._id}/proofs`, { method: 'POST', headers: { Authorization: `Bearer ${admin.token}` }, body: form() });
  assert.equal(response.status, 200); const saved = await response.json(); assert.equal(saved.booking.revision, b.revision + 1); assert.equal(saved.photos.length, 1); assert.ok(!saved.photos[0].bytes);
  const privatePhoto = await request(`/api/rentals/bookings/${b._id}/proofs/${saved.photos[0]._id}`, { token: customer.token }); assert.equal(privatePhoto.status, 200); assert.equal(privatePhoto.headers.get('cache-control'), 'private, no-store');
});
test('partial returns require evidence and acknowledgement for only the physically returned pieces', async () => {
  await policy({ requireConditionPhotos: true, requireCustomerAcknowledgement: true });
  listing = await S.saveListing(store, { ...listing, requirements: [{ ...listing.requirements[0], quantity: 2 }] });
  const second = await S.saveAsset(store, { poolKey: 'outfit', code: 'OUTFIT-002', label: 'Second outfit' });
  let b = await ready(await collect(await hold()));
  await M.Booking.updateOne({ _id: b._id }, { $set: { 'schedule.pickupAt': new Date(Date.now() - 60000), 'schedule.returnDueAt': new Date(Date.now() + 2 * A.DAY) } }); b = S.present(await S.getBooking(store, b._id));
  b = (await upload(b)).booking; b = (await upload(b, 'HANDOVER', '#00ff00', second._id)).booking;
  b = await P.acknowledge(store, b._id, { operationId: op(), revision: b.revision, accepted: true, stage: 'HANDOVER', assetIds: [String(asset._id), String(second._id)] }, customer.user);
  b = await action(b, 'HANDOVER', { note: 'All pieces verified', assetIds: [String(asset._id), String(second._id)] });
  b = (await upload(b, 'RETURN')).booking;
  b = await P.acknowledge(store, b._id, { operationId: op(), revision: b.revision, accepted: true, stage: 'RETURN', assetIds: [String(asset._id)] }, customer.user);
  b = await action(b, 'RECEIVE', { assetIds: [String(asset._id)] }); assert.equal(b.status, 'OUT'); assert.ok(b.allocations[0].receivedAt); assert.ok(!b.allocations[1].receivedAt);
  await assert.rejects(() => upload(b, 'RETURN'), /already been received/);
  b = (await upload(b, 'RETURN', '#00ff00', second._id)).booking;
  b = await P.acknowledge(store, b._id, { operationId: op(), revision: b.revision, accepted: true, stage: 'RETURN', assetIds: [String(second._id)] }, customer.user);
  b = await action(b, 'RECEIVE', { assetIds: [String(second._id)] }); assert.equal(b.status, 'RETURNED');
});
test('proof corrections preserve the audit image, invalidate old acknowledgement and lock after handover', async () => {
  await policy({ requireCustomerAcknowledgement: true }); let b = await ready(await collect(await hold()));
  const result = await upload(b); b = result.booking; const photoId = result.photos[0]._id;
  b = await P.acknowledge(store, b._id, { operationId: op(), revision: b.revision, accepted: true, stage: 'HANDOVER', assetIds: [String(asset._id)] }, customer.user);
  const corrected = await P.withdraw(store, b._id, photoId, { revision: b.revision, note: 'Incorrect angle: replace image' }, admin.user._id); b = corrected.booking;
  assert.equal(corrected.photos.length, 0); assert.ok((await M.Proof.findById(photoId).select('+bytes')).bytes);
  await assert.rejects(() => P.photo(store, b._id, photoId, customer.user._id), /not found/);
  await assert.rejects(async () => P.ensure(await S.getBooking(store, b._id), 'HANDOVER', [String(asset._id)]), /acknowledge/);
  const replacement = await upload(b); b = replacement.booking; await M.Booking.updateOne({ _id: b._id }, { $set: { status: 'OUT' } });
  await assert.rejects(() => P.withdraw(store, b._id, replacement.photos[0]._id, { revision: b.revision, note: 'Too late' }), /locked/);
});
test('variant stock transfer cannot credit the wrong size and records exactly one correct unit', async () => {
  product.variants = [{ sku: 'OUTFIT-S', size: 'S', color: 'Red', stock: 3 }, { sku: 'OUTFIT-M', size: 'M', color: 'Red', stock: 5 }]; await product.save();
  asset = await S.saveAsset(store, { ...asset, variantId: String(product.variants[1]._id), size: 'M', colour: 'Red' });
  const input = { operationId: op(), revision: asset.revision, confirmTransfer: true, note: 'Exact M piece transfer', variantId: String(product.variants[0]._id) };
  await assert.rejects(() => convert(store, asset._id, input), /exact active sale variant/);
  await convert(store, asset._id, { ...input, variantId: String(product.variants[1]._id) }); const result = await Product.findById(product._id);
  assert.equal(result.variants[0].stock, 3); assert.equal(result.variants[1].stock, 6); assert.equal(result.stock, 9);
});
test('unchanged automatic tracking does not inflate booking revisions or its activity timeline', async t => {
  carrierMocks(t); let b = await courierReady();
  await C.operate(store, b._id, 'outbound', 'book', courierInput(b)); b = await S.getBooking(store, b._id);
  await C.operate(store, b._id, 'outbound', 'sync', courierInput(b)); b = await S.getBooking(store, b._id);
  const revision = b.revision, eventCount = b.events.length;
  for (let i = 0; i < 5; i += 1) await C.operate(store, b._id, 'outbound', 'sync', courierInput(b));
  b = await S.getBooking(store, b._id); assert.equal(b.revision, revision); assert.equal(b.events.length, eventCount);
});
test('open customer disputes prevent settlement close and evidence expiry', async () => {
  let b = await hold(); b = await S.requestChange(store, b._id, { revision: b.revision, operationId: op(), type: 'DISPUTE', note: 'Please review my condition evidence' }, customer.user._id);
  b = await action(b, 'CANCEL', { note: 'Cancel unpaid hold', ownerFault: true });
  await assert.rejects(() => action(b, 'CLOSE'), /Resolve pending customer requests\/disputes/);
  b = await S.resolveRequest(store, b._id, { revision: b.revision, operationId: op(), requestId: b.requests[0].operationId, status: 'RESOLVED', note: 'Customer reviewed outcome' }, admin.user._id);
  b = await action(b, 'CLOSE'); assert.equal(b.status, 'CLOSED');
});
test('seller invoice contact and address are snapshotted when a booking is accepted', async () => {
  await setSettings({ storeId: store._id, legalBusinessName: 'Boutique Legal Name', address: '12 Main Street\nJaipur', contactEmail: 'owner@test.local' });
  const b = await hold(); await setSettings({ address: 'New business address' });
  const document = S.present(await S.getBooking(store, b._id)).documents.invoice;
  assert.equal(document.seller.address, '12 Main Street\nJaipur'); assert.equal(document.seller.legalBusinessName, 'Boutique Legal Name'); assert.equal(document.seller.contactEmail, 'owner@test.local');
});
test('disabled variant cannot be rented or confirmed after payment without losing refundable money', async () => {
  product.variants = [{ sku: 'M-RED', size: 'M', color: 'Red', stock: 5 }]; await product.save();
  const variantId = String(product.variants[0]._id);
  asset = await S.saveAsset(store, { ...asset, variantId, size: 'M', colour: 'Red' }); listing = await S.saveListing(store, { ...listing, variantId, size: 'M', colour: 'Red' });
  const b = await hold(); await Product.updateOne({ _id: product._id }, { $set: { 'variants.0.isActive': false } });
  await assert.rejects(() => hold(), /variant is unavailable/);
  const captured = await collect(b, b.quote.dueNowPaise); assert.equal(captured.status, 'EXPIRED'); assert.equal(captured.financial.refundablePaise, b.quote.dueNowPaise);
});
