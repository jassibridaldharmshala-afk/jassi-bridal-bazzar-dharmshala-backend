const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startTestEnvironment, stopTestEnvironment, resetDatabase, request } = require('./helpers');
const { createCustomer, createAdmin, createProduct } = require('./factories');
const { ensureDefaultStore } = require('../services/storeService');
const Store = require('../models/Store');
const Product = require('../models/Product');
const M = require('../models/Rental');
const S = require('../services/rentalService');
const A = require('../services/rentalAlgorithms');
const Studio = require('../services/rentalStudioService');
const Available = require('../services/rentalAvailabilityService');
const Worker = require('../services/rentalStudioWorker');
const Delivery = require('../services/rentalWorker');
const Reporting = require('../services/rentalPieceReportingService');
const op = () => 'studio_' + crypto.randomUUID();
const at = (day, hour = '10') => new Date(Date.now() + day * A.DAY).toISOString().slice(0, 10) + 'T' + hour + ':00:00+05:30';
const dates = day => ({ pickupAt: at(day), returnDueAt: at(day + 2) });
let store, admin, customer, product, listing, asset;
before(startTestEnvironment); after(stopTestEnvironment);
beforeEach(async () => {
  await resetDatabase(); store = await ensureDefaultStore(); admin = await createAdmin(); customer = await createCustomer();
  product = await createProduct({ storeId: store._id, commerceMode: 'SALE_AND_RENTAL' });
  await S.saveConfiguration(store, { revision: 0, mode: 'SALE_AND_RENTAL', policy: { ...A.DEFAULT_POLICY, measurementProfilesEnabled: true, tailoringEnabled: true, maintenanceTasksEnabled: true, dateFirstEnabled: true, refundDashboardEnabled: true, piecePerformanceEnabled: true, waitlistEnabled: true } });
  listing = await S.saveListing(store, { productId: String(product._id), title: 'Studio lehenga', dailyRatePaise: 100000, depositPaise: 500000, active: true, requirements: [{ poolKey: 'studio', label: 'Lehenga', quantity: 1 }] });
  asset = await S.saveAsset(store, { poolKey: 'studio', code: 'STUDIO-001', label: 'Lehenga', costPaise: 300000 });
});
async function hold(day = 7, user = customer.user) {
  const config = await S.readConfiguration(store), input = { ...dates(day), items: [{ listingId: String(listing._id), quantity: 1 }], attemptId: op(), policyRevision: config.revision, acceptTerms: true };
  const quote = await S.publicQuote(store, input);
  return S.hold(store, { ...input, quoteFingerprint: quote.quoteFingerprint }, user);
}
async function collect(b) { return S.recordCollection(store, b._id, { operationId: op(), revision: b.revision, amountPaise: b.quote.totalPaise, method: 'CASH', reference: op() }, admin.user._id); }
const action = (b, action, extra = {}) => S.mutateBooking(store, b._id, { operationId: op(), revision: b.revision, action, ...extra }, admin.user._id);
const work = (b, extra = {}) => Studio.createTask(store, { operationId: op(), bookingId: String(b._id), assetId: String(asset._id), type: 'ALTERATION', assignee: 'Tailor', instructions: 'Reversible hem adjustment', dueAt: at(3), estimatedCostPaise: 10000, ...extra }, admin.user._id, true);
const updateWork = (task, status, extra = {}) => Studio.updateTask(store, task._id, { operationId: op(), revision: task.revision, status, note: 'Verified work update', ...extra }, admin.user._id, true);
test('trial rejects the reproduced outfit conflict and preserves the original booking', async () => {
  await collect(await hold(3)); const b = await collect(await hold(10));
  await assert.rejects(() => action(b, 'TRIAL', { at: at(3, '11') }), /reserved/);
  assert.equal((await S.getBooking(store, b._id)).trial?.at, undefined);
  assert.equal(await M.Reservation.countDocuments({ kind: 'TRIAL' }), 0);
});
test('concurrent trials on one physical piece create exactly one reservation', async () => {
  const first = await collect(await hold(7)), second = await collect(await hold(12));
  const results = await Promise.allSettled([action(first, 'TRIAL', { at: at(3) }), action(second, 'TRIAL', { at: at(3) })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(await M.Reservation.countDocuments({ kind: 'TRIAL', active: true }), 1);
});
test('trial reservations block sale-period rentals; cancellation releases only the trial', async () => {
  let b = await collect(await hold(10)); b = await action(b, 'TRIAL', { at: at(3) });
  await assert.rejects(() => hold(3), /unavailable/);
  b = await action(b, 'TRIAL_UPDATE', { status: 'CANCELLED', note: 'Customer changed fitting plans' });
  assert.equal(await M.Reservation.countDocuments({ bookingId: b._id, kind: 'BOOKING', active: true }), 1);
  assert.equal(await M.Reservation.countDocuments({ bookingId: b._id, kind: 'TRIAL', active: true }), 0);
  assert.ok(await hold(3));
});
test('attendance requires ready pieces, final fitting releases its reservation and private data stays private', async () => {
  let b = await collect(await hold(7)); b = await action(b, 'TRIAL', { at: at(3), measurements: 'Private fitting detail' });
  await assert.rejects(() => action(b, 'TRIAL_UPDATE', { status: 'ATTENDED', note: 'Arrived' }), /reserved trial period/);
  await M.Booking.updateOne({ _id: b._id }, { $set: { 'trial.at': new Date(Date.now() - 60000), 'trial.until': new Date(Date.now() + 3600000) } });
  b = S.present(await S.getBooking(store, b._id));
  b = await action(b, 'TRIAL_UPDATE', { status: 'ATTENDED', note: 'Physical pieces verified' });
  b = await action(b, 'TRIAL_UPDATE', { status: 'FITTING_COMPLETED', note: 'Fitting completed with customer' });
  assert.equal(b.trial.status, 'FITTING_COMPLETED');
  assert.equal(await M.Reservation.countDocuments({ bookingId: b._id, kind: 'TRIAL', active: true }), 0);
  const publicView = S.present(b, { staff: false });
  assert.equal(publicView.trial.measurements, undefined); assert.equal(publicView.trialHistory, undefined);
});
test('trial reminders are deduplicated and stale/cancelled reminders are skipped', async () => {
  let b = await collect(await hold(7)); b = await action(b, 'TRIAL', { at: at(3) });
  await M.Configuration.updateOne({ storeId: store._id }, { $set: { 'policy.trialReminderHours': 168 } });
  b = await action(b, 'READY'); // Ready preparation must not suppress a future fitting appointment.
  await Worker.reminders(store); await Worker.reminders(store);
  assert.equal(await M.Job.countDocuments({ bookingId: b._id, event: 'TRIAL_DUE' }), 6);
  const job = await M.Job.findOne({ bookingId: b._id, event: 'TRIAL_DUE', channel: 'IN_APP' }).lean();
  assert.equal((await Delivery.deliver(job)).messageId, 'in-app');
  b = await action(b, 'TRIAL_UPDATE', { status: 'CANCELLED', note: 'Cancel appointment' });
  assert.ok((await Delivery.deliver(job)).skipped);
});
test('measurements are consented, immutable revisions with an explicit approved booking snapshot', async () => {
  const b = await collect(await hold());
  const input = { operationId: op(), revision: 0, unit: 'in', values: { waist: 32.34, bust: 36 }, measuredAt: new Date(Date.now() - 60000).toISOString(), notes: 'Private', status: 'APPROVED', customerApproved: true };
  await assert.rejects(() => Studio.saveMeasurement(store, b._id, input, admin.user._id), /consent/);
  const result = await Studio.saveMeasurement(store, b._id, { ...input, consent: true }, admin.user._id);
  const retry = await Studio.saveMeasurement(store, b._id, { ...input, consent: true }, admin.user._id);
  assert.equal(result.profile.revision, 1); assert.equal(retry.profile.versions.length, 1);
  assert.equal(result.booking.measurementSnapshot.values.waist, 32.34);
  await assert.rejects(() => Studio.saveMeasurement(store, b._id, { ...input, consent: true, values: { waist: 30 } }, admin.user._id), /different details/);
  const draft = await Studio.saveMeasurement(store, b._id, { ...input, consent: true, operationId: op(), revision: 1, status: 'DRAFT', values: { waist: 33 } }, admin.user._id);
  assert.equal(draft.booking.measurementSnapshot.values.waist, 32.34);
  assert.equal(S.present(draft.booking, { staff: false }).measurementSnapshot, undefined);
  const other = await Store.create({ name: 'Foreign', slug: 'foreign' });
  await assert.rejects(() => Studio.measurement(other, b._id), /not found/);
});
test('alteration jobs block readiness until fitting approval and remain manageable when feature is disabled', async () => {
  let b = await collect(await hold()), task = await work(b);
  b = S.present(await S.getBooking(store, b._id));
  await assert.rejects(() => action(b, 'READY'), /pending piece work/);
  task = await updateWork(task, 'IN_PROGRESS');
  await assert.rejects(() => updateWork(task, 'COMPLETED'), /fitting approval/);
  await M.Configuration.updateOne({ storeId: store._id }, { $set: { 'policy.tailoringEnabled': false } });
  task = await updateWork(task, 'COMPLETED', { fittingApproved: true, actualCostPaise: 15000 });
  assert.equal(task.actualCostPaise, 15000);
  b = S.present(await S.getBooking(store, b._id)); b = await action(b, 'READY');
  assert.equal(b.status, 'READY'); assert.equal((await Product.findById(product._id)).stock, product.stock);
});
test('task changes are idempotent, cost-protected and cannot bypass stock readiness via piece status', async () => {
  const b = await collect(await hold()), task = await work(b);
  await assert.rejects(() => S.changeAsset(store, asset._id, { operationId: op(), revision: asset.revision, status: 'READY', note: 'Skip work' }, admin.user._id), /unfinished workshop/);
  const input = { operationId: op(), revision: task.revision, status: 'IN_PROGRESS', note: 'Private vendor discussion about fitting and costs', actualCostPaise: 5000 };
  await assert.rejects(() => Studio.updateTask(store, task._id, input, admin.user._id, false), /Expense access/);
  const saved = await Studio.updateTask(store, task._id, input, admin.user._id, true);
  assert.equal((await Studio.updateTask(store, task._id, input, admin.user._id, true)).revision, saved.revision);
  assert.equal((await Studio.tasks(store, {}, false)).rows[0].actualCostPaise, undefined);
  const hidden = Studio.taskView(await M.Task.findById(task._id).lean(), false); assert.equal(hidden.costEvents, undefined);
  const customerView = JSON.stringify(S.present(await S.getBooking(store, b._id), { staff: false }));
  assert.ok(!customerView.includes('Private vendor discussion'));
  assert.ok(!customerView.includes('assigned to Tailor'));
  await assert.rejects(() => Studio.createTask(store, { operationId: op(), assetId: String(asset._id), type: 'REPAIR', dueAt: at(20), instructions: 'Fix', assignee: 'Vendor' }, admin.user._id), /unfinished workshop/);
});
test('maintenance deadlines cannot overlap a reserved rental and standalone completion verifies readiness', async () => {
  await hold(7);
  await assert.rejects(() => Studio.createTask(store, { operationId: op(), assetId: String(asset._id), type: 'CLEANING', dueAt: at(8), instructions: 'Wash', assignee: 'Cleaner' }, admin.user._id), /conflicts/);
  let task = await Studio.createTask(store, { operationId: op(), assetId: String(asset._id), type: 'CLEANING', dueAt: at(2), instructions: 'Wash', assignee: 'Cleaner' }, admin.user._id);
  assert.equal((await M.Asset.findById(asset._id)).status, 'CLEANING');
  task = await Studio.updateTask(store, task._id, { operationId: op(), revision: task.revision, status: 'IN_PROGRESS', note: 'Started' }, admin.user._id);
  await assert.rejects(() => Studio.updateTask(store, task._id, { operationId: op(), revision: task.revision, status: 'COMPLETED', note: 'Done' }, admin.user._id), /Verify/);
  await Studio.updateTask(store, task._id, { operationId: op(), revision: task.revision, status: 'COMPLETED', note: 'Checked', verified: true }, admin.user._id);
  assert.equal((await M.Asset.findById(asset._id)).status, 'READY');
});
test('refund clocks and escalation include pending-provider money without automatic financial mutations', async () => {
  let b = await collect(await hold()); b = await action(b, 'CANCEL', { note: 'Owner cannot supply', ownerFault: true });
  assert.ok(b.refundEligibleAt); assert.ok(b.refundDueAt);
  await M.Booking.updateOne({ _id: b._id }, { $set: { refundDueAt: new Date(Date.now() - A.HOUR) } });
  const queue = await Studio.refundQueue(store, {});
  assert.equal(queue.summary.overdue, 1); assert.equal(queue.rows[0].refundablePaise, b.quote.totalPaise);
  await Worker.reminders(store); await Worker.reminders(store);
  assert.equal(await M.Job.countDocuments({ event: 'REFUND_OVERDUE', audience: 'OWNER' }), 3);
  assert.equal(await M.Job.countDocuments({ event: 'REFUND_OVERDUE', audience: 'CUSTOMER' }), 0);
  assert.equal((await S.getBooking(store, b._id)).ledger.length, 1);
  await M.Configuration.updateOne({ storeId: store._id }, { $set: { 'policy.refundDashboardEnabled': false } });
  const queued = await M.Job.findOne({ event: 'REFUND_OVERDUE', channel: 'IN_APP' }).lean();
  assert.ok((await Delivery.deliver(queued)).skipped);
});
test('date-first availability redacts allocations, offers alternate dates and rechecks final holds', async () => {
  const b = await hold(3);
  const page = await Available.availability(store, { ...dates(3) });
  assert.equal(page.rows[0].availability, 'UNAVAILABLE');
  const suggestions = await Available.alternatives(store, listing._id, dates(3));
  assert.ok(suggestions.nextDates.length > 0);
  const available = await Available.availability(store, { ...dates(10) });
  assert.equal(available.rows[0].availability, 'AVAILABLE');
  assert.equal(available.rows[0].quoted.allocations, undefined);
  const slotRows = await Available.slots(store, { date: at(10).slice(0, 10) });
  assert.ok(slotRows.rows.every(row => row.time && row.capacityLeft <= A.DEFAULT_POLICY.slotCapacity));
  await action(b, 'CANCEL', { note: 'No longer needed', ownerFault: true });
  assert.equal((await Available.availability(store, dates(3))).rows[0].availability, 'AVAILABLE');
});

test('matching alternatives retain public rate/deposit details when added to the rental bag', async () => {
  const alternateProduct = await createProduct({ storeId: store._id, commerceMode: 'SALE_AND_RENTAL', category: product.category });
  const alternate = await S.saveListing(store, { productId: String(alternateProduct._id), title: 'Alternative outfit', dailyRatePaise: 150000, depositPaise: 400000, active: true, requirements: [{ poolKey: 'alternate', label: 'Dress', quantity: 1 }] });
  await S.saveAsset(store, { poolKey: 'alternate', code: 'ALT-001', label: 'Dress' });
  await collect(await hold(3));
  const suggestions = await Available.alternatives(store, listing._id, dates(3));
  const match = suggestions.matches.find(row => String(row._id) === String(alternate._id));
  assert.equal(match.dailyRatePaise, 150000); assert.equal(match.depositPaise, 400000);
  assert.equal(match.requirements, undefined); assert.equal(match.allocations, undefined);
  assert.ok(match.totalPaise > match.depositPaise);
});
test('waitlist notifications do not reserve stock or collect advance and stale alerts return to waiting', async () => {
  let occupied = await collect(await hold(3));
  const input = { ...dates(3), items: [{ listingId: String(listing._id), quantity: 1 }], operationId: op(), consent: true };
  const row = await Available.joinWaitlist(store, input, customer.user);
  assert.equal((await Available.joinWaitlist(store, input, customer.user))._id.toString(), row._id.toString());
  await Worker.reminders(store); assert.equal((await M.Waitlist.findById(row._id)).status, 'WAITING');
  occupied = await action(occupied, 'CANCEL', { note: 'Released', ownerFault: true });
  await M.Waitlist.updateOne({ _id: row._id }, { $set: { nextCheckAt: new Date(0) } });
  await Worker.reminders(store); await Worker.reminders(store);
  assert.equal((await M.Waitlist.findById(row._id)).status, 'NOTIFIED');
  assert.equal(await M.Reservation.countDocuments({ active: true }), 0);
  assert.equal(await M.Booking.countDocuments(), 1);
  assert.equal(await M.Job.countDocuments({ event: 'WAITLIST_AVAILABLE' }), 3);
  const job = await M.Job.findOne({ event: 'WAITLIST_AVAILABLE', channel: 'IN_APP' }).lean();
  await hold(3);
  assert.ok((await Delivery.deliver(job)).skipped);
  assert.equal((await M.Waitlist.findById(row._id)).status, 'WAITING');
});
test('customer waitlist ownership, cancellation, duplicate details and consent are protected', async () => {
  const input = { ...dates(3), items: [{ listingId: String(listing._id), quantity: 1 }], operationId: op() };
  await assert.rejects(() => Available.joinWaitlist(store, input, customer.user), /explicitly request/);
  const row = await Available.joinWaitlist(store, { ...input, consent: true }, customer.user);
  await assert.rejects(() => Available.joinWaitlist(store, { ...input, consent: true, operationId: op() }, customer.user), /already have/);
  const stranger = await createCustomer({ phone: '+919999999992' });
  assert.equal((await request('/api/rentals/waitlist/' + row._id, { token: stranger.token })).status, 404);
  const cancelled = await Available.cancelWaitlist(store, row._id, { revision: row.revision }, customer.user._id);
  assert.equal(cancelled.status, 'CANCELLED');
  const other = await Store.create({ name: 'Other', slug: 'other' });
  await assert.rejects(() => Available.getWaitlist(other, row._id, customer.user._id), /not found/);
});
test('piece reports exclude deposits and reflect recorded expenses without duplicate period costs', async () => {
  let b = await collect(await hold()), task = await work(b);
  task = await updateWork(task, 'IN_PROGRESS', { actualCostPaise: 10000 });
  task = await updateWork(task, 'COMPLETED', { fittingApproved: true, actualCostPaise: 10000 });
  const stored = await M.Task.findById(task._id); assert.equal(stored.costEvents.length, 1);
  await M.Booking.updateOne({ _id: b._id }, { $set: { status: 'RETURNED', 'schedule.pickupAt': new Date(Date.now() - 2 * A.DAY), 'allocations.0.receivedAt': new Date(), 'allocations.0.disposition': 'CLEANING' } });
  const report = await Reporting.report(store, { from: new Date(Date.now() - 30 * A.DAY).toISOString(), to: new Date(Date.now() + A.HOUR).toISOString() });
  assert.equal(report.rows[0].rentalRevenuePaise, 200000);
  assert.equal(report.rows[0].expensesPaise, 10000);
  assert.equal(report.rows[0].operatingContributionPaise, 190000);
  assert.equal(report.rows[0].lifetimeRevenuePaise, 200000);
  assert.equal(report.rows[0].purchaseRecovered, false);
});
test('new staff APIs reject customer mutations and cross-store measurements/tasks', async () => {
  const b = await collect(await hold());
  for (const path of ['/api/admin/rentals/tasks', '/api/admin/rentals/refund-queue', '/api/admin/rentals/bookings/' + b._id + '/measurements']) assert.equal((await request(path, { token: customer.token })).status, 403);
  const other = await Store.create({ name: 'Foreign store', slug: 'foreign-store' });
  await assert.rejects(() => Studio.createTask(other, { operationId: op(), assetId: String(asset._id), type: 'REPAIR', dueAt: at(3), assignee: 'Vendor', instructions: 'Fix' }, admin.user._id), /Enable/);
  assert.equal((await request('/api/admin/rentals/tasks', { token: admin.token })).status, 200);
});

test('existing trials are migrated to safe reservations or explicit owner review, never silently double-booked', async () => {
  await collect(await hold(3)); const blocked = await collect(await hold(10)), safe = await collect(await hold(15));
  await M.Booking.updateOne({ _id: blocked._id }, { $set: { 'trial.at': new Date(at(3)), 'trial.notes': 'Legacy appointment' } });
  await M.Booking.updateOne({ _id: safe._id }, { $set: { 'trial.at': new Date(at(7)), 'trial.notes': 'Legacy available appointment' } });
  await Worker.reminders(store); await Worker.reminders(store);
  assert.equal((await S.getBooking(store, blocked._id)).trial.status, 'REVIEW');
  assert.equal((await S.getBooking(store, safe._id)).trial.status, 'SCHEDULED');
  assert.equal(await M.Reservation.countDocuments({ bookingId: blocked._id, kind: 'TRIAL', active: true }), 0);
  assert.equal(await M.Reservation.countDocuments({ bookingId: safe._id, kind: 'TRIAL', active: true }), 1);
});

test('awaiting-fitting alterations can attend the trial and finish without a workflow deadlock', async () => {
  let b = await collect(await hold()), task = await work(b, { dueAt: at(2) });
  b = S.present(await S.getBooking(store, b._id));
  b = await action(b, 'TRIAL', { at: at(3) });
  task = await updateWork(task, 'IN_PROGRESS'); task = await updateWork(task, 'AWAITING_FITTING');
  await M.Booking.updateOne({ _id: b._id }, { $set: { 'trial.at': new Date(Date.now() - 60000), 'trial.until': new Date(Date.now() + A.HOUR) } });
  b = S.present(await S.getBooking(store, b._id));
  b = await action(b, 'TRIAL_UPDATE', { status: 'ATTENDED', note: 'Piece and customer present' });
  await assert.rejects(() => action(b, 'READY'), /active fitting/);
  b = await action(b, 'TRIAL_UPDATE', { status: 'FITTING_COMPLETED', note: 'Customer checked the final fit' });
  await updateWork(task, 'COMPLETED', { fittingApproved: true });
  b = S.present(await S.getBooking(store, b._id)); b = await action(b, 'READY');
  assert.equal(b.status, 'READY');
  assert.equal(await M.Reservation.countDocuments({ bookingId: b._id, active: true, kind: { $in: ['TASK', 'TRIAL'] } }), 0);
});

test('returned maintenance requires inspection, blocks release, and does not automatically restock the piece', async () => {
  let b = await collect(await hold());
  await M.Booking.updateOne({ _id: b._id }, { $set: { 'schedule.pickupAt': new Date(Date.now() - A.HOUR) } });
  b = S.present(await S.getBooking(store, b._id)); b = await action(b, 'READY');
  b = await action(b, 'HANDOVER', { assetIds: [String(asset._id)], note: 'All pieces checked' });
  b = await action(b, 'RECEIVE', { assetIds: [String(asset._id)] });
  const input = { operationId: op(), bookingId: String(b._id), assetId: String(asset._id), type: 'CLEANING', dueAt: at(2), instructions: 'Dry clean', assignee: 'Cleaner' };
  await assert.rejects(() => Studio.createTask(store, input, admin.user._id), /Inspect/);
  b = await action(b, 'INSPECT', { assetId: String(asset._id), disposition: 'CLEANING', note: 'Return condition checked' });
  let task = await Studio.createTask(store, input, admin.user._id);
  b = S.present(await S.getBooking(store, b._id));
  await assert.rejects(() => action(b, 'RELEASE', { assetId: String(asset._id), note: 'Skip cleaning' }), /pending piece work/);
  task = await updateWork(task, 'IN_PROGRESS'); await updateWork(task, 'COMPLETED', { verified: true });
  assert.equal((await M.Asset.findById(asset._id)).status, 'CLEANING');
  assert.equal((await M.Asset.findById(asset._id)).currentBookingId.toString(), String(b._id));
  b = S.present(await S.getBooking(store, b._id));
  await action(b, 'RELEASE', { assetId: String(asset._id), note: 'Physical cleaning verified' });
  assert.equal((await M.Asset.findById(asset._id)).status, 'READY');
  assert.equal((await Product.findById(product._id)).stock, product.stock);
});

test('actual-day earnings exclude unchanged service fees, tax and retained cancelled-line charges', async () => {
  await M.Configuration.updateOne({ storeId: store._id }, { $set: { 'policy.earlyReturnPolicy': 'ACTUAL_DAYS', 'policy.rentalTaxBasisPoints': 1800 } });
  await M.Listing.updateOne({ _id: listing._id }, { $set: { cleaningFeePaise: 20000 } });
  let b = await collect(await hold());
  await M.Booking.updateOne({ _id: b._id }, { $set: { 'schedule.pickupAt': new Date(Date.now() - A.HOUR), cancellationChargesPaise: 15000 } });
  b = S.present(await S.getBooking(store, b._id)); b = await action(b, 'READY');
  b = await action(b, 'HANDOVER', { assetIds: [String(asset._id)], note: 'All pieces checked' });
  b = await action(b, 'RECEIVE', { assetIds: [String(asset._id)] });
  assert.equal(b.adjustedRentalPaise, 135000);
  const report = await Reporting.report(store, { from: new Date(Date.now() - A.DAY).toISOString(), to: new Date(Date.now() + A.HOUR).toISOString() });
  assert.equal(report.rows[0].rentalRevenuePaise, Math.round(100000 / 1.18));
  assert.equal(report.rows[0].lifetimeRevenuePaise, Math.round(100000 / 1.18));
});

test('private measurement snapshots never leak through booking detail, lists or workspace to support-only staff', async () => {
  const b = await collect(await hold());
  await Studio.saveMeasurement(store, b._id, { operationId: op(), revision: 0, unit: 'in', values: { waist: 32 }, measuredAt: new Date(Date.now() - 60000).toISOString(), notes: 'Private body measurements', status: 'APPROVED', customerApproved: true, consent: true }, admin.user._id);
  const support = await createCustomer({ availableModes: ['customer', 'seller'], activeMode: 'seller' });
  await require('../models/StoreMember').create({ store: store._id, user: support.user._id, role: 'SUPPORT', status: 'ACTIVE' });
  const options = { token: support.token, headers: { 'x-store-id': String(store._id) } };
  for (const path of ['/api/seller/rentals', '/api/seller/rentals/bookings', '/api/seller/rentals/bookings/' + b._id]) {
    const result = await request(path, options); assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.ok(!JSON.stringify(result.data).includes('measurementSnapshot'));
    assert.ok(!JSON.stringify(result.data).includes('Private body measurements'));
  }
  assert.equal((await request('/api/seller/rentals/bookings/' + b._id + '/measurements', options)).status, 403);
  assert.equal((await request('/api/admin/rentals/bookings/' + b._id, { token: admin.token })).data.measurementSnapshot.values.waist, 32);
});
