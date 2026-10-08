const service = require('../services/rentalService');
const { asyncHandler } = require('../middleware/validate');
const { ApiError } = require('../utils/apiError');
const { isMasterOwner } = require('../config/masterOwner');
const { roleAllows } = require('../models/StoreMember');
const { logAudit } = require('../services/auditService');
const { id } = require('../services/rentalAlgorithms');
const { hasStoreFeature } = require('../config/storePlans');
function hasRentalReports(req) { return hasStoreFeature(req.store, 'analytics') && (!req.platformLicense?.managed || req.platformLicense.features?.includes('analytics')); }
function can(req, permission) { return isMasterOwner(req.user) || (req.store?.isDefault && req.user?.role === 'admin' && req.user?.activeMode === 'admin') || String(req.store?.owner || '') === String(req.user?._id || '') || roleAllows(req.storeMember?.role, permission); }
function assetFields(req, rows) { return rows.map(({ costPaise, measurements, fitProfile, ...asset }) => ({ ...asset, ...(can(req, 'inventory.cost.read') ? { costPaise } : {}), ...(can(req, 'inventory.write') ? { measurements, fitProfile } : {}) })); }
function bookingPrivacy(req, data) {
  if (can(req, 'inventory.write') && (isMasterOwner(req.user) || req.store?.catalogStructure?.clientPermissions?.inventory !== false)) return data;
  const redact = booking => {
    if (!booking || typeof booking !== 'object') return;
    delete booking.measurementSnapshot; delete booking.trialHistory;
    if (booking.trial) delete booking.trial.measurements;
  };
  redact(data); redact(data?.booking);
  for (const booking of data?.rows || []) redact(booking);
  for (const booking of data?.bookings?.rows || []) redact(booking);
  return data;
}
function staffPermission(permission, { ownerOnly = false } = {}) {
  return (req, _res, next) => {
    const user = req.user;
    const deploymentAdmin = req.store?.isDefault && user?.role === 'admin' && user.activeMode === 'admin';
    const owner = req.storeMember?.role === 'OWNER' || String(req.store?.owner || '') === String(user?._id || '');
    const member = !ownerOnly && roleAllows(req.storeMember?.role, permission);
    if (!req.store?._id || !user?.isPhoneVerified || user.offlineSession || !(deploymentAdmin || owner || member || isMasterOwner(user))) return next(new ApiError('FORBIDDEN', 'You do not have permission for this rental operation.'));
    const capability = permission.startsWith('inventory') ? 'inventory' : permission.startsWith('returns') ? 'returns' : permission.startsWith('reports') ? 'reports' : 'orders';
    if (!isMasterOwner(user) && req.store.catalogStructure?.clientPermissions?.[capability] === false) return next(new ApiError('FORBIDDEN', 'This capability is disabled by the platform owner.'));
    return next();
  };
}
const send = (res, data) => res.set('Cache-Control', 'private, no-store').json(data);
const write = (name, fn) => asyncHandler(async (req, res) => {
  const data = await fn(req);
  await logAudit({ req, action: `RENTAL_${name}`, entityType: 'Rental', entityId: req.params.id || data?._id || req.store._id, storeId: req.store._id, after: { operation: req.body?.action || name, revision: data?.revision } });
  send(res, bookingPrivacy(req, data));
});
exports.staffPermission = staffPermission;
exports.calendar = asyncHandler(async (req, res) => send(res, await require('../services/rentalCalendarService').calendar(req.store, req.params.id, req.query)));
exports.calendarSet = asyncHandler(async (req, res) => send(res, await require('../services/rentalCalendarService').calendarSet(req.store, req.body, { counter: req.rentalStaff === true })));
exports.setup = asyncHandler(async (req, res) => send(res, await require('../services/rentalSetupService').detail(req.store, req.params.id)));
exports.timeline = asyncHandler(async (req, res) => send(res, await require('../services/rentalOperationsService').timeline(req.store, req.query)));
exports.dailyDesk = asyncHandler(async (req, res) => send(res, await require('../services/rentalOperationsService').dailyDesk(req.store, req.query)));
exports.availability = asyncHandler(async (req, res) => send(res, await require('../services/rentalAvailabilityService').availability(req.store, req.query, { counter: req.rentalStaff === true })));
exports.alternatives = asyncHandler(async (req, res) => send(res, await require('../services/rentalAvailabilityService').alternatives(req.store, req.params.id, req.query, { counter: req.rentalStaff === true })));
exports.slots = asyncHandler(async (req, res) => send(res, await require('../services/rentalAvailabilityService').slots(req.store, req.query, { counter: req.rentalStaff === true })));
exports.waitlist = asyncHandler(async (req, res) => send(res, await require('../services/rentalAvailabilityService').listWaitlist(req.store, req.query, req.rentalStaff ? undefined : req.user._id)));
exports.waitlistDetail = asyncHandler(async (req, res) => send(res, await require('../services/rentalAvailabilityService').getWaitlist(req.store, req.params.id, req.user._id)));
exports.joinWaitlist = write('WAITLIST_JOINED', req => require('../services/rentalAvailabilityService').joinWaitlist(req.store, req.body, req.user));
exports.cancelWaitlist = write('WAITLIST_CANCELLED', req => require('../services/rentalAvailabilityService').cancelWaitlist(req.store, req.params.id, req.body, req.user._id));
exports.measurements = asyncHandler(async (req, res) => send(res, await require('../services/rentalStudioService').measurement(req.store, req.params.id)));
exports.saveMeasurements = write('MEASUREMENTS_SAVED', req => require('../services/rentalStudioService').saveMeasurement(req.store, req.params.id, req.body, req.user._id));
exports.tasks = asyncHandler(async (req, res) => send(res, await require('../services/rentalStudioService').tasks(req.store, req.query, can(req, 'inventory.cost.read'))));
exports.createTask = write('TASK_CREATED', req => require('../services/rentalStudioService').createTask(req.store, req.body, req.user._id, can(req, 'inventory.cost.read')));
exports.updateTask = write('TASK_UPDATED', req => require('../services/rentalStudioService').updateTask(req.store, req.params.id, req.body, req.user._id, can(req, 'inventory.cost.read')));
exports.refundQueue = asyncHandler(async (req, res) => send(res, await require('../services/rentalStudioService').refundQueue(req.store, req.query)));
exports.pieceReport = asyncHandler(async (req, res) => {
  if (!hasRentalReports(req)) throw new ApiError('PLAN_FEATURE_REQUIRED', 'Physical-piece reports require analytics access.');
  if (!can(req, 'inventory.cost.read')) throw new ApiError('FORBIDDEN', 'Expense/acquisition access is required for piece profitability.');
  send(res, await require('../services/rentalPieceReportingService').report(req.store, req.query));
});
exports.configuration = asyncHandler(async (req, res) => send(res, await service.readConfiguration(req.store)));
exports.saveConfiguration = write('SETTINGS_UPDATED', req => service.saveConfiguration(req.store, req.body, req.user._id));
exports.workspace = asyncHandler(async (req, res) => { const data = await service.workspace(req.store); data.assets = assetFields(req, data.assets); data.permissions = Object.fromEntries(['orders.write', 'inventory.read', 'inventory.write', 'inventory.cost.read', 'returns.qc', 'returns.refund', 'reports.read'].map(key => [key, can(req, key) && (key !== 'reports.read' || hasRentalReports(req))])); data.permissions.configure = can(req, '*'); send(res, bookingPrivacy(req, data)); });
exports.listings = asyncHandler(async (req, res) => send(res, await service.publicListings(req.store, id(req.params.id))));
exports.catalogue = asyncHandler(async (req, res) => send(res, await service.catalogue(req.store, req.query)));
exports.managementRows = asyncHandler(async (req, res) => { const data = await service.managementRows(req.store, req.params.kind, req.query); if (req.params.kind === 'assets') data.rows = assetFields(req, data.rows); send(res, data); });
exports.paymentMethods = asyncHandler(async (req, res) => send(res, await service.paymentMethods(req.store)));
exports.report = asyncHandler(async (req, res) => { if (!hasRentalReports(req)) throw new ApiError('PLAN_FEATURE_REQUIRED', 'Rental reports are not included in the current plan.'); const data = await service.report(req.store, req.query); if (!can(req, 'inventory.cost.read')) data.assets = data.assets.map(({ costPaise, ...asset }) => asset); send(res, data); });
exports.quote = asyncHandler(async (req, res) => send(res, await service.publicQuote(req.store, req.body, { counter: req.rentalStaff === true })));
exports.hold = asyncHandler(async (req, res) => send(res, service.present(await service.hold(req.store, req.body, req.user), { staff: false })));
exports.counterHold = write('COUNTER_BOOKING', req => service.hold(req.store, req.body, req.user, { counter: true }));
exports.list = asyncHandler(async (req, res) => send(res, bookingPrivacy(req, await service.listBookings(req.store, req.query, req.rentalStaff ? undefined : req.user._id))));
exports.detail = asyncHandler(async (req, res) => send(res, bookingPrivacy(req, service.present(await service.getBooking(req.store, req.params.id, null, req.rentalStaff ? undefined : req.user._id), { staff: !!req.rentalStaff }))));
exports.saveListing = write('LISTING_SAVED', req => service.saveListing(req.store, req.body, req.user._id));
exports.saveAsset = write('PIECE_SAVED', async req => { const input = { ...req.body }; if (!can(req, 'inventory.cost.read')) delete input.costPaise; return assetFields(req, [await service.saveAsset(req.store, input)])[0]; });
exports.changeAsset = write('PIECE_STATUS', async req => assetFields(req, [await service.changeAsset(req.store, req.params.id, req.body, req.user._id)])[0]);
exports.block = write('MAINTENANCE_BLOCK', req => service.blockAsset(req.store, req.body));
exports.releaseBlock = write('MAINTENANCE_RELEASE', req => service.releaseBlock(req.store, req.params.id));
exports.collect = write('PAYMENT_RECORDED', req => service.recordCollection(req.store, req.params.id, req.body, req.user._id));
exports.payments = asyncHandler(async (req, res) => send(res, await service.listPayments(req.store, req.params.id)));
exports.recoverPayment = write('PAYMENT_RECHECKED', req => service.recoverPayment(req.store, req.params.id, req.params.paymentId));
exports.operation = write('WORKFLOW', req => service.mutateBooking(req.store, req.params.id, req.body, req.user._id));
exports.reschedule = write('DATES_CHANGED', req => service.reschedule(req.store, req.params.id, req.body, req.user._id));
exports.replace = write('PIECE_REPLACED', req => service.replacePiece(req.store, req.params.id, req.body, req.user._id));
exports.cancelItems = write('ITEMS_CANCELLED', req => service.cancelItems(req.store, req.params.id, req.body, req.user._id));
exports.resolve = write('REQUEST_REVIEWED', req => service.resolveRequest(req.store, req.params.id, req.body, req.user._id));
exports.refund = write('REFUND', req => service.refund(req.store, req.params.id, req.body, req.user._id));
exports.retry = write('NOTIFICATION_RETRY', req => require('../services/rentalWorker').retry(req.store._id, req.params.id, req.body?.confirmUncertain));
exports.request = asyncHandler(async (req, res) => send(res, await service.requestChange(req.store, req.params.id, req.body, req.user._id)));
exports.payment = asyncHandler(async (req, res) => send(res, await service.createPayment(req.store, req.params.id, req.body, req.rentalStaff ? undefined : req.user._id)));
exports.verify = asyncHandler(async (req, res) => send(res, await service.verifyPayment(req.store, req.params.id, req.body, req.rentalStaff ? undefined : req.user._id)));
exports.convertAsset = write('PIECE_TRANSFERRED_TO_SALE', req => require('../services/rentalAssetConversionService').convert(req.store, req.params.id, req.body, req.user._id));
exports.proofs = asyncHandler(async (req, res) => send(res, await require('../services/rentalProofService').list(req.store, req.params.id, req.rentalStaff ? undefined : req.user._id)));
exports.proofPhoto = asyncHandler(async (req, res) => send(res, await require('../services/rentalProofService').photo(req.store, req.params.id, req.params.photoId, req.rentalStaff ? undefined : req.user._id)));
exports.uploadProof = write('CONDITION_PHOTOS', req => require('../services/rentalProofService').upload(req.store, req.params.id, req.body, req.files, req.user._id));
exports.withdrawProof = write('CONDITION_PHOTO_CORRECTED', req => require('../services/rentalProofService').withdraw(req.store, req.params.id, req.params.photoId, req.body, req.user._id));
exports.acknowledge = asyncHandler(async (req, res) => send(res, await require('../services/rentalProofService').acknowledge(req.store, req.params.id, req.body, req.user)));
exports.couriers = asyncHandler(async (req, res) => send(res, await require('../services/rentalCourierService').list(req.store, req.params.id, req.rentalStaff ? undefined : req.user._id)));
exports.courier = write('COURIER', async req => {
  if (!hasStoreFeature(req.store, 'shippingAutomation') || (req.platformLicense?.managed && !req.platformLicense.features?.includes('shippingAutomation'))) throw new ApiError('PLAN_FEATURE_REQUIRED', 'Integrated rental couriers require shipping automation access. Manual tracking remains available.');
  return require('../services/rentalCourierService').operate(req.store, req.params.id, req.params.direction, req.params.action, req.body, req.user._id);
});
exports.courierLabel = asyncHandler(async (req, res) => send(res, await require('../services/rentalCourierService').label(req.store, req.params.id, req.params.direction)));
