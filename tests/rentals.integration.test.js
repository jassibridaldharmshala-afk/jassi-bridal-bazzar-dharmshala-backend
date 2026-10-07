const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startTestEnvironment, stopTestEnvironment, resetDatabase, request } = require('./helpers');
const { createCustomer, createAdmin, createProduct, setSettings } = require('./factories');
const { ensureDefaultStore } = require('../services/storeService');
const Store = require('../models/Store');
const S = require('../services/rentalService');
const A = require('../services/rentalAlgorithms');
const M = require('../models/Rental');
let store, customer, admin, product, listing, asset;
const op = () => `test_${crypto.randomUUID()}`;
const dates = (days = 3) => {
  const key = new Date(Date.now() + days * A.DAY).toISOString().slice(0, 10);
  const pickupAt = `${key}T10:00:00+05:30`;
  return { pickupAt, returnDueAt: new Date(+new Date(pickupAt) + 2 * A.DAY).toISOString() };
};
before(startTestEnvironment); after(stopTestEnvironment);
beforeEach(async () => {
  await resetDatabase(); store = await ensureDefaultStore(); customer = await createCustomer(); admin = await createAdmin(); product = await createProduct({ storeId: store._id, commerceMode: 'SALE_AND_RENTAL' });
  await S.saveConfiguration(store, { revision: 0, mode: 'SALE_AND_RENTAL', policy: { ...A.DEFAULT_POLICY } }, admin.user._id);
  listing = await S.saveListing(store, { productId: String(product._id), title: 'Bridal lehenga', active: true, dailyRatePaise: 100000, depositPaise: 500000, requirements: [{ poolKey: 'lehenga-m', label: 'Lehenga M', quantity: 1 }] }, admin.user._id);
  asset = await S.saveAsset(store, { poolKey: 'lehenga-m', code: 'LEHENGA-001', label: 'Bridal lehenga M' });
});
const hold = async (input = {}, user = customer.user) => {
  const payload = { ...dates(), items: [{ listingId: String(listing._id), quantity: 1 }], attemptId: op(), acceptTerms: true, policyRevision: 1, customer: {}, ...input };
  const quote = await M.Booking.exists({ storeId: store._id, attemptId: payload.attemptId }) ? {} : await S.publicQuote(store, payload);
  return S.hold(store, { ...payload, quoteFingerprint: quote.quoteFingerprint }, user);
};
const action = (b, action, extra = {}) => S.mutateBooking(store, b._id, { operationId: op(), revision: b.revision, action, ...extra }, admin.user._id);
test('existing sales default and fashion preset remain unchanged', async () => {
  const { DEFAULT_STRUCTURE, INDUSTRY_PRESETS } = require('../config/industryPresets');
  assert.equal(DEFAULT_STRUCTURE.industry, 'fashion'); assert.equal(INDUSTRY_PRESETS[0].id, 'fashion');
  const second = await Store.create({ name: 'Sale store', slug: 'sale-store' });
  assert.equal((await S.readConfiguration(second)).mode, 'SALE_ONLY');
});
test('concurrent last-piece requests result in exactly one reservation', async () => {
  const result = await Promise.allSettled([hold(), hold()]);
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(await M.Reservation.countDocuments({ active: true }), 1);
  assert.equal((await require('../models/Product').findById(product._id)).stock, 10);
});
test('retry is idempotent and reusing attempt for another date is rejected', async () => {
  const attemptId = op(); const b = await hold({ attemptId });
  assert.equal(String((await hold({ attemptId }))._id), String(b._id));
  await assert.rejects(() => hold({ attemptId, ...dates(8) }), /different details/);
});
test('cleaning/preparation buffers prevent apparently adjacent bookings', async () => {
  const b = await hold();
  await assert.rejects(() => hold({ pickupAt: new Date(b.schedule.returnDueAt).toISOString(), returnDueAt: new Date(+b.schedule.returnDueAt + 2 * A.DAY).toISOString() }), /unavailable/);
});
test('a set requires every physical component and never double allocates', async () => {
  const set = await S.saveListing(store, { productId: String(product._id), title: 'Complete bridal set', active: true, dailyRatePaise: 100000, depositPaise: 500000, requirements: [{ productId: String(product._id), poolKey: 'lehenga-m', label: 'Lehenga', quantity: 1 }, { productId: String(product._id), poolKey: 'necklace', label: 'Necklace', quantity: 1 }] });
  await assert.rejects(() => hold({ items: [{ listingId: String(set._id), quantity: 1 }] }), /Necklace is unavailable/);
  assert.equal(await M.Booking.countDocuments(), 0);
  await S.saveAsset(store, { poolKey: 'necklace', code: 'NECK-001', label: 'Necklace' });
  const b = await hold({ items: [{ listingId: String(set._id), quantity: 1 }] }); assert.equal(b.allocations.length, 2);
});
test('expired hold releases dates; delayed captured payment does not revive it', async () => {
  const b = await hold(); await M.Booking.updateOne({ _id: b._id }, { $set: { expiresAt: new Date(Date.now() - 1) } });
  await M.Reservation.updateMany({ bookingId: b._id }, { $set: { expiresAt: new Date(Date.now() - 1) } });
  await hold();
  const payment = await M.Payment.create({ storeId: store._id, bookingId: b._id, operationId: op(), amountPaise: b.quote.dueNowPaise, orderId: 'order_delayed', state: 'PENDING' });
  await S.handleWebhook({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_delayed', order_id: payment.orderId, amount: payment.amountPaise, currency: 'INR', status: 'captured' } } } });
  const old = await S.getBooking(store, b._id); assert.equal(old.status, 'EXPIRED'); assert.equal(A.finances(old).refundablePaise, payment.amountPaise);
});
test('manual receipts confirm once and reject overcollection', async () => {
  let b = await hold(); const input = { operationId: op(), revision: b.revision, method: 'CASH', reference: 'RECEIPT-1', amountPaise: b.quote.dueNowPaise };
  b = await S.recordCollection(store, b._id, input, admin.user._id); assert.equal(b.status, 'CONFIRMED');
  await S.recordCollection(store, b._id, input, admin.user._id); assert.equal((await S.getBooking(store, b._id)).ledger.length, 1);
  await assert.rejects(() => S.recordCollection(store, b._id, { ...input, operationId: op(), revision: b.revision, reference: 'RECEIPT-2', amountPaise: b.quote.totalPaise }, admin.user._id), /exceeds/);
  await assert.rejects(() => S.recordCollection(store, b._id, { ...input, operationId: op(), revision: b.revision, amountPaise: 100 }, admin.user._id), /already been recorded/);
  assert.equal((await M.Reservation.findOne({ bookingId: b._id })).expiresAt, null);
});
test('date change is atomic and keeps the original dates on conflict', async () => {
  let b = await hold(); b = await S.recordCollection(store, b._id, { operationId: op(), revision: b.revision, method: 'CASH', reference: 'r1', amountPaise: b.quote.dueNowPaise });
  await hold({ ...dates(10) });
  await assert.rejects(() => S.reschedule(store, b._id, { operationId: op(), revision: b.revision, ...dates(10), acceptPricePaise: b.quote.totalPaise }), /conflict/);
  assert.equal(+new Date((await S.getBooking(store, b._id)).schedule.pickupAt), +new Date(b.schedule.pickupAt));
});
test('cancellation releases stock and owner fault refunds full advance/deposit', async () => {
  let b = await hold(); b = await S.recordCollection(store, b._id, { operationId: op(), revision: b.revision, method: 'CASH', reference: 'cash1', amountPaise: b.quote.dueNowPaise });
  b = await action(b, 'CANCEL', { ownerFault: true, note: 'Owner cannot provide this piece.' });
  assert.equal(b.financial.refundablePaise, b.quote.dueNowPaise); assert.equal(await M.Reservation.countDocuments({ bookingId: b._id, active: true }), 0);
  const refundInput = { operationId: op(), revision: b.revision, amountPaise: b.financial.refundablePaise, paymentReference: 'cash1', refundReference: 'cash-refund1', note: 'Deposit and advance returned.' };
  b = await S.refund(store, b._id, refundInput); assert.equal(b.financial.refundablePaise, 0);
  await S.refund(store, b._id, refundInput); assert.equal((await S.getBooking(store, b._id)).ledger.filter(e => e.kind === 'REFUND').length, 1);
});
test('foreign customer and unverified staff cannot access booking/settings', async () => {
  const b = await hold(), other = await createCustomer();
  const r = await request(`/api/rentals/bookings/${b._id}`, { token: other.token }); assert.equal(r.status, 404);
  const forbidden = await request('/api/admin/rentals', { token: other.token }); assert.equal(forbidden.status, 403);
  const unverified = await createAdmin({ isPhoneVerified: false });
  assert.equal((await request('/api/admin/rentals/configuration', { token: unverified.token })).status, 403);
});
test('other store cannot reference a listing, asset or booking', async () => {
  const other = await Store.create({ name: 'Other boutique', slug: 'other-boutique' });
  await S.saveConfiguration(other, { revision: 0, mode: 'SALE_AND_RENTAL', policy: { ...A.DEFAULT_POLICY } });
  const b = await hold();
  await assert.rejects(() => S.getBooking(other, b._id), /not found/);
  await assert.rejects(() => S.changeAsset(other, asset._id, { operationId: op(), revision: 0, status: 'READY' }), /not found/);
  await assert.rejects(() => S.publicQuote(other, { ...dates(), items: [{ listingId: String(listing._id), quantity: 1 }] }), /unavailable/);
});

test('default-store rental product search preserves the tenant boundary and legacy products', async () => {
  const other = await Store.create({ name: 'Private boutique', slug: 'private-boutique' });
  await createProduct({ name: 'Searchable outfit', storeId: other._id });
  const own = await createProduct({ name: 'Searchable outfit', storeId: store._id });
  const legacy = await createProduct({ name: 'Searchable legacy outfit' });
  const result = await S.managementRows(store, 'products', { search: 'Searchable' });
  assert.equal(result.total, 2);
  assert.deepEqual(result.rows.map(row => String(row._id)).sort(), [String(own._id), String(legacy._id)].sort());
});

test('warehouse piece status updates do not reveal acquisition costs', async () => {
  const staff = await createCustomer({ availableModes: ['customer', 'seller'], activeMode: 'seller' });
  await require('../models/StoreMember').create({ store: store._id, user: staff.user._id, role: 'WAREHOUSE', status: 'ACTIVE' });
  await M.Asset.updateOne({ _id: asset._id }, { $set: { costPaise: 123456 } });
  const result = await request(`/api/seller/rentals/assets/${asset._id}/status`, { token: staff.token, method: 'POST', headers: { 'x-store-id': String(store._id) }, body: { operationId: op(), revision: 0, status: 'READY', note: 'Condition checked.' } });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.costPaise, undefined);
  assert.equal((await M.Asset.findById(asset._id)).costPaise, 123456);
});
test('API quote/hold redact internal allocations and enforce revised policy acceptance', async () => {
  const payload = { ...dates(), items: [{ listingId: String(listing._id), quantity: 1 }] };
  const quote = await request('/api/rentals/quote', { method: 'POST', body: payload }); assert.equal(quote.status, 200); assert.equal(quote.data.allocations, undefined);
  const stale = await request('/api/rentals/bookings', { token: customer.token, method: 'POST', body: { ...payload, attemptId: op(), acceptTerms: true, policyRevision: 0 } }); assert.equal(stale.status, 409); assert.equal(stale.data.code, 'RENTAL_QUOTE_CHANGED');
  const valid = await request('/api/rentals/bookings', { token: customer.token, method: 'POST', body: { ...payload, attemptId: op(), acceptTerms: true, policyRevision: 1, quoteFingerprint: quote.data.quoteFingerprint } }); assert.equal(valid.status, 200); assert.equal(valid.data.allocations, undefined);
});
test('payment setup/verification is separate from sales and duplicate capture is harmless', async () => {
  process.env.RAZORPAY_KEY_ID = 'rzp_test_rental'; process.env.RAZORPAY_KEY_SECRET = 'test_rental_secret'; await setSettings({ razorpayEnabled: true });
  const b = await hold(); const p = await S.createPayment(store, b._id, { operationId: op() }, customer.user._id);
  assert.ok(p.orderId);
  const resumed = await S.createPayment(store, b._id, { operationId: op() }, customer.user._id); assert.equal(resumed.orderId, p.orderId);
  const paymentId = 'pay_rental_verified';
  const signature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${p.orderId}|${paymentId}`).digest('hex');
  const input = { razorpay_order_id: p.orderId, razorpay_payment_id: paymentId, razorpay_signature: signature };
  const confirmed = await S.verifyPayment(store, b._id, input, customer.user._id); assert.equal(confirmed.status, 'CONFIRMED');
  await S.verifyPayment(store, b._id, input, customer.user._id); assert.equal((await S.getBooking(store, b._id)).ledger.length, 1);
  assert.equal((await require('../models/Product').findById(product._id)).stock, 10);
});

const collectFull = async b => S.recordCollection(store, b._id, { operationId: op(), revision: b.revision, method: 'CASH', reference: op(), amountPaise: b.financial.balancePaise });
const handover = async b => {
  b = await action(b, 'PREPARE'); b = await action(b, 'READY');
  await M.Booking.updateOne({ _id: b._id }, { $set: { 'schedule.pickupAt': new Date(Date.now() - 60000), 'schedule.blockedFrom': new Date(Date.now() - A.DAY) } });
  b = S.present(await S.getBooking(store, b._id));
  return action(b, 'HANDOVER', { assetIds: b.allocations.map(a => String(a.assetId)), note: 'Customer acknowledged every piece and its condition.' });
};
test('full pickup, inspection, cleaning and deposit settlement never restocks sale inventory', async () => {
  let b = await handover(await collectFull(await hold()));
  assert.equal((await M.Asset.findById(asset._id)).status, 'OUT');
  assert.equal(b.financial.refundablePaise, 0);
  b = await action(b, 'RECEIVE', { assetIds: [String(asset._id)], note: 'Piece received, inspection pending.' });
  await assert.rejects(() => S.publicQuote(store, { ...dates(12), items: [{ listingId: String(listing._id), quantity: 1 }] }), /unavailable/);
  await assert.rejects(() => S.refund(store, b._id, { operationId: op(), revision: b.revision, amountPaise: 100, note: 'Not inspected.', paymentReference: b.ledger[0].reference, refundReference: op() }), /Inspect/);
  b = await action(b, 'INSPECT', { assetId: String(asset._id), disposition: 'CLEANING', note: 'No damage. Cleaning required.' });
  b = await action(b, 'ASSESS', { type: 'OTHER', amountPaise: 100000, note: 'Agreed documented additional service.' });
  assert.equal(b.financial.refundablePaise, 400000); assert.equal(b.financial.balancePaise, 0);
  b = await action(b, 'WAIVE_ASSESSMENT', { assessmentId: b.assessments[0].operationId, note: 'Owner waived the additional service.' });
  assert.equal(b.financial.refundablePaise, 500000);
  b = await action(b, 'RELEASE', { assetId: String(asset._id), note: 'Cleaning completed, inspected and verified ready.' });
  b = await S.refund(store, b._id, { operationId: op(), revision: b.revision, amountPaise: 500000, paymentReference: b.ledger[0].reference, refundReference: op(), note: 'Full security deposit returned.' });
  b = await action(b, 'CLOSE'); assert.equal(b.status, 'CLOSED'); assert.equal(b.financial.balancePaise, 0);
  assert.equal((await M.Asset.findById(asset._id)).status, 'READY');
  assert.equal((await require('../models/Product').findById(product._id)).stock, 10);
});
test('lost piece is not falsely received and future bookings must be safely substituted', async () => {
  let b = await handover(await collectFull(await hold()));
  let future = await hold({ ...dates(12) });
  b = await action(b, 'DECLARE_LOST', { assetId: String(asset._id), evidenceUrl: 'https://media.example/loss-evidence.jpg', note: 'Customer acknowledged that the piece was lost.' });
  assert.equal(b.status, 'RETURNED'); assert.ok(b.allocations[0].lostAt); assert.equal(b.allocations[0].receivedAt, undefined);
  await assert.rejects(() => action(b, 'RELEASE', { assetId: String(asset._id), note: 'Retire piece.' }), /future bookings/);
  const replacement = await S.saveAsset(store, { poolKey: 'lehenga-m', code: 'LEHENGA-002', label: 'Approved equivalent lehenga' });
  await assert.rejects(() => S.replacePiece(store, future._id, { revision: future.revision, operationId: op(), assetId: String(asset._id), replacementId: String(replacement._id), note: 'Substitute.' }), /approval/);
  future = await S.replacePiece(store, future._id, { revision: future.revision, operationId: op(), assetId: String(asset._id), replacementId: String(replacement._id), customerAcknowledged: true, note: 'Customer accepted the equivalent piece.' });
  assert.equal(String(future.allocations[0].assetId), String(replacement._id));
  b = await action(b, 'RELEASE', { assetId: String(asset._id), note: 'Lost piece retired after future assignment was resolved.' });
  assert.equal((await M.Asset.findById(asset._id)).status, 'RETIRED');
});
test('partial line cancellation preserves the remaining booking and refunds only its surplus', async () => {
  const accessory = await S.saveListing(store, { productId: String(product._id), title: 'Necklace', active: true, dailyRatePaise: 50000, depositPaise: 200000, requirements: [{ poolKey: 'necklace', label: 'Necklace', quantity: 1 }] });
  await S.saveAsset(store, { poolKey: 'necklace', code: 'NECK-001', label: 'Necklace' });
  let b = await collectFull(await hold({ items: [{ listingId: String(listing._id), quantity: 1 }, { listingId: String(accessory._id), quantity: 1 }] }));
  b = await S.cancelItems(store, b._id, { revision: b.revision, operationId: op(), listingId: String(listing._id), ownerFault: true, acceptPricePaise: 300000, note: 'Customer agreed to retain only the necklace.' });
  assert.equal(b.status, 'CONFIRMED'); assert.equal(b.quote.items.length, 1); assert.equal(b.allocations.length, 1); assert.equal(b.financial.refundablePaise, 700000); assert.equal(b.acceptedQuote.items.length, 2);
  b = await S.refund(store, b._id, { revision: b.revision, operationId: op(), amountPaise: 700000, paymentReference: b.ledger[0].reference, refundReference: op(), note: 'Cancelled outfit amount returned, remaining necklace deposit retained.' });
  assert.equal(b.financial.balancePaise, 0); assert.equal(b.financial.refundablePaise, 0); assert.equal(b.financial.depositHeldPaise, 200000);
  assert.equal(await M.Reservation.countDocuments({ bookingId: b._id, active: true }), 1);
});
test('zero advance is rejected and no-deposit bookings still need a verified advance', async () => {
  await assert.rejects(() => S.saveConfiguration(store, { revision: 1, mode: 'SALE_AND_RENTAL', policy: { ...A.DEFAULT_POLICY, advancePercent: 0 } }), /positive booking advance/);
  listing = await S.saveListing(store, { ...listing, depositPaise: 0 });
  let b = await hold(); assert.equal(b.status, 'HELD'); assert.ok((await M.Reservation.findOne({ bookingId: b._id })).expiresAt);
  b = await S.recordCollection(store, b._id, { revision: b.revision, operationId: op(), amountPaise: b.quote.advanceRentPaise, method: 'CASH', reference: op() }, admin.user._id);
  assert.equal(b.status, 'CONFIRMED'); assert.equal((await M.Reservation.findOne({ bookingId: b._id })).expiresAt, null);
});
test('disabled rentals block new holds but keep existing returns and refunds operational', async () => {
  let b = await handover(await collectFull(await hold()));
  await S.saveConfiguration(store, { revision: 1, mode: 'SALE_ONLY', policy: { ...A.DEFAULT_POLICY } });
  const updatedStore = await Store.findById(store._id); assert.equal(updatedStore.salesEnabled, true);
  await assert.rejects(() => hold(), /not accepting/);
  b = await action(b, 'RECEIVE', { assetIds: [String(asset._id)] }); assert.equal(b.status, 'RETURNED');
});
test('counter bookings link verified customers without bypassing store access', async () => {
  const payload = { ...dates(), items: [{ listingId: String(listing._id), quantity: 1 }], attemptId: op(), policyRevision: 1, acceptTerms: true, customer: { name: customer.user.name, phone: customer.user.phone } };
  const quote = await S.publicQuote(store, payload, { counter: true });
  const b = await S.hold(store, { ...payload, quoteFingerprint: quote.quoteFingerprint }, admin.user, { counter: true });
  assert.equal(String(b.userId), String(customer.user._id));
  assert.equal((await request(`/api/rentals/bookings/${b._id}`, { token: customer.token })).status, 200);
});
test('reconciliation verifies provider facts and does not accept fabricated refund amounts', async () => {
  process.env.RAZORPAY_KEY_ID = 'rzp_test_rental'; process.env.RAZORPAY_KEY_SECRET = 'test_rental_secret';
  let b = await collectFull(await hold());
  b = await action(b, 'CANCEL', { ownerFault: true, note: 'Owner cancellation.' });
  await M.Booking.updateOne({ _id: b._id }, { $push: { ledger: { operationId: 'refund_review_test', kind: 'REFUND', method: 'RAZORPAY', paymentId: 'pay_test', amountPaise: 100000, status: 'REVIEW' } } });
  const original = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ items: [{ id: 'rfnd_test', payment_id: 'pay_test', amount: 1, currency: 'INR', status: 'processed', notes: { rentalBookingId: String(b._id), rentalOperationId: 'refund_review_test' } }] }) });
  try { await assert.rejects(() => S.reconcileRefunds(store), /did not match/); assert.equal((await S.getBooking(store, b._id)).ledger.at(-1).status, 'REVIEW'); }
  finally { global.fetch = original; }
});

test('a changed listing price requires a fresh accepted quote before creating any hold', async () => {
  const payload = { ...dates(), items: [{ listingId: String(listing._id), quantity: 1 }] };
  const old = await S.publicQuote(store, payload);
  assert.equal(old.quote.totalPaise, 700000);
  await S.saveListing(store, { ...listing, dailyRatePaise: 200000 });
  const input = { ...payload, attemptId: op(), acceptTerms: true, policyRevision: 1, quoteFingerprint: old.quoteFingerprint };
  await assert.rejects(() => S.hold(store, input, customer.user), error => error.errorCode === 'RENTAL_QUOTE_CHANGED');
  assert.equal(await M.Booking.countDocuments(), 0); assert.equal(await M.Reservation.countDocuments(), 0);
  const current = await S.publicQuote(store, payload);
  const b = await S.hold(store, { ...input, quoteFingerprint: current.quoteFingerprint }, customer.user);
  assert.equal(b.quote.totalPaise, 900000);
});

test('missing or forged quote fingerprints cannot bypass price acceptance', async () => {
  const payload = { ...dates(), items: [{ listingId: String(listing._id), quantity: 1 }], attemptId: op(), acceptTerms: true, policyRevision: 1 };
  await assert.rejects(() => S.hold(store, payload, customer.user), error => error.errorCode === 'RENTAL_QUOTE_CHANGED');
  await assert.rejects(() => S.hold(store, { ...payload, quoteFingerprint: '0'.repeat(64) }, customer.user), error => error.errorCode === 'RENTAL_QUOTE_CHANGED');
});

test('explicit provider rejection releases payment setup but never invents a collection', async t => {
  process.env.RAZORPAY_KEY_ID = 'rzp_test_rental'; process.env.RAZORPAY_KEY_SECRET = 'test_rental_secret'; await setSettings({ razorpayEnabled: true });
  let b = await hold(); const operationId = op();
  const create = t.mock.method(require('../services/razorpayService'), 'createRazorpayOrder', async () => { const error = new Error('Rejected'); error.razorpayDefinitiveRejection = true; throw error; });
  await assert.rejects(() => S.createPayment(store, b._id, { operationId }, customer.user._id), e => e.errorCode === 'PAYMENT_SETUP_REJECTED');
  assert.equal((await M.Payment.findOne({ bookingId: b._id })).state, 'FAILED');
  await assert.rejects(() => S.createPayment(store, b._id, { operationId }, customer.user._id), e => e.errorCode === 'PAYMENT_SETUP_REJECTED');
  assert.equal(create.mock.callCount(), 1); assert.equal((await S.getBooking(store, b._id)).ledger.length, 0);
  b = await S.recordCollection(store, b._id, { operationId: op(), revision: b.revision, amountPaise: b.quote.dueNowPaise, method: 'CASH', reference: 'AFTER-REJECTION' }, admin.user._id);
  assert.equal(b.status, 'CONFIRMED'); assert.equal(b.ledger.length, 1);
});

test('unknown setup remains blocked until a scoped provider record recovers it once', async t => {
  process.env.RAZORPAY_KEY_ID = 'rzp_test_rental'; process.env.RAZORPAY_KEY_SECRET = 'test_rental_secret'; await setSettings({ razorpayEnabled: true });
  const b = await hold();
  const create = t.mock.method(require('../services/razorpayService'), 'createRazorpayOrder', async () => { throw new Error('Response lost'); });
  await assert.rejects(() => S.createPayment(store, b._id, { operationId: op() }, customer.user._id));
  const p = await M.Payment.findOne({ bookingId: b._id }).lean(); assert.equal(p.state, 'REVIEW');
  await assert.rejects(() => S.createPayment(store, b._id, { operationId: op() }, customer.user._id)); assert.equal(create.mock.callCount(), 1);
  await assert.rejects(() => S.recordCollection(store, b._id, { operationId: op(), revision: b.revision, amountPaise: b.quote.dueNowPaise, method: 'CASH', reference: 'BLOCKED-REVIEW' }), /online payment is pending/);
  const originalFetch = global.fetch;
  t.mock.method(global, 'fetch', async (url, ...args) => String(url).startsWith('https://api.razorpay.com/') ? ({ ok: true, json: async () => String(url).includes('/payments')
    ? { items: [{ id: 'pay_recovered', order_id: 'order_recovered', amount: p.amountPaise, currency: 'INR', status: 'captured' }] }
    : { items: [{ id: 'order_recovered', receipt: String(p._id), amount: p.amountPaise, currency: 'INR', notes: { purpose: 'rental', rentalPaymentId: String(p._id), rentalBookingId: String(b._id), storeId: String(store._id) } }] } }) : originalFetch(url, ...args));
  const result = await S.recoverPayment(store, b._id, p._id); assert.equal(result.booking.status, 'CONFIRMED'); assert.equal(result.booking.ledger.length, 1);
  await S.recoverPayment(store, b._id, p._id); assert.equal((await S.getBooking(store, b._id)).ledger.length, 1);
  assert.equal((await request(`/api/seller/rentals/bookings/${b._id}/payments`, { token: customer.token })).status, 403);
});

test('an empty provider lookup cannot authorise another charge or manual payment', async t => {
  const b = await hold(); const p = await M.Payment.create({ storeId: store._id, bookingId: b._id, operationId: op(), amountPaise: b.quote.dueNowPaise, state: 'REVIEW' });
  process.env.RAZORPAY_KEY_ID = 'rzp_test_rental'; process.env.RAZORPAY_KEY_SECRET = 'test_rental_secret';
  t.mock.method(global, 'fetch', async () => ({ ok: true, json: async () => ({ items: [] }) }));
  await assert.rejects(() => S.recoverPayment(store, b._id, p._id));
  const after = await M.Payment.findById(p._id); assert.equal(after.state, 'REVIEW'); assert.ok(after.lastCheckedAt); assert.ok(after.nextCheckAt);
  assert.equal((await S.getBooking(store, b._id)).ledger.length, 0);
});

test('changed schedules and completed pickup invalidate queued reminders without sending', async () => {
  const b = await hold(); const W = require('../services/rentalWorker');
  const job = { storeId: store._id, bookingId: b._id, channel: 'IN_APP', audience: 'CUSTOMER', dedupeKey: op() };
  await M.Booking.updateOne({ _id: b._id }, { $set: { status: 'OUT', 'schedule.pickupAt': new Date(Date.now() - A.DAY), 'schedule.returnDueAt': new Date(Date.now() + 5 * A.DAY) } });
  assert.ok((await W.deliver({ ...job, event: 'OVERDUE' })).skipped);
  assert.ok((await W.deliver({ ...job, event: 'PICKUP_DUE' })).skipped);
  assert.ok((await W.deliver({ ...job, event: 'RETURN_DUE', reminderReturnDueAt: new Date(Date.now() - A.HOUR) })).skipped);
  assert.equal(await require('../models/Notification').countDocuments({ event: { $in: ['RENTAL_OVERDUE', 'RENTAL_PICKUP_DUE', 'RENTAL_RETURN_DUE'] } }), 0);
});

test('expired installation allows existing customer settlement, not new holds or foreign access', async t => {
  let b = await hold(); b = await S.recordCollection(store, b._id, { operationId: op(), revision: b.revision, amountPaise: b.quote.dueNowPaise, method: 'CASH', reference: 'BEFORE-EXPIRY' });
  const status = { managed: true, status: 'EXPIRED', features: [], limits: {} };
  t.mock.method(require('../services/controlPlaneClient'), 'licenseStatus', async () => status);
  const path = require.resolve('../middleware/externalLicenseMiddleware'), original = require.cache[path]; delete require.cache[path]; const gate = require(path);
  t.after(() => { require.cache[path] = original; });
  const check = async (url, userId = customer.user._id) => { let error; await gate({ method: 'POST', originalUrl: `/api${url}`, user: { _id: userId }, body: {} }, {}, e => { error = e; }); return error; };
  assert.equal(await check(`/rentals/bookings/${b._id}/payment`), undefined);
  assert.equal((await check('/rentals/bookings'))?.errorCode, 'SUBSCRIPTION_REQUIRED');
  assert.equal((await check(`/rentals/bookings/${b._id}/payment`, admin.user._id))?.errorCode, 'SUBSCRIPTION_REQUIRED');
  await assert.rejects(() => hold({ ...dates(10) }), e => e.errorCode === 'SUBSCRIPTION_REQUIRED');
  process.env.RAZORPAY_KEY_ID = 'rzp_test_rental'; process.env.RAZORPAY_KEY_SECRET = 'test_rental_secret'; await setSettings({ razorpayEnabled: true });
  const p = await S.createPayment(store, b._id, { operationId: op() }, customer.user._id);
  assert.equal(p.amountPaise, b.financial.balancePaise);
  const paymentId = 'pay_balance_after_expiry';
  await S.verifyPayment(store, b._id, { razorpay_order_id: p.orderId, razorpay_payment_id: paymentId, razorpay_signature: crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${p.orderId}|${paymentId}`).digest('hex') }, customer.user._id);
  assert.equal(A.finances(await S.getBooking(store, b._id)).balancePaise, 0);
  assert.equal((await require('../services/commerceUsageService').monthlyUsage({ store })).rentalBookingsPerMonth, 1);
  status.status = 'REVOKED'; assert.equal((await check(`/rentals/bookings/${b._id}/payment`))?.errorCode, 'SUBSCRIPTION_REQUIRED');
  status.status = 'EXPIRED'; t.mock.method(M.Booking, 'findOne', () => { throw new Error('Settlement database unavailable'); });
  assert.equal((await check(`/rentals/bookings/${b._id}/payment`)).message, 'Settlement database unavailable');
});

