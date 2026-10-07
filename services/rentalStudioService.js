const M = require('../models/Rental');
const A = require('./rentalAlgorithms');
const X = require('./rentalStudioAlgorithms');
const { ApiError } = require('../utils/apiError');
const S = () => require('./rentalService');
const fail = (message, code = 'VALIDATION_ERROR') => { throw new ApiError(code, message); };
const openTasks = ['OPEN', 'IN_PROGRESS', 'AWAITING_FITTING'];
const liveReservation = () => ({ active: true, $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] });
async function scheduleTrial(store, b, input, session) {
  if (!['HELD', 'CONFIRMED', 'PREPARING'].includes(b.status) || (b.status === 'HELD' && +b.expiresAt <= Date.now())) fail('Schedule a trial before preparation is complete, on an active booking.');
  if (b.trial?.status === 'ATTENDED') fail('Complete the current fitting before scheduling another trial.');
  const current = await S().readConfiguration(store);
  const policy = { ...A.DEFAULT_POLICY, ...b.policy, trialMinutes: current.policy.trialMinutes };
  const window = X.trialWindow(input, policy);
  if (+window.until > +b.schedule.pickupAt) fail('Trial and fitting must finish before rental pickup.');
  const assetIds = input.assetIds || b.allocations.map(a => String(a.assetId));
  if (!Array.isArray(assetIds) || !assetIds.length || new Set(assetIds).size !== assetIds.length || assetIds.some(id => !b.allocations.some(a => String(a.assetId) === id))) fail('Choose trial pieces allocated to this booking.');
  const assets = await M.Asset.find({ storeId: store._id, _id: { $in: assetIds } }).session(session).lean();
  if (assets.length !== assetIds.length || assets.some(a => a.saleConversion || !['READY', 'OUT'].includes(a.status) || (a.status === 'OUT' && (!a.returnDueAt || +a.returnDueAt <= Date.now() || +a.returnDueAt > +window.at)))) fail('One or more trial pieces are unavailable.', 'OUT_OF_STOCK');
  if (await M.Reservation.exists({ storeId: store._id, assetId: { $in: assetIds }, bookingId: { $ne: b._id }, ...liveReservation(),
    blockedFrom: { $lt: window.until }, blockedUntil: { $gt: window.at } }).session(session)) fail('The outfit is reserved or under maintenance at this trial time.', 'OUT_OF_STOCK');
  const work = await M.Task.find({ storeId: store._id, assetId: { $in: assetIds }, status: { $in: openTasks } }).session(session).lean();
  if (work.some(task => task.type !== 'ALTERATION' || String(task.bookingId) !== String(b._id) || +new Date(task.dueAt) > +window.at)) fail('Workshop work must be ready by this trial time.');
  // Capacity applies over the entire trial, not just its start minute.
  const capacity = await M.Booking.countDocuments({ storeId: store._id, _id: { $ne: b._id }, status: { $in: ['HELD', 'CONFIRMED', 'PREPARING', 'READY', 'OUT'] },
    $and: [{ $or: [
      { 'schedule.pickupAt': { $gte: window.at, $lt: window.until } },
      { 'schedule.returnDueAt': { $gte: window.at, $lt: window.until } },
      { 'trial.at': { $lt: window.until }, 'trial.until': { $gt: window.at }, 'trial.status': { $in: ['SCHEDULED', 'ATTENDED'] } },
      { 'trial.at': { $gte: window.at, $lt: window.until }, 'trial.status': { $exists: false } },
    ] }, { $or: [{ status: { $ne: 'HELD' } }, { expiresAt: { $gt: new Date() } }] }] }).session(session);
  if (capacity >= policy.slotCapacity) fail('The trial slot is full.', 'OUT_OF_STOCK');
  if ((b.trialHistory || []).length >= 100) fail('Trial history needs owner review before another appointment.');
  if (b.trial?.at) b.trialHistory.push(b.trial.toObject ? b.trial.toObject() : { ...b.trial });
  await M.Reservation.updateMany({ storeId: store._id, bookingId: b._id, kind: 'TRIAL' }, { $set: { active: false } }, { session });
  await M.Reservation.insertMany(assetIds.map(assetId => ({ storeId: store._id, bookingId: b._id, assetId,
    blockedFrom: window.at, blockedUntil: window.until, kind: 'TRIAL', ...(b.status === 'HELD' ? { expiresAt: b.expiresAt } : {}) })), { session });
  b.trial = { at: window.at, until: window.until, assetIds, status: 'SCHEDULED', scheduledOperationId: input.operationId,
    notes: A.text(input.note || '', 1000), measurements: A.text(input.measurements || '', 1000) };
}
async function updateTrial(store, b, input, session) {
  if (!b.trial?.at || ['CANCELLED', 'EXPIRED', 'CLOSED'].includes(b.status)) fail('There is no active trial to update.');
  const status = b.trial.status || 'SCHEDULED', until = b.trial.until || new Date(+b.trial.at + (b.policy.slotMinutes || 60) * 60000);
  const transitions = { SCHEDULED: ['ATTENDED', 'NO_SHOW', 'CANCELLED'], ATTENDED: ['FITTING_COMPLETED'], REVIEW: ['CANCELLED'] };
  if (!transitions[status]?.includes(input.status) || !input.note) fail('Choose a valid trial outcome and record a note.');
  if (input.status === 'ATTENDED') {
    if (Date.now() < +b.trial.at || Date.now() >= +until) fail('Attendance must be recorded within the reserved trial period.');
    const ids = b.trial.assetIds?.length ? b.trial.assetIds : b.allocations.map(a => a.assetId);
    const pendingWork = await M.Task.find({ storeId: store._id, assetId: { $in: ids }, status: { $in: openTasks } }).session(session).lean();
    if (pendingWork.some(task => task.type !== 'ALTERATION' || task.status !== 'AWAITING_FITTING' || String(task.bookingId) !== String(b._id))) fail('The alteration must reach awaiting-fitting, or other workshop work must be completed, before attendance.');
    const assets = await M.Asset.find({ storeId: store._id, _id: { $in: ids } }).session(session).lean();
    if (assets.length !== ids.length || assets.some(a => a.status !== 'READY' || a.currentBookingId || a.saleConversion)) fail('Physically verify that every trial piece is ready at the store.');
    b.trial.attendedAt = new Date();
  }
  if (input.status === 'NO_SHOW' && Date.now() < +until) fail('Record a trial no-show only after its reserved period.');
  if (input.status === 'FITTING_COMPLETED') b.trial.completedAt = new Date();
  b.trial.status = input.status; b.trial.notes = A.text(input.note, 1000);
  if (input.status !== 'ATTENDED') await M.Reservation.updateMany({ storeId: store._id, bookingId: b._id, kind: 'TRIAL' }, { $set: { active: false } }, { session });
}
async function assertWorkComplete(store, b, assetId, session, bookingOnly = false) {
  if (b.trial?.status === 'ATTENDED') fail('Complete the active fitting before handover or stock release.');
  if (await M.Task.exists({ storeId: store._id, ...(bookingOnly ? { bookingId: b._id } : {}), assetId: assetId || { $in: b.allocations.map(a => a.assetId) }, status: { $in: openTasks } }).session(session)) fail('Complete or explicitly cancel pending piece work before marking ready, handover or release.');
}
async function assertChangeSafe(store, b, session) {
  if (b.trial?.at && ['SCHEDULED', 'ATTENDED'].includes(b.trial.status || 'SCHEDULED')) fail('Complete or cancel the trial before changing booking dates or pieces.');
  if (await M.Task.exists({ storeId: store._id, bookingId: b._id, status: { $in: openTasks } }).session(session)) fail('Resolve the booking’s workshop jobs before changing dates or pieces.');
}
async function cancelWork(store, b, session, actorId) {
  if (b.trial?.at) b.trial.status = 'CANCELLED';
  const tasks = await M.Task.find({ storeId: store._id, bookingId: b._id, type: 'ALTERATION', status: { $in: openTasks } }).session(session);
  for (const task of tasks) { task.status = 'CANCELLED'; task.revision += 1; task.completedAt = new Date(); task.events.push({ type: 'CANCELLED', at: new Date(), actorId, note: 'Booking ended before handover; recorded incurred costs are retained.' }); await task.save({ session }); }
  await M.Reservation.updateMany({ storeId: store._id, bookingId: b._id, kind: { $in: ['TRIAL', 'TASK'] } }, { $set: { active: false } }, { session });
}
async function refreshRefundClock(b) {
  const p = X.refundPosition(b);
  if (!p.inspectionPending && p.refundablePaise + p.pendingPaise > 0 && !b.refundEligibleAt) {
    const config = await S().readConfiguration({ _id: b.storeId });
    b.refundEligibleAt = new Date(); b.refundDueAt = new Date(Date.now() + config.policy.refundSlaHours * A.HOUR);
  }
}
async function measurement(store, bookingId) {
  const b = await S().getBooking(store, bookingId);
  const config = await S().readConfiguration(store);
  const profile = await M.Measurement.findOne({ storeId: store._id, customerKey: X.customerKey(b) }).lean();
  return { enabled: config.policy.measurementProfilesEnabled, profile: profile ? { _id: profile._id, revision: profile.revision, versions: profile.versions } : null };
}
async function saveMeasurement(store, bookingId, input, actorId) {
  A.operation(input.operationId);
  return S().transaction(store, async session => {
    const b = await S().getBooking(store, bookingId, session);
    const config = await S().readConfiguration(store);
    if (!config.policy.measurementProfilesEnabled) fail('Enable customer measurement profiles in Rental settings.');
    if (!['CONFIRMED', 'PREPARING'].includes(b.status)) fail('Save or approve fitting measurements before the booking is marked ready.');
    const key = X.customerKey(b);
    let profile = await M.Measurement.findOne({ storeId: store._id, customerKey: key }).session(session);
    const old = profile?.versions.find(v => v.operationId === input.operationId);
    if (old) { if (old.fingerprint !== X.fingerprint(input)) fail('This measurement operation belongs to different details.'); return { profile: { _id: profile._id, revision: profile.revision, versions: profile.versions }, booking: S().present(b) }; }
    if ((profile?.revision || 0) !== input.revision) fail('Measurements changed. Reload the latest profile.');
    if (!profile) profile = new M.Measurement({ storeId: store._id, customerKey: key, userId: b.userId });
    if (profile.versions.length >= 100) fail('Measurement history has reached its safe limit.');
    if (input.consent !== true) fail('Record customer consent before saving body measurements.');
    const measuredAt = A.date(input.measuredAt);
    if (+measuredAt > Date.now()) fail('Measurement date cannot be in the future.');
    if (!['DRAFT', 'APPROVED'].includes(input.status)) fail('Choose draft or explicitly approved measurements.');
    if (input.status === 'APPROVED' && input.customerApproved !== true) fail('Record the customer’s explicit fitting approval.');
    const version = { operationId: input.operationId, fingerprint: X.fingerprint(input), number: profile.revision + 1,
      unit: input.unit, values: X.measurementValues(input), measuredAt, notes: A.text(input.notes || '', 1000),
      status: input.status, consentAt: new Date(), actorId, at: new Date(), ...(input.status === 'APPROVED' ? { approvedAt: new Date() } : {}) };
    profile.versions.push(version); profile.revision += 1; await profile.save({ session });
    if (version.status === 'APPROVED') b.measurementSnapshot = { ...version, profileId: profile._id };
    await S().event(b, 'MEASUREMENTS_' + input.status, { ...input, note: 'Private customer measurement revision recorded.' }, actorId, session);
    return { profile: { _id: profile._id, revision: profile.revision, versions: profile.versions }, booking: S().present(b) };
  });
}
function taskView(task, costs = false) {
  const value = task.toObject ? task.toObject() : { ...task };
  delete value.fingerprint;
  if (!costs) { delete value.actualCostPaise; delete value.estimatedCostPaise; delete value.costEvents; value.events = (value.events || []).map(({ actualCostPaise, estimatedCostPaise, ...e }) => e); }
  value.overdue = openTasks.includes(value.status) && +new Date(value.dueAt) < Date.now();
  return value;
}
async function tasks(store, query = {}, costs = false) {
  const page = A.integer(Number(query.page || 1), 'page', 1, 10000), filter = { storeId: store._id };
  if (query.bookingId) { await S().getBooking(store, A.id(query.bookingId)); filter.bookingId = query.bookingId; }
  if (query.status) { if (![...openTasks, 'COMPLETED', 'CANCELLED'].includes(query.status)) fail('Choose a supported workshop status.'); filter.status = query.status; }
  if (query.overdue === 'true') { filter.status = { $in: openTasks }; filter.dueAt = { $lt: new Date() }; }
  const [rows, total] = await Promise.all([M.Task.find(filter).sort({ dueAt: 1, _id: 1 }).skip((page - 1) * 30).limit(30).lean(), M.Task.countDocuments(filter)]);
  const assets = await M.Asset.find({ storeId: store._id, _id: { $in: rows.map(t => t.assetId) } }).select('_id code label').lean();
  const byId = new Map(assets.map(a => [String(a._id), a]));
  return { rows: rows.map(t => ({ ...taskView(t, costs), piece: byId.get(String(t.assetId)) })), page, pages: Math.ceil(total / 30), total };
}
async function createTask(store, input, actorId, costs = false) {
  A.operation(input.operationId); A.id(input.assetId);
  if (!costs && (input.estimatedCostPaise || input.actualCostPaise)) fail('Acquisition/expense access is required to record task costs.', 'FORBIDDEN');
  return S().transaction(store, async session => {
    const old = await M.Task.findOne({ storeId: store._id, operationId: input.operationId }).session(session);
    if (old) { if (old.fingerprint !== X.fingerprint(input)) fail('This task attempt belongs to different work.'); return taskView(old, costs); }
    const config = await S().readConfiguration(store);
    if (!['ALTERATION', 'CLEANING', 'REPAIR'].includes(input.type) || !(input.type === 'ALTERATION' ? config.policy.tailoringEnabled : config.policy.maintenanceTasksEnabled)) fail('Enable the selected workshop module in Rental settings.');
    const asset = await M.Asset.findOne({ storeId: store._id, _id: input.assetId }).session(session);
    if (!asset || asset.saleConversion || ['OUT', 'LOST', 'RETIRED'].includes(asset.status)) fail('Choose a physical piece available for workshop work.');
    if (input.type === 'ALTERATION' && (asset.status !== 'READY' || asset.currentBookingId)) fail('Finish the previous return/inspection before altering this piece for another customer.');
    if (input.type === 'ALTERATION' && asset.fitProfile?.alterationsAllowed === false) fail('This physical piece is marked as not alterable. Review its measurement/alteration policy before creating a tailoring job.');
    const dueAt = A.date(input.dueAt);
    if (+dueAt <= Date.now() || +dueAt > Date.now() + 365 * A.DAY) fail('Choose a workshop deadline within the next year.');
    let b;
    if (input.bookingId) {
      b = await S().getBooking(store, input.bookingId, session);
      if (!b.allocations.some(a => String(a.assetId) === input.assetId)) fail('This piece does not belong to the selected booking.');
      if (input.type === 'ALTERATION' && (!['CONFIRMED', 'PREPARING'].includes(b.status) || +dueAt > +b.schedule.pickupAt)) fail('Alteration must finish before pickup on a confirmed/preparing booking.');
      if (input.type !== 'ALTERATION' && (!b.allocations.some(a => String(a.assetId) === input.assetId && a.receivedAt && !a.readyAt && a.disposition === input.type) || asset.status !== input.type)) fail('Inspect the returned piece and record its matching cleaning/repair disposition before assigning work.');
    } else if (input.type === 'ALTERATION' || asset.currentBookingId) fail('Link alteration or assigned-return work to its booking.');
    if (b?.trial?.at && ['SCHEDULED', 'ATTENDED'].includes(b.trial.status || 'SCHEDULED') && +b.trial.at < +dueAt) fail('Complete or cancel the conflicting trial before workshop work.');
    if (await M.Task.exists({ storeId: store._id, assetId: asset._id, status: { $in: openTasks } }).session(session)) fail('This piece already has unfinished workshop work.');
    if (await M.Reservation.exists({ storeId: store._id, assetId: asset._id, ...(b ? { bookingId: { $ne: b._id } } : {}), ...liveReservation(),
      blockedFrom: { $lt: dueAt }, blockedUntil: { $gt: new Date() } }).session(session)) fail('This work deadline conflicts with another reservation.', 'OUT_OF_STOCK');
    const instructions = A.text(input.instructions || '', 2000), assignee = A.text(input.assignee || '', 120);
    if (!instructions || !assignee) fail('Assign a person/vendor and describe the required work.');
    const task = new M.Task({ storeId: store._id, assetId: asset._id, bookingId: b?._id, operationId: input.operationId,
      fingerprint: X.fingerprint(input), type: input.type, assignee, instructions, dueAt, createdBy: actorId,
      estimatedCostPaise: A.integer(input.estimatedCostPaise || 0, 'estimated task cost'),
      events: [{ type: 'CREATED', at: new Date(), actorId }] });
    await task.save({ session });
    await M.Reservation.create([{ storeId: store._id, assetId: asset._id, bookingId: b?._id, taskId: task._id,
      blockedFrom: new Date(), blockedUntil: dueAt, kind: 'TASK' }], { session });
    if (input.type !== 'ALTERATION') { asset.status = input.type; asset.revision += 1; await asset.save({ session }); }
    if (b) { b.workshopUsed = true; await S().event(b, 'WORKSHOP_CREATED', { operationId: input.operationId, note: input.type + ' workshop job created.' }, actorId, session); }
    return taskView(task, costs);
  });
}
async function updateTask(store, taskId, input, actorId, costs = false) {
  A.operation(input.operationId);
  if (!costs && input.actualCostPaise !== undefined) fail('Expense access is required to record costs.', 'FORBIDDEN');
  return S().transaction(store, async session => {
    const task = await M.Task.findOne({ storeId: store._id, _id: A.id(taskId) }).session(session);
    if (!task) fail('Workshop task not found.', 'NOT_FOUND');
    const previous = task.events.find(e => e.operationId === input.operationId);
    if (previous) { if (previous.fingerprint !== X.fingerprint(input)) fail('This task operation belongs to different changes.'); return taskView(task, costs); }
    if (task.revision !== input.revision || !openTasks.includes(task.status)) fail('Reload the task; this work is already completed/cancelled or has changed.');
    if (task.events.length >= 100) fail('Task history has reached its safe limit.');
    const transitions = { OPEN: ['IN_PROGRESS', 'CANCELLED'], IN_PROGRESS: ['AWAITING_FITTING', 'COMPLETED', 'CANCELLED'], AWAITING_FITTING: ['IN_PROGRESS', 'COMPLETED', 'CANCELLED'] };
    if (!transitions[task.status].includes(input.status) || !input.note) fail('Choose a valid task transition and record a note.');
    if (input.status === 'AWAITING_FITTING' && task.type !== 'ALTERATION') fail('Only alterations need fitting approval.');
    if (input.status === 'COMPLETED' && task.type === 'ALTERATION' && input.fittingApproved !== true) fail('Record explicit fitting approval before completing an alteration.');
    if (input.status === 'COMPLETED' && task.type !== 'ALTERATION' && input.verified !== true) fail('Verify the completed cleaning/repair before closing the task.');
    if (input.actualCostPaise !== undefined) {
      const value = A.integer(input.actualCostPaise, 'actual task cost'), delta = value - task.actualCostPaise;
      if (delta) { task.costEvents.push({ deltaPaise: delta, at: new Date(), actorId, note: A.text(input.note, 1000) }); task.costRecordedAt = new Date(); }
      task.actualCostPaise = value;
    }
    if (input.status === 'IN_PROGRESS' && !task.startedAt) task.startedAt = new Date();
    task.status = input.status; task.revision += 1;
    if (input.status === 'COMPLETED' || input.status === 'CANCELLED') {
      task.completedAt = new Date();
      if (input.fittingApproved === true) task.fittingApprovedAt = new Date();
      await M.Reservation.updateMany({ storeId: store._id, taskId: task._id }, { $set: { active: false } }, { session });
      // Returned pieces still require the original inspection/release operation.
      if (input.status === 'COMPLETED' && !task.bookingId) await M.Asset.updateOne({ storeId: store._id, _id: task.assetId, currentBookingId: null }, { $set: { status: 'READY' }, $inc: { revision: 1 } }, { session });
    }
    task.events.push({ operationId: input.operationId, fingerprint: X.fingerprint(input), type: input.status, note: A.text(input.note, 1000), at: new Date(), actorId });
    await task.save({ session });
    if (task.bookingId) { const b = await S().getBooking(store, task.bookingId, session); await S().event(b, 'WORKSHOP_' + input.status, { operationId: input.operationId, note: task.type + ' workshop status updated to ' + input.status + '.' }, actorId, session); }
    return taskView(task, costs);
  });
}
async function refundQueue(store, query = {}) {
  const config = await S().readConfiguration(store);
  if (!config.policy.refundDashboardEnabled) fail('Enable deposit refund monitoring in Rental settings.');
  const page = A.integer(Number(query.page || 1), 'page', 1, 10000), rows = [], summary = { total: 0, overdue: 0, refundablePaise: 0, pendingPaise: 0 };
  for await (const b of M.Booking.find({ storeId: store._id, status: { $in: ['RETURNED', 'CANCELLED', 'EXPIRED', 'CLOSED'] }, 'ledger.kind': 'COLLECTION' }).sort({ refundDueAt: 1, createdAt: 1 }).lean().cursor()) {
    const position = X.refundPosition(b);
    if (!position.refundablePaise && !position.pendingPaise) continue;
    if (query.overdue === 'true' && !position.overdue) continue;
    summary.total += 1; summary.overdue += Number(position.overdue); summary.refundablePaise += position.refundablePaise; summary.pendingPaise += position.pendingPaise;
    if (summary.total > (page - 1) * 30 && rows.length < 30) rows.push({ _id: b._id, number: b.number, customer: b.customer.name, status: b.status, ...position });
  }
  return { rows, summary, page, pages: Math.ceil(summary.total / 30) };
}
module.exports = { openTasks, scheduleTrial, updateTrial, assertWorkComplete, assertChangeSafe, cancelWork, refreshRefundClock,
  measurement, saveMeasurement, taskView, tasks, createTask, updateTask, refundQueue };
