require('./rentalPaymentFixture');
const { test, before, beforeEach, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startTestEnvironment, stopTestEnvironment, resetDatabase, request } = require('./helpers');
const { createCustomer, createAdmin, createProduct, setSettings } = require('./factories');
const { ensureDefaultStore } = require('../services/storeService');
const S = require('../services/rentalService'), A = require('../services/rentalAlgorithms'), Setup = require('../services/rentalSetupService'), M = require('../models/Rental');
const op = () => 'shopping_' + crypto.randomUUID();
let store, customer, admin, listing;
before(async () => { mock.method(require('../services/controlPlaneClient'), 'licenseStatus', async () => ({ managed: false, status: 'ACTIVE' })); await startTestEnvironment(); });
after(async () => { await stopTestEnvironment(); mock.restoreAll(); });
beforeEach(async () => {
  await resetDatabase(); store = await ensureDefaultStore(); await require('./rentalPaymentFixture').configure(store); customer = await createCustomer(); admin = await createAdmin();
  await S.saveConfiguration(store, { revision: 0, mode: 'SALE_AND_RENTAL', policy: { ...A.DEFAULT_POLICY, balanceDueHours: 0 } });
  const product = await createProduct({ storeId: store._id, sku: op(), commerceMode: 'SALE_AND_RENTAL', stock: 0, sizingMode: 'free-size' });
  listing = await S.saveListing(store, { productId: String(product._id), title: 'Rental bridal outfit', active: false, dailyRatePaise: 150000, depositPaise: 200000, requirements: [{ poolKey: 'bridal', label: 'Outfit', quantity: 1 }] });
  await Setup.registerPieces(store, String(listing._id), { operationId: op(), revision: listing.revision, componentIndex: 0, quantity: 1 }); listing = await S.saveListing(store, { ...listing, active: true });
});
function plan(paymentPlan = 'ADVANCE') {
  const pickup = A.localKey(new Date(Date.now() + 5 * A.DAY), 'Asia/Kolkata');
  const useDay = new Date(Date.parse(pickup + 'T12:00Z') + A.DAY).toISOString().slice(0, 10);
  const returnDay = new Date(Date.parse(pickup + 'T12:00Z') + 2 * A.DAY).toISOString().slice(0, 10);
  return { pickupAt: pickup + 'T10:00:00+05:30', returnDueAt: returnDay + 'T10:00:00+05:30', useDates: [useDay], paymentPlan, items: [{ listingId: String(listing._id), quantity: 1 }] };
}
async function reviewed(input) { const q = await S.publicQuote(store, input); return { ...input, attemptId: op(), acceptTerms: true, customer: {}, policyRevision: q.policyRevision, quoteFingerprint: q.quoteFingerprint }; }
test('transit days add no rent, while availability still blocks the complete custody and cleaning period', async () => {
  const input = plan('PICKUP'), q = await S.publicQuote(store, input);
  assert.equal(q.schedule.days, 1); assert.equal(q.schedule.custodyDays, 2); assert.equal(q.quote.rentalPaise, 150000); assert.equal(q.schedule.billingBasis, 'USE_DAYS');
  const b = await S.hold(store, await reviewed(input), customer.user); assert.equal(b.status, 'CONFIRMED');
  const reservation = await M.Reservation.findOne({ bookingId: b._id }).lean(); assert.equal(reservation.expiresAt, null); assert.equal(+reservation.blockedFrom, +new Date(input.pickupAt) - A.DAY);
  await assert.rejects(() => S.publicQuote(store, { ...input, useDates: [input.pickupAt.slice(0, 10)] }), /unavailable/);
});
test('advance, full and pickup plans quote distinct authoritative due-now amounts and fingerprints', async () => {
  const advance = await S.publicQuote(store, plan()), full = await S.publicQuote(store, plan('FULL')), pickup = await S.publicQuote(store, plan('PICKUP'));
  assert.equal(advance.quote.dueNowPaise, 245000); assert.equal(full.quote.dueNowPaise, 350000); assert.equal(full.quote.remainingPaise, 0); assert.equal(pickup.quote.dueNowPaise, 0); assert.equal(pickup.quote.remainingPaise, 350000);
  assert.notEqual(advance.quoteFingerprint, pickup.quoteFingerprint);
  const accepted = await reviewed(plan());
  await assert.rejects(() => S.hold(store, { ...accepted, paymentPlan: 'PICKUP' }, customer.user), /changed/);
});
test('pickup booking is confirmed once without a fake collection; handover still requires full payment', async () => {
  await setSettings({ storeId: store._id, acceptingOrders: true, razorpayEnabled: false });
  const input = await reviewed(plan('PICKUP'));
  const first = await request('/api/rentals/bookings', { method: 'POST', token: customer.token, body: input });
  assert.equal(first.status, 200); assert.equal(first.data.status, 'CONFIRMED'); assert.equal(first.data.financial.collectedPaise, 0); assert.equal(first.data.financial.balancePaise, 350000); assert.equal(first.data.allocations, undefined);
  const second = await S.hold(store, input, customer.user); assert.equal(String(second._id), first.data._id); assert.equal(await M.Booking.countDocuments(), 1);
  await assert.rejects(() => S.mutateBooking(store, first.data._id, { action: 'HANDOVER', operationId: op(), revision: second.revision, assetIds: [] }, admin.user._id), /full rent\/deposit/i);
  const mine = await request('/api/rentals/bookings/' + first.data._id, { token: customer.token }); assert.equal(mine.status, 200); assert(mine.data.documents.invoice.number);
});
test('disabled pickup plan and invalid/outside/duplicate use days fail before creating a booking', async () => {
  const config = await S.readConfiguration(store); await S.saveConfiguration(store, { ...config, policy: { ...config.policy, paymentPlans: ['ADVANCE', 'FULL'] } });
  await assert.rejects(() => S.publicQuote(store, plan('PICKUP')), /payment plan/);
  for (const useDates of [[], ['2030-02-30'], ['2000-01-01'], [plan().useDates[0], plan().useDates[0]]]) await assert.rejects(() => S.publicQuote(store, { ...plan(), useDates }), /use day|use days/i);
  assert.equal(await M.Booking.countDocuments(), 0);
});
test('admin may approve full or partial cancellation refund without altering security or allowing a customer override', async () => {
  const b = await S.hold(store, await reviewed(plan('FULL')), customer.user);
  const paid = await S.recordCollection(store, String(b._id), { operationId: op(), revision: b.revision, method: 'CASH', reference: op(), amountPaise: 350000 }, admin.user._id);
  const requested = await S.requestChange(store, String(b._id), { type: 'CANCEL', note: 'Please cancel', operationId: op(), revision: paid.revision }, customer.user._id);
  const cancelled = await S.mutateBooking(store, String(b._id), { action: 'CANCEL', retainedRentalPaise: 25000, note: 'Agreed partial refund', operationId: op(), revision: requested.revision }, admin.user._id);
  assert.equal(cancelled.financial.refundablePaise, 325000); assert.equal(cancelled.requests[0].status, 'RESOLVED'); assert.equal(cancelled.status, 'CANCELLED');
  const denied = await request('/api/admin/rentals/bookings/' + b._id + '/operation', { method: 'POST', token: customer.token, body: { action: 'CANCEL', retainedRentalPaise: 0 } }); assert([403,404].includes(denied.status));
});