test('captured money after installation expiry stays refundable and never confirms a hold', async t => {
  const b = await hold(); const p = await M.Payment.create({ storeId: store._id, bookingId: b._id, operationId: op(), amountPaise: b.quote.dueNowPaise, orderId: 'order_expired_license', state: 'PENDING' });
  t.mock.method(require('../services/controlPlaneClient'), 'licenseStatus', async () => ({ managed: true, status: 'EXPIRED' }));
  await S.handleWebhook({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_expired_license', order_id: p.orderId, amount: p.amountPaise, currency: 'INR', status: 'captured' } } } });
  const after = await S.getBooking(store, b._id); assert.equal(after.status, 'EXPIRED'); assert.equal(A.finances(after).refundablePaise, p.amountPaise);
  assert.equal(await M.Reservation.countDocuments({ bookingId: b._id, active: true }), 0);
});

test('sale and rental compete atomically for the same last monthly quota slot', async () => {
  await setSettings(); await Store.updateOne({ _id: store._id }, { $set: { 'license.limitOverrides.ordersPerMonth': 1 } }); store = await Store.findById(store._id);
  const b = await hold();
  const { validAddress } = require('./factories');
  const results = await Promise.allSettled([
    S.recordCollection(store, b._id, { operationId: op(), revision: b.revision, amountPaise: b.quote.dueNowPaise, method: 'CASH', reference: 'LAST-MONTHLY-SLOT' }),
    request('/api/orders/cod', { method: 'POST', token: customer.token, body: { orderItems: [{ product: String(product._id), quantity: 1 }], shippingAddress: validAddress(), paymentMethod: 'COD' } }),
  ]);
  const rentalSucceeded = results[0].status === 'fulfilled';
  const saleSucceeded = results[1].status === 'fulfilled' && results[1].value.status === 201;
  assert.equal(Number(rentalSucceeded) + Number(saleSucceeded), 1, JSON.stringify(results));
  assert.equal((await require('../services/commerceUsageService').monthlyUsage({ store })).ordersPerMonth, 1);
  if (!rentalSucceeded) assert.equal(results[0].reason.errorCode, 'PLAN_LIMIT_REACHED');
  if (!saleSucceeded) assert.equal(results[1].value.data.code, 'PLAN_LIMIT_REACHED');
});

test('monthly usage excludes unpaid holds and preserves combined signed installation limits', async t => {
  const status = { managed: true, status: 'ACTIVE', features: ['analytics'], limits: { ordersPerMonth: 1 } };
  t.mock.method(require('../services/controlPlaneClient'), 'licenseStatus', async () => status);
  let b = await hold(); const U = require('../services/commerceUsageService');
  assert.equal((await U.monthlyUsage({ store })).ordersPerMonth, 0);
  b = await S.recordCollection(store, b._id, { operationId: op(), revision: b.revision, amountPaise: b.quote.dueNowPaise, method: 'CASH', reference: 'SIGNED-LIMIT' });
  const usage = await U.monthlyUsage({ store }); assert.equal(usage.rentalBookingsPerMonth, 1); assert.equal(usage.saleOrdersPerMonth, 0);
  await assert.rejects(() => hold({ ...dates(10) }), e => e.errorCode === 'PLAN_LIMIT_REACHED');
  const report = await require('../services/subscriptionService').subscriptionStatus(store); assert.equal(report.usage.ordersPerMonth, 1); assert.equal(report.usage.rentalBookingsPerMonth, 1);
});

test('a failed payment attempt cannot release a still-open provider order for duplicate collection', async () => {
  process.env.RAZORPAY_KEY_ID = 'rzp_test_rental'; process.env.RAZORPAY_KEY_SECRET = 'test_rental_secret'; await setSettings({ razorpayEnabled: true });
  const b = await hold(); const handle = await S.createPayment(store, b._id, { operationId: op() }, customer.user._id);
  await S.handleWebhook({ event: 'payment.failed', payload: { payment: { entity: { order_id: handle.orderId, status: 'failed' } } } });
  assert.equal((await M.Payment.findOne({ bookingId: b._id })).state, 'REVIEW');
  await assert.rejects(() => S.recordCollection(store, b._id, { operationId: op(), revision: b.revision, amountPaise: b.quote.dueNowPaise, method: 'CASH', reference: 'NO-DOUBLE-COLLECTION' }), /online payment is pending/);
  assert.equal((await S.createPayment(store, b._id, { operationId: op() }, customer.user._id)).orderId, handle.orderId);
  // Legacy FAILED records with a provider order must be just as protected.
  await M.Payment.updateOne({ bookingId: b._id }, { $set: { state: 'FAILED' } });
  assert.equal((await S.createPayment(store, b._id, { operationId: op() }, customer.user._id)).orderId, handle.orderId);
  await assert.rejects(() => S.recordCollection(store, b._id, { operationId: op(), revision: b.revision, amountPaise: b.quote.dueNowPaise, method: 'CASH', reference: 'LEGACY-NO-DOUBLE' }), /online payment is pending/);
});

test('payment recovery refuses foreign or ambiguous provider orders', async t => {
  process.env.RAZORPAY_KEY_ID = 'rzp_test_rental'; process.env.RAZORPAY_KEY_SECRET = 'test_rental_secret';
  const b = await hold(); const p = await M.Payment.create({ storeId: store._id, bookingId: b._id, operationId: op(), amountPaise: b.quote.dueNowPaise, state: 'REVIEW' });
  const matching = { id: 'order_valid_recovery', receipt: String(p._id), amount: p.amountPaise, currency: 'INR', notes: { purpose: 'rental', rentalPaymentId: String(p._id), rentalBookingId: String(b._id), storeId: String(store._id) } };
  let items = [{ ...matching, notes: { ...matching.notes, storeId: 'foreign-store' } }];
  t.mock.method(global, 'fetch', async () => ({ ok: true, json: async () => ({ items }) }));
  await assert.rejects(() => S.recoverPayment(store, b._id, p._id), /exactly one matching order/);
  items = [matching, { ...matching, id: 'order_second_match' }];
  await assert.rejects(() => S.recoverPayment(store, b._id, p._id), /exactly one matching order/);
  assert.equal((await M.Payment.findById(p._id)).orderId, undefined);
  assert.equal((await S.getBooking(store, b._id)).ledger.length, 0);
});

test('payment recovery rotation does not let twenty unresolved rows starve later attempts', async t => {
  process.env.RAZORPAY_KEY_ID = 'rzp_test_rental'; process.env.RAZORPAY_KEY_SECRET = 'test_rental_secret';
  const b = await hold();
  await M.Payment.insertMany(Array.from({ length: 21 }, () => ({ storeId: store._id, bookingId: b._id, operationId: op(), amountPaise: b.quote.dueNowPaise, state: 'REVIEW', createdAt: new Date(Date.now() - 3 * 60000), updatedAt: new Date(Date.now() - 2 * 60000) })));
  t.mock.method(global, 'fetch', async () => ({ ok: true, json: async () => ({ items: [] }) }));
  await S.reconcilePayments(store); assert.equal(await M.Payment.countDocuments({ lastCheckedAt: { $exists: true } }), 20);
  await S.reconcilePayments(store); assert.equal(await M.Payment.countDocuments({ lastCheckedAt: { $exists: true } }), 21);
});

test('captured payment after the last signed quota is consumed is refundable rather than activating stock', async t => {
  t.mock.method(require('../services/controlPlaneClient'), 'licenseStatus', async () => ({ managed: true, status: 'ACTIVE', features: [], limits: { ordersPerMonth: 1 } }));
  const b = await hold(); const second = await hold({ ...dates(10) });
  await S.recordCollection(store, second._id, { operationId: op(), revision: second.revision, amountPaise: second.quote.dueNowPaise, method: 'CASH', reference: 'OTHER-CONFIRMED-SLOT' });
  const p = await M.Payment.create({ storeId: store._id, bookingId: b._id, operationId: op(), amountPaise: b.quote.dueNowPaise, state: 'PENDING', orderId: 'order_after_quota' });
  await S.handleWebhook({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_after_quota', order_id: p.orderId, amount: p.amountPaise, currency: 'INR', status: 'captured' } } } });
  const after = await S.getBooking(store, b._id); assert.equal(after.status, 'EXPIRED'); assert.equal(A.finances(after).refundablePaise, p.amountPaise);
  assert.equal(await M.Reservation.countDocuments({ bookingId: b._id, active: true }), 0);
  assert.equal((await require('../services/commerceUsageService').monthlyUsage({ allStores: true })).ordersPerMonth, 1);
});

test('rental reports follow both the local analytics plan and signed installation feature', async t => {
  await Store.updateOne({ _id: store._id }, { $set: { plan: 'BASIC' } });
  const reportUrl = `/api/admin/rentals/report?from=${encodeURIComponent(new Date(Date.now() - A.DAY).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + A.DAY).toISOString())}`;
  assert.equal((await request('/api/admin/rentals', { token: admin.token })).data.permissions['reports.read'], false);
  assert.equal((await request(reportUrl, { token: admin.token })).data.code, 'PLAN_FEATURE_REQUIRED');
  await Store.updateOne({ _id: store._id }, { $set: { plan: 'PROFESSIONAL' } });
  assert.equal((await request('/api/admin/rentals', { token: admin.token })).data.permissions['reports.read'], true);
  assert.equal((await request(reportUrl, { token: admin.token })).status, 200);
  t.mock.method(require('../services/controlPlaneClient'), 'licenseStatus', async () => ({ managed: true, status: 'ACTIVE', features: [], limits: {} }));
  const path = require.resolve('../middleware/externalLicenseMiddleware'), original = require.cache[path]; delete require.cache[path]; const gate = require(path);
  t.after(() => { require.cache[path] = original; });
  let denied; await gate({ method: 'GET', originalUrl: reportUrl, user: { _id: admin.user._id } }, {}, e => { denied = e; });
  assert.equal(denied.errorCode, 'PLAN_FEATURE_REQUIRED');
});

test('paid balances and completed returns suppress old reminder jobs', async () => {
  const b = await collectFull(await hold()); const W = require('../services/rentalWorker');
  await M.Booking.updateOne({ _id: b._id }, { $set: { 'schedule.balanceDueAt': new Date(Date.now() - A.HOUR) } });
  const job = { storeId: store._id, bookingId: b._id, channel: 'IN_APP', audience: 'CUSTOMER', dedupeKey: op() };
  assert.ok((await W.deliver({ ...job, event: 'BALANCE_DUE' })).skipped);
  await M.Booking.updateOne({ _id: b._id }, { $set: { status: 'RETURNED', 'schedule.returnDueAt': new Date(Date.now() - A.HOUR) } });
  assert.ok((await W.deliver({ ...job, event: 'OVERDUE' })).skipped);
});