test('store-fault cancellation cannot retain rent and the accepted full refund releases the pieces', async () => {
  const b = await S.hold(store, await reviewed(plan('FULL')), customer.user);
  const paid = await S.recordCollection(store, String(b._id), { operationId: op(), revision: b.revision, method: 'CASH', reference: op(), amountPaise: 350000 }, admin.user._id);
  await assert.rejects(() => S.mutateBooking(store, String(b._id), { action: 'CANCEL', ownerFault: true, retainedRentalPaise: 25000, note: 'Store cannot fulfil', operationId: op(), revision: paid.revision }, admin.user._id), /full refund/i);
  const unchanged = await M.Booking.findById(b._id).lean();
  assert.equal(unchanged.status, 'CONFIRMED'); assert.equal(unchanged.revision, paid.revision);
  assert.equal(await M.Reservation.countDocuments({ bookingId: b._id, active: true }), 1);
  const cancelled = await S.mutateBooking(store, String(b._id), { action: 'CANCEL', ownerFault: true, retainedRentalPaise: 0, note: 'Store cannot fulfil; refund in full', operationId: op(), revision: paid.revision }, admin.user._id);
  assert.equal(cancelled.status, 'CANCELLED'); assert.equal(cancelled.adjustedRentalPaise, 0); assert.equal(cancelled.financial.refundablePaise, 350000);
  assert.equal(await M.Reservation.countDocuments({ bookingId: b._id, active: true }), 0);
});

test('rental price filters and sorting use rental rates before counting and paging', async () => {
  const expensive = await S.saveListing(store, { ...listing, _id: undefined, dailyRatePaise: 250000, title: 'Premium outfit' });
  assert.deepEqual((await S.catalogue(store, { sort: 'priceHighLow' })).rows.map(row => String(row._id)), [String(expensive._id), String(listing._id)]);
  const filtered = await S.catalogue(store, { minRent: '2000', maxRent: '3000' }); assert.equal(filtered.total, 1); assert.equal(String(filtered.rows[0]._id), String(expensive._id));
  await assert.rejects(() => S.catalogue(store, { minRent: '2000', maxRent: '1000' }), /Maximum daily rent/);
});

test('security timing follows the selected payment plan, and partial collections cannot become refundable-security forfeiture', async () => {
  const config = await S.readConfiguration(store); await S.saveConfiguration(store, { ...config, policy: { ...config.policy, depositTiming: 'PICKUP' } });
  const full = await S.publicQuote(store, plan('FULL')), pickup = await S.publicQuote(store, plan('PICKUP')), advance = await S.publicQuote(store, plan('ADVANCE'));
  assert.equal(full.quote.depositTiming, 'BOOKING'); assert.equal(full.quote.depositDueNowPaise, 200000);
  assert.equal(pickup.quote.depositTiming, 'PICKUP'); assert.equal(pickup.quote.depositDueNowPaise, 0);
  assert.equal(advance.quote.depositTiming, 'PICKUP'); assert.equal(advance.quote.dueNowPaise, 45000);
  const partial = { status: 'HELD', quote: full.quote, ledger: [{ kind: 'COLLECTION', amountPaise: 200000 }] };
  assert.equal(A.paidRent(partial), 0); assert.equal(A.finances(partial).depositHeldPaise, 200000);
});

test('staff rescheduling re-quotes explicit use days, retains free transit days, and rejects an unaccepted new total', async () => {
  const first = plan('PICKUP'), b = await S.hold(store, await reviewed(first), customer.user);
  const shifted = value => new Date(+new Date(value) + 8 * A.DAY).toISOString();
  const next = { pickupAt: shifted(first.pickupAt), returnDueAt: new Date(+new Date(shifted(first.returnDueAt)) + A.DAY).toISOString(), useDates: [new Date(Date.parse(first.useDates[0] + 'T12:00Z') + 8 * A.DAY).toISOString().slice(0, 10), new Date(Date.parse(first.useDates[0] + 'T12:00Z') + 9 * A.DAY).toISOString().slice(0, 10)], operationId: op(), revision: b.revision, acceptPricePaise: 350000 };
  await assert.rejects(() => S.reschedule(store, String(b._id), next, admin.user._id), /Explicitly accept/);
  assert.deepEqual((await M.Booking.findById(b._id).lean()).schedule.useDates, first.useDates);
  const updated = await S.reschedule(store, String(b._id), { ...next, operationId: op(), acceptPricePaise: 500000 }, admin.user._id);
  assert.equal(updated.schedule.days, 2); assert.equal(updated.schedule.custodyDays, 3); assert.deepEqual(updated.schedule.useDates, next.useDates);
  assert.equal(updated.quote.rentalPaise, 300000); assert.equal(updated.quote.paymentPlan, 'PICKUP'); assert.equal(updated.quote.dueNowPaise, 0);
});
