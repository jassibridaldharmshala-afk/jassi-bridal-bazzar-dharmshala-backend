const crypto = require('node:crypto');
const mongoose = require('mongoose');
const M = require('../models/Rental');
const A = require('./rentalAlgorithms');
const D = require('./rentalDetailsAlgorithms');
const Product = require('../models/Product');
const Store = require('../models/Store');
const Settings = require('../models/Settings');
const { supportsTransactions } = require('../utils/transaction');
const { defaultStoreFilter } = require('./storeService');
const { assertStoreCanAcceptOrders } = require('../middleware/storeMiddleware');
const { ApiError } = require('../utils/apiError');
const gateway = require('./razorpayService');
const usage = require('./commerceUsageService');
const inventoryRules = require('./rentalInventoryRules');
async function admission(store) {
  assertStoreCanAcceptOrders(store, { rental: true });
  const launch = await launchReadiness(store);
  if (!launch.acceptingOrders) fail(launch.pauseMessage, 'CHECKOUT_RESTRICTED');
  const platform = await require('./controlPlaneClient').licenseStatus();
  if (platform.managed && !['ACTIVE', 'TRIAL'].includes(platform.status)) fail('Renew the subscription before accepting a new rental.', 'SUBSCRIPTION_REQUIRED');
  return platform;
}
const fail = (message, code = 'DUPLICATE_REQUEST') => { throw new ApiError(code, message); };
const activeStates = ['HELD', 'CONFIRMED', 'PREPARING', 'READY', 'OUT', 'RETURNED'];
let indexedConnection;
async function ensureIndexes() {
  if (indexedConnection === mongoose.connection.db) return;
  await Promise.all(Object.values(M).map(model => model.init()));
  indexedConnection = mongoose.connection.db;
}
function storeId(store) { if (!store?._id) fail('Choose a store.', 'STORE_REQUIRED'); return store._id; }
function defaultMode(store) { return A.MODES.includes(store.catalogStructure?.commerce?.mode) ? store.catalogStructure.commerce.mode : 'SALE_ONLY'; }
async function launchReadiness(store, session = null) {
  const settings = await Settings.findOne(store.isDefault ? defaultStoreFilter(store._id) : { storeId: store._id }).session(session).lean();
  const methods = require('./paymentSettingsService').buildPaymentOptions(settings, { razorpayConfigured: gateway.isRazorpayConfigured() }).filter(m => m.provider === 'Razorpay' && m.enabled);
  return { acceptingOrders: settings?.acceptingOrders !== false, onlinePayments: methods.length > 0,
    pauseMessage: settings?.orderPauseMessage || 'This store has paused new orders. Contact the store for help.',
    contact: { phone: settings?.contactPhone || store.supportPhone || '', whatsapp: settings?.whatsappNumber || store.whatsappNumber || '', email: settings?.contactEmail || store.supportEmail || '' } };
}
async function readConfiguration(store) {
  const config = await M.Configuration.findOne({ storeId: storeId(store) }).lean();
  const policy = { ...A.DEFAULT_POLICY, timezone: store.timezone || 'Asia/Kolkata', ...config?.policy };
  // Legacy zero-advance preferences cannot create new free confirmed bookings.
  if (!policy.advancePercent) policy.advancePercent = A.DEFAULT_POLICY.advancePercent;
  const { contact, ...readiness } = await launchReadiness(store);
  return { mode: config?.mode || defaultMode(store), policy, revision: config?.revision || 0, readiness, contact };
}
async function initialise(store) {
  await ensureIndexes();
  await M.Configuration.updateOne({ storeId: storeId(store) }, { $setOnInsert: { mode: defaultMode(store), policy: { ...A.DEFAULT_POLICY, timezone: store.timezone || 'Asia/Kolkata' }, revision: 0, fence: 0 } }, { upsert: true }).catch(e => { if (e.code !== 11000) throw e; });
}
async function transaction(store, work, { accepting = false } = {}) {
  if (accepting) assertStoreCanAcceptOrders(store, { rental: true });
  if (!(await supportsTransactions())) fail('Rental writes need a transaction-capable MongoDB replica set (for example Atlas). Existing sale operations are unaffected.', 'SERVICE_UNAVAILABLE');
  await initialise(store);
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      // Every operation modifying availability writes the SAME store fence.
      // Snapshot isolation alone does not prevent overlapping interval inserts.
      const config = await M.Configuration.findOneAndUpdate({ storeId: store._id }, { $inc: { fence: 1 } }, { new: true, session });
      result = await work(session, config);
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    return result;
  } finally { await session.endSession(); }
}
async function saveConfiguration(store, input, actorId) {
  if (!A.MODES.includes(input.mode)) A.integer(-1, 'business mode');
  const policy = A.validatePolicy(input.policy);
  return transaction(store, async (session, config) => {
    if (input.revision !== config.revision) fail('Rental settings changed. Reload before saving.');
    if ((policy.ownerEmail || policy.customerEmail || policy.ownerWhatsapp || policy.customerWhatsapp)) {
      const provider = await require('../models/OrderAlertConfiguration').findOne({ storeId: store._id }).select('+email.apiKey +whatsapp.accessToken').session(session).lean();
      if ((policy.ownerEmail || policy.customerEmail) && (!provider?.email?.apiKey || !provider.email.senderEmail || !provider.storefrontUrl)) fail('Configure the email sender, encrypted credentials and storefront URL in Order alerts first.', 'VALIDATION_ERROR');
      if (policy.ownerEmail && !provider.email.recipient) fail('Add an owner email recipient in Order alerts.', 'VALIDATION_ERROR');
      if ((policy.ownerWhatsapp || policy.customerWhatsapp) && (!provider?.whatsapp?.accessToken || !provider.whatsapp.phoneNumberId || !provider.storefrontUrl)) fail('Configure Meta credentials and storefront URL in Order alerts first.', 'VALIDATION_ERROR');
      if (policy.ownerWhatsapp && (!provider.whatsapp.consent || !provider.whatsapp.recipient)) fail('Owner WhatsApp consent and recipient are required in Order alerts.', 'VALIDATION_ERROR');
    }
    config.mode = input.mode; config.policy = policy; config.revision += 1; config.updatedBy = actorId;
    await config.save({ session });
    await Store.updateOne({ _id: store._id }, { $set: { salesEnabled: input.mode !== 'RENTAL_ONLY', 'catalogStructure.commerce': { mode: input.mode, rentalModuleVersion: 1, stockMode: 'SEPARATE_RENTAL_ASSETS' } } }, { session });
    return { mode: config.mode, policy: config.policy, revision: config.revision };
  });
}
async function enabled(store, session) {
  const config = session ? await M.Configuration.findOne({ storeId: store._id }).session(session).lean() : await readConfiguration(store);
  if (config.mode === 'SALE_ONLY') fail('This store is not accepting new rental bookings.', 'CHECKOUT_RESTRICTED');
  return config;
}
function productFilter(store, productId) { return { $and: [{ _id: A.id(productId) }, store.isDefault ? defaultStoreFilter(store._id) : { storeId: store._id }] }; }
async function bindingsEligible(store, allocations, session) {
  const bindings = allocations.map(a => a.binding).filter(b => b?.productId);
  if (!bindings.length) return true; // Previously accepted, unbound legacy pieces.
  const ids = [...new Set(bindings.map(b => String(b.productId)))];
  const rows = await Product.find({ $and: [store.isDefault ? defaultStoreFilter(store._id) : { storeId: store._id }, { _id: { $in: ids } }, inventoryRules.publishedRentalFilter()] }).select('_id variants').session(session || null).lean();
  const byId = new Map(rows.map(p => [String(p._id), p]));
  return bindings.every(b => { const product = byId.get(String(b.productId)); return !!product && (!b.variantId || product.variants?.some(v => String(v._id) === b.variantId && v.isActive !== false)); });
}
async function saveListing(store, input, actorId) {
  const rules = A.listingRules(input);
  const requirements = input.requirements || [];
  if (!Array.isArray(requirements) || !requirements.length || requirements.length > 12) fail('Add 1–12 component inventory pools.', 'VALIDATION_ERROR');
  const cleaned = requirements.map(r => { if (!r || typeof r !== 'object') fail('Component inventory pool is invalid.', 'VALIDATION_ERROR'); return { poolKey: A.text(r.poolKey, 80), label: A.text(r.label, 100), quantity: A.integer(r.quantity, 'component quantity', 1, 10) }; });
  if (cleaned.some(r => !/^[a-z0-9_-]{2,80}$/.test(r.poolKey) || !r.label) || new Set(cleaned.map(r => r.poolKey)).size !== cleaned.length) fail('Use unique lowercase inventory pool keys and labels.', 'VALIDATION_ERROR');
  if (typeof input.active !== 'boolean') fail('Choose whether the listing is active.', 'VALIDATION_ERROR');
  return transaction(store, async (session, configuration) => {
    if (input.active && configuration.mode === 'SALE_ONLY') fail('Enable shop rental mode before activating an offer.', 'VALIDATION_ERROR');
    const product = await Product.findOne(productFilter(store, input.productId)).session(session);
    if (!product || product.isArchived) fail('Choose an existing product in this store.', 'NOT_FOUND');
    if (input.active && product.commerceMode === 'SALE_ONLY') fail('Enable rental availability on this product before activating its rental listing.', 'VALIDATION_ERROR');
    const values = { productId: product._id, title: A.text(input.title || product.name, 200), variantId: A.text(input.variantId || '', 120), size: A.text(input.size || '', 80), colour: A.text(input.colour || '', 80), notes: A.text(input.notes || '', 2000), requirements: cleaned, active: input.active, ...rules };
    if (values.variantId) {
      const variant = product.variants.find(v => String(v._id) === values.variantId && v.isActive !== false);
      if (!variant || (values.size && values.size.trim().toLowerCase() !== variant.size.trim().toLowerCase()) || (values.colour && values.colour.trim().toLowerCase() !== variant.color.trim().toLowerCase())) fail('Offer size/colour must match an active product variant.', 'VALIDATION_ERROR');
      values.size ||= variant.size; values.colour ||= variant.color;
    }
    values.matchingVersion = 2;
    for (let index = 0; index < cleaned.length; index += 1) {
      if (cleaned.length > 1 && !requirements[index].productId) fail('Choose the exact catalogue product for every component of a multi-piece listing.', 'VALIDATION_ERROR');
      const raw = cleaned.length === 1 ? { ...requirements[index], productId: String(product._id), variantId: values.variantId, size: values.size, colour: values.colour } : requirements[index], componentProduct = raw.productId ? await Product.findOne(productFilter(store, raw.productId)).session(session) : product;
      if (!componentProduct || componentProduct.isArchived) fail('Component product must belong to this store.', 'VALIDATION_ERROR');
      cleaned[index] = { ...cleaned[index], ...(raw.productId || cleaned.length === 1 ? { productId: componentProduct._id } : {}), variantId: A.text(raw.variantId || (cleaned.length === 1 ? values.variantId : ''), 120), size: A.text(raw.size || (cleaned.length === 1 ? values.size : ''), 80), colour: A.text(raw.colour || (cleaned.length === 1 ? values.colour : ''), 80) };
      const variant = cleaned[index].variantId ? componentProduct.variants.find(v => String(v._id) === cleaned[index].variantId && v.isActive !== false) : null;
      if (cleaned[index].variantId && !variant) fail('Component variant must be active and belong to its product.', 'VALIDATION_ERROR');
      if (variant) {
        const normal = value => String(value || '').trim().toLowerCase();
        if ((cleaned[index].size && normal(cleaned[index].size) !== normal(variant.size)) || (cleaned[index].colour && normal(cleaned[index].colour) !== normal(variant.color))) fail('Component size/colour must match its variant.', 'VALIDATION_ERROR');
        cleaned[index].size ||= variant.size || ''; cleaned[index].colour ||= variant.color || '';
      }
    }
    values.requirements = cleaned;
    if (input.fitting !== undefined) values.fitting = require('./rentalFitting').fitting(input.fitting);
    if (values.variantId && !product.variants.some(v => String(v._id) === values.variantId && v.isActive !== false)) fail('Choose an active product variant.', 'VALIDATION_ERROR');
    let listing;
    if (input._id) {
      listing = await M.Listing.findOne({ _id: A.id(input._id), storeId: store._id }).session(session);
      if (!listing) fail('Rental listing not found.', 'NOT_FOUND');
      if (input.revision !== listing.revision) fail('Rental listing changed. Reload first.');
      if (String(listing.productId) !== String(product._id)) fail('An existing listing cannot be moved to another product.', 'VALIDATION_ERROR');
      Object.assign(listing, values); listing.revision += 1;
    } else listing = new M.Listing({ storeId: store._id, ...values });
    // Only configured inventory may be advertised as a new active offer. This is
    // inside the availability fence, so simultaneous piece edits cannot race it.
    if (listing.active) {
      const readiness = await require('./rentalSetupService').readiness(store, listing.toObject(), session);
      if (!readiness.ready) fail('Complete rental setup before activation: ' + readiness.checks.filter(c => !c.ready).map(c => c.label).join('; '), 'VALIDATION_ERROR');
    }
    await listing.save({ session });
    return listing.toObject();
  });
}
async function saveAsset(store, input) {
  return transaction(store, async session => {
    const values = { poolKey: A.text(input.poolKey, 80), code: A.text(input.code, 80).toUpperCase(), label: A.text(input.label, 200), location: A.text(input.location || '', 200), condition: A.text(input.condition || 'Good', 1000), measurements: A.text(input.measurements || '', 1000), costPaise: A.integer(input.costPaise || 0, 'asset cost') };
    if (input.fitProfile !== undefined) values.fitProfile = D.fitProfile(input.fitProfile);
    if (!/^[a-z0-9_-]{2,80}$/.test(values.poolKey) || !/^[A-Z0-9_-]{2,80}$/.test(values.code) || !values.label) fail('Enter a pool key, unique piece code and label.', 'VALIDATION_ERROR');
    let asset;
    if (input._id) {
      asset = await M.Asset.findOne({ _id: A.id(input._id), storeId: store._id }).session(session);
      if (!asset) fail('Rental piece not found.', 'NOT_FOUND');
      if (input.revision !== asset.revision) fail('Rental piece changed. Reload first.');
      const reserved = await M.Reservation.exists({ storeId: store._id, assetId: asset._id, active: true, $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] }).session(session);
      if (reserved && (values.poolKey !== asset.poolKey || values.code !== asset.code)) fail('A booked piece cannot change its pool or code.');
      if (input.costPaise === undefined) delete values.costPaise;
      const binding = await inventoryRules.binding(store, { ...input, poolKey: values.poolKey }, asset, session);
      if ((reserved || asset.currentBookingId) && Object.keys(binding).some(k => String(binding[k] || '') !== String(asset[k] || ''))) fail('A reserved/assigned piece cannot change its product, variant, size or colour.');
      if (asset.saleConversion) fail('A converted sale piece cannot be edited back into rental inventory.');
      Object.assign(values, binding);
      Object.assign(asset, values); asset.revision += 1;
    } else asset = new M.Asset({ storeId: store._id, ...values, ...await inventoryRules.binding(store, { ...input, poolKey: values.poolKey }, null, session) });
    await asset.save({ session }); return asset.toObject();
  });
}
async function changeAsset(store, assetId, input, actorId) {
  A.operation(input.operationId);
  return transaction(store, async session => {
    const asset = await M.Asset.findOne({ _id: A.id(assetId), storeId: store._id }).session(session);
    if (!asset) fail('Rental piece not found.', 'NOT_FOUND');
    if (asset.revision !== input.revision) fail('Rental piece changed. Reload first.');
    if (asset.saleConversion) fail('This piece has been transferred to sale stock and cannot be rented again.');
    if (!['READY', 'CLEANING', 'REPAIR', 'LOST', 'RETIRED'].includes(input.status)) fail('Choose an allowed condition status.', 'VALIDATION_ERROR');
    if (await M.Task.exists({ storeId: store._id, assetId: asset._id, status: { $in: require('./rentalStudioService').openTasks } }).session(session)) fail('Resolve unfinished workshop work before changing piece readiness.');
    if (asset.status === 'OUT' || asset.currentBookingId) fail('Use the booking return/inspection workflow for an assigned piece.');
    if (input.status !== 'READY' && await M.Reservation.exists({ storeId: store._id, assetId: asset._id, active: true, $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] }).session(session)) fail('This piece has future reservations. Reassign/cancel those bookings before taking it out of service.');
    asset.status = input.status; asset.condition = A.text(input.note || asset.condition, 1000); asset.revision += 1;
    await asset.save({ session }); return asset.toObject();
  });
}
async function blockAsset(store, input) {
  const blockedFrom = A.date(input.blockedFrom), blockedUntil = A.date(input.blockedUntil);
  if (+blockedUntil <= +blockedFrom) fail('Maintenance end must follow its start.', 'VALIDATION_ERROR');
  return transaction(store, async session => {
    const asset = await M.Asset.findOne({ _id: A.id(input.assetId), storeId: store._id }).session(session);
    if (!asset || asset.currentBookingId) fail('Choose an unassigned rental piece.', 'VALIDATION_ERROR');
    if (await M.Reservation.exists({ storeId: store._id, assetId: asset._id, active: true, blockedFrom: { $lt: blockedUntil }, blockedUntil: { $gt: blockedFrom }, $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] }).session(session)) fail('Maintenance overlaps a booking. Choose other dates.');
    const [row] = await M.Reservation.create([{ storeId: store._id, assetId: asset._id, blockedFrom, blockedUntil, kind: 'MAINTENANCE', note: A.text(input.note || '', 500) }], { session });
    return row.toObject();
  });
}
async function quoteInternal(store, input, session, { existing = false, counter = false, policy: oldPolicy, ignoreBooking } = {}) {
  const configuration = await enabled(store, session);
  const policy = A.validatePolicy(oldPolicy || { ...configuration.policy, advancePercent: configuration.policy.advancePercent || A.DEFAULT_POLICY.advancePercent }, { existing: !!oldPolicy });
  const dates = A.schedule(input, policy, new Date(), { existing, allowImmediate: counter });
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 10) fail('Choose 1–10 rental listings.', 'VALIDATION_ERROR');
  const lines = [];
  const seen = new Set();
  for (const item of input.items) {
    const listingId = A.id(item.listingId);
    if (seen.has(listingId)) fail('Combine quantities for the same rental listing.', 'VALIDATION_ERROR');
    seen.add(listingId);
    const listing = await M.Listing.findOne({ _id: listingId, storeId: store._id, active: true }).session(session || null).lean();
    if (!listing) fail('A selected rental listing is unavailable.', 'NOT_FOUND');
    const product = await Product.findOne({ $and: [productFilter(store, listing.productId), inventoryRules.publishedRentalFilter()] }).session(session || null).select('_id variants images').lean();
    if (!product) fail('A selected product is unavailable.', 'NOT_FOUND');
    if (listing.variantId && !product.variants?.some(v => String(v._id) === listing.variantId && v.isActive !== false)) fail('The selected rental variant is unavailable.', 'OUT_OF_STOCK');
    lines.push({ listing: { ...listing, image: product.images?.[0] }, quantity: A.integer(item.quantity, 'quantity', 1, 10) });
  }
  const price = A.quote(lines, dates, policy, input.deliveryMode || 'STORE_PICKUP', input.paymentPlan || (policy.paymentPlans || ['ADVANCE'])[0]);
  if (price.paymentPlan === 'PICKUP' || dates.billingBasis === 'USE_DAYS') dates.balanceDueAt = dates.pickupAt;
  const allocations = [];
  const used = new Set();
  for (const line of lines) for (const requirement of line.listing.requirements) {
    const required = requirement.quantity * line.quantity;
    const assets = await M.Asset.find({ storeId: store._id, poolKey: requirement.poolKey, $or: [{ status: 'READY' }, { status: 'OUT', returnDueAt: { $gt: new Date() } }, ...(ignoreBooking ? [{ status: 'OUT', currentBookingId: ignoreBooking }] : [])] }).sort('code').limit(1000).session(session || null).lean();
    const conflicting = await M.Reservation.find({ storeId: store._id, assetId: { $in: assets.map(a => a._id) }, active: true, ...(ignoreBooking ? { bookingId: { $ne: ignoreBooking } } : {}), blockedFrom: { $lt: dates.blockedUntil }, blockedUntil: { $gt: dates.blockedFrom }, $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] }).session(session || null).select('assetId').lean();
    const excluded = new Set(conflicting.map(r => String(r.assetId)));
    const overdueWork = await M.Task.find({ storeId: store._id, assetId: { $in: assets.map(a => a._id) }, status: { $in: require('./rentalStudioService').openTasks }, dueAt: { $lte: new Date() } }).session(session || null).select('assetId').lean();
    for (const task of overdueWork) excluded.add(String(task.assetId));
    const available = assets.filter(a => !a.saleConversion && inventoryRules.matchesPiece(a, requirement, line.listing) && !excluded.has(String(a._id)) && !used.has(String(a._id)));
    if (available.length < required) fail(`${line.listing.title}: ${requirement.label} is unavailable for these dates.`, 'OUT_OF_STOCK');
    for (const asset of available.slice(0, required)) { used.add(String(asset._id)); allocations.push({ listingId: line.listing._id, assetId: asset._id, code: asset.code, label: asset.label, binding: { productId: requirement.productId || (line.listing.requirements.length === 1 ? line.listing.productId : undefined), variantId: requirement.variantId || (line.listing.requirements.length === 1 ? line.listing.variantId : ''), size: requirement.size || (line.listing.requirements.length === 1 ? line.listing.size : ''), colour: requirement.colour || (line.listing.requirements.length === 1 ? line.listing.colour : '') } }); }
  }
  await assertSlotCapacity(store, dates, policy, session, ignoreBooking);
  if (!(await bindingsEligible(store, allocations, session))) fail('An allocated component product or variant is no longer published/available.', 'OUT_OF_STOCK');
  if (policy.requireConditionPhotos && allocations.length > 50) fail('A booking with compulsory condition photos supports at most 50 physical pieces. Split the booking so every handover and return has evidence.', 'VALIDATION_ERROR');
  return { quote: price, schedule: dates, policy, policyRevision: configuration.revision, allocations };
}
async function assertSlotCapacity(store, dates, policy, session, ignoreBooking) {
  for (const field of ['pickupAt', 'returnDueAt']) {
    const count = await M.Booking.countDocuments({ storeId: store._id, status: { $in: ['HELD', 'CONFIRMED', 'PREPARING', 'READY', 'OUT'] }, ...(ignoreBooking ? { _id: { $ne: ignoreBooking } } : {}), $and: [{ $or: [{ 'schedule.pickupAt': dates[field] }, { 'schedule.returnDueAt': dates[field] }, { 'trial.at': { $lte: dates[field] }, 'trial.until': { $gt: dates[field] }, 'trial.status': { $in: ['SCHEDULED', 'ATTENDED'] } }, { 'trial.at': dates[field], 'trial.status': { $exists: false } }] }, { $or: [{ status: { $ne: 'HELD' } }, { expiresAt: { $gt: new Date() } }] }] }).session(session || null);
    if (count >= policy.slotCapacity) fail('That pickup/return slot is full. Choose another time.', 'OUT_OF_STOCK');
  }
}
async function publicQuote(store, input, { counter = false } = {}) {
  assertStoreCanAcceptOrders(store, { rental: true });
  const data = await quoteInternal(store, input, null, { counter });
  return { quote: data.quote, quoteFingerprint: A.quoteFingerprint(store._id, data), schedule: data.schedule, terms: data.policy.terms, policyRevision: data.policyRevision, timezone: data.policy.timezone, policySummary: { graceHours: data.policy.graceHours, lateFeePerDayPaise: data.policy.lateFeePerDayPaise, cancellationRules: data.policy.cancellationRules, preparationHours: data.policy.preparationHours, cleaningHours: data.policy.cleaningHours, advanceMode: data.policy.advanceMode, advancePercent: data.policy.advancePercent, advanceAmountPaise: data.policy.advanceAmountPaise, depositTiming: data.policy.depositTiming, noShowGraceHours: data.policy.noShowGraceHours, noShowRetainPercent: data.policy.noShowRetainPercent, earlyReturnPolicy: data.policy.earlyReturnPolicy, requireConditionPhotos: data.policy.requireConditionPhotos, requireCustomerAcknowledgement: data.policy.requireCustomerAcknowledgement } };
}
async function enqueue(booking, event, session, token, { audiences = ['OWNER', 'CUSTOMER'] } = {}) {
  for (const audience of audiences) for (const channel of ['IN_APP', 'EMAIL', 'WHATSAPP']) {
    if (audience === 'CUSTOMER' && !booking.userId && channel === 'IN_APP') continue;
    const dedupeKey = `${booking._id}:${event}:${token}:${audience}:${channel}`;
    await M.Job.updateOne({ dedupeKey }, { $setOnInsert: { storeId: booking.storeId, bookingId: booking._id, event, dedupeKey, audience, channel, nextAttemptAt: new Date(), reminderPickupAt: booking.schedule.pickupAt, reminderReturnDueAt: booking.schedule.returnDueAt, reminderBalanceDueAt: booking.schedule.balanceDueAt, reminderTrialAt: booking.trial?.at } }, { session, upsert: true });
  }
}
async function event(booking, type, input, actorId, session) {
  if (booking.events.length >= 1000) fail('This booking has reached its operation limit. Contact support.', 'PLAN_LIMIT_REACHED');
  booking.events.push({ operationId: input.operationId, inputFingerprint: require('./rentalStudioAlgorithms').fingerprint(input), type, note: A.text(input.note || '', 1000), actorId, at: new Date() });
  await require('./rentalStudioService').refreshRefundClock(booking);
  booking.revision += 1;
  await booking.save({ session });
  await enqueue(booking, type, session, input.operationId);
  return present(booking);
}
function present(booking, { staff = true } = {}) {
  const value = booking.toObject ? booking.toObject() : { ...booking };
  value.financial = A.finances(value);
  value.overdue = value.status === 'OUT' && +new Date(value.schedule.returnDueAt) < Date.now();
  value.estimatedLateFeePaise = value.status === 'OUT' ? A.lateEstimate(value) : 0;
  value.documents = require('./rentalDocumentsService').documents(value);
  delete value.fingerprint;
  if (!staff) {
    delete value.bookingDetailsHistory;
    if (value.bookingDetails) {
      value.bookingDetails = JSON.parse(JSON.stringify(value.bookingDetails));
      for (const key of ['pickupContact', 'returnContact']) if (value.bookingDetails[key]) delete value.bookingDetails[key].authorisedBy;
    }
    value.contactChecks = (value.contactChecks || []).map(({ checkedBy, ...check }) => check);
  }
  if (!staff) { delete value.measurementSnapshot; delete value.trialHistory; if (value.trial) { delete value.trial.assetIds; delete value.trial.scheduledOperationId; } }
  if (!staff) { value.pieces = (value.allocations || []).map(({ code, label, receivedAt, lostAt, disposition, readyAt }) => ({ code, label, receivedAt, lostAt, disposition, readyAt })); delete value.allocations; value.replacements = (value.replacements || []).map(({ type, note, at }) => ({ type, note, at })); value.cancelledItems = (value.cancelledItems || []).map(({ allocations, ...item }) => item); value.events = (value.events || []).map(({ type, at, note }) => ({ type, at, note })); value.ledger = (value.ledger || []).map(({ actorId, paymentId, paymentOrderId, ...e }) => e); delete value.trial?.measurements; }
  return value;
}
function contact(input, user) {
  const name = A.text(input.name || user?.name || '', 100), phone = A.text(input.phone || user?.phone || '', 25), email = A.text(input.email || user?.email || '', 254);
  if (!name || !/^\+?[1-9]\d{9,14}$/.test(phone.replace(/[\s()-]/g, '')) || (email && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email))) fail('Enter the customer name, valid phone and optional email.', 'VALIDATION_ERROR');
  return { name, phone: phone.replace(/[\s()-]/g, ''), email, whatsappConsent: input.whatsappConsent === true };
}
async function hold(store, input, user, { counter = false } = {}) {
  const attemptId = A.operation(input.attemptId);
  if (input.acceptTerms !== true) fail('Accept the rental terms to continue.', 'VALIDATION_ERROR');
  const customer = contact(input.customer || {}, user);
  if (!counter && (!user?.isPhoneVerified || user.offlineSession || !require('mongoose').isValidObjectId(user._id))) fail('Verify your phone before booking.', 'FORBIDDEN');
  if (!counter) await require('./customerAccessService').assertCustomerCanCheckout({ storeId: store._id, userId: user._id });
  if (!counter) customer.phone = user.phone;
  const details = input.bookingDetails === undefined ? undefined : D.bookingDetails(input.bookingDetails, input.deliveryMode || 'STORE_PICKUP');
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ userId: counter ? null : String(user._id), items: input.items, pickupAt: input.pickupAt, returnDueAt: input.returnDueAt, eventAt: input.eventAt || '', ...(input.useDates !== undefined ? { useDates: input.useDates } : {}), ...(input.paymentPlan !== undefined ? { paymentPlan: input.paymentPlan } : {}), deliveryMode: input.deliveryMode || 'STORE_PICKUP', address: input.address || '', customer, ...(details ? { bookingDetails: details } : {}) })).digest('hex');
  return transaction(store, async (session, config) => {
    const previous = await M.Booking.findOne({ storeId: store._id, attemptId }).session(session);
    if (previous) { if (previous.fingerprint !== fingerprint) fail('This booking attempt belongs to different details. Start a new attempt.'); return present(previous); }
    // Retry an existing attempt before applying new-booking admission rules.
    // Pausing orders or payments must not strand an already-created hold.
    const platform = await admission(store);
    const launch = await launchReadiness(store, session);
    if (!launch.acceptingOrders) fail(launch.pauseMessage, 'CHECKOUT_RESTRICTED');
    if (!counter && input.paymentPlan !== 'PICKUP' && !launch.onlinePayments) fail('Online rental payments are unavailable. Contact the store; no booking or payment has been created.', 'CHECKOUT_RESTRICTED');
    const data = await quoteInternal(store, input, session, { counter });
    if (input.policyRevision !== data.policyRevision) fail('Rental terms changed. Review the quote and accept again.', 'RENTAL_QUOTE_CHANGED');
    if (input.quoteFingerprint !== A.quoteFingerprint(store._id, data)) fail('The rental price or listing changed. Review the latest quote and accept it again before reserving.', 'RENTAL_QUOTE_CHANGED');
    await usage.assertMonthlyCapacity(store, { session, platform, lock: true });
    const address = details ? D.addressText(details.deliveryAddress) : A.text(input.address || '', 1000);
    if (data.quote.deliveryMode !== 'STORE_PICKUP' && !address) fail('A delivery/collection address is required.', 'VALIDATION_ERROR');
    const expiresAt = new Date(Date.now() + config.policy.holdMinutes * 60000);
    const matchedCustomer = counter ? await require('../models/User').findOne({ phone: require('../utils/phoneUtils').normalizePhone(customer.phone), isPhoneVerified: true, isBlocked: { $ne: true } }).session(session).select('_id').lean() : null;
    if (counter && data.policy.requireCustomerAcknowledgement && !matchedCustomer) fail('Verified acknowledgement is required: ask this counter customer to register/verify their phone before booking.', 'VALIDATION_ERROR');
    const seller = await Settings.findOne(store.isDefault ? defaultStoreFilter(store._id) : { storeId: store._id }).select('storeName legalBusinessName gstin address contactEmail contactPhone').session(session).lean();
    const booking = new M.Booking({ storeId: store._id, userId: counter ? undefined : user._id, source: counter ? 'COUNTER' : 'ONLINE', customer, number: `R-${crypto.randomBytes(8).toString('hex').toUpperCase()}`, attemptId, fingerprint, expiresAt, acceptedAt: new Date(), billingIdentity: { ...seller, _id: undefined, storeName: seller?.storeName || store.name }, ...data, logistics: { address, outbound: { mode: data.quote.deliveryMode }, inbound: { mode: data.quote.deliveryMode } }, events: [{ operationId: attemptId, type: 'HELD', at: new Date(), actorId: user?._id }] });
    if (details) booking.bookingDetails = D.stampAuthorisations(details, null, user?._id);
    await booking.save({ session });
    if (matchedCustomer) { booking.userId = matchedCustomer._id; await booking.save({ session }); }
    await M.Reservation.insertMany(data.allocations.map(a => ({ storeId: store._id, assetId: a.assetId, bookingId: booking._id, blockedFrom: data.schedule.blockedFrom, blockedUntil: data.schedule.blockedUntil, expiresAt })), { session });
    if (data.quote.paymentPlan === 'PICKUP') {
      await confirmIfPaid(booking, session, { store, platform });
      booking.events.push({ operationId: attemptId + '_confirm', type: 'CONFIRMED', at: new Date(), actorId: user?._id, note: 'Payment agreed at pickup.' });
      await booking.save({ session }); await enqueue(booking, 'CONFIRMED', session, attemptId);
    }
    return present(booking);
  });
}
async function getBooking(store, bookingId, session, userId) {
  const booking = await M.Booking.findOne({ _id: A.id(bookingId), storeId: store._id, ...(userId ? { userId } : {}) }).session(session || null);
  if (!booking) fail('Rental booking not found.', 'NOT_FOUND');
  return booking;
}
function checkOperation(booking, input) {
  A.operation(input.operationId);
  const previous = booking.events.find(e => e.operationId === input.operationId);
  if (previous) {
    if (previous.inputFingerprint && previous.inputFingerprint !== require('./rentalStudioAlgorithms').fingerprint(input)) fail('This operation ID belongs to different booking details.');
    return false;
  }
  if (input.revision !== booking.revision) fail('Booking changed. Reload before continuing.');
  return true;
}
async function assertNoOpenCourier(booking, session, direction) {
  if (await M.Courier.exists({ storeId: booking.storeId, bookingId: booking._id, ...(direction ? { direction } : {}), $or: [{ operation: { $nin: ['', null] } }, { status: { $nin: ['FAILED', 'CANCELLED'] } }] }).session(session)) fail('Cancel/reconcile the connected courier leg before changing its items, dates or manual tracking. A delivered parcel must be received, not cancelled.');
}
async function confirmIfPaid(booking, session, { store, platform, captured = false } = {}) {
  if (booking.status !== 'HELD') return;
  if (+booking.expiresAt <= Date.now()) { booking.status = 'EXPIRED'; booking.adjustedRentalPaise = 0; await M.Reservation.updateMany({ storeId: booking.storeId, bookingId: booking._id }, { $set: { active: false } }, { session }); return; }
  if (A.finances(booking).collectedPaise < booking.quote.dueNowPaise) return;
  if (booking.quote.paymentPlan !== 'PICKUP' && (!booking.quote.advanceRentPaise || !booking.quote.dueNowPaise || !A.finances(booking).collectedPaise)) fail('A verified positive booking advance is compulsory.', 'VALIDATION_ERROR');
  const ids = booking.allocations.map(a => a.assetId);
  const assets = await M.Asset.find({ storeId: booking.storeId, _id: { $in: ids } }).session(session).lean();
  const productIds = [...new Set(booking.quote.items.map(i => String(i.productId)))];
  const eligible = await Product.countDocuments({ $and: [store?.isDefault ? defaultStoreFilter(booking.storeId) : { storeId: booking.storeId }, { _id: { $in: productIds } }, inventoryRules.publishedRentalFilter()] }).session(session);
  if (eligible !== productIds.length || !(await bindingsEligible(store, booking.allocations, session)) || assets.length !== ids.length || assets.some(a => a.saleConversion || !['READY', 'OUT'].includes(a.status) || (a.status === 'OUT' && +a.returnDueAt <= Date.now()))) {
    booking.status = 'EXPIRED'; booking.adjustedRentalPaise = 0;
    await M.Reservation.updateMany({ storeId: booking.storeId, bookingId: booking._id }, { $set: { active: false } }, { session }); return;
  }
  try {
    if (!store || (platform?.managed && !['ACTIVE', 'TRIAL'].includes(platform.status))) fail('Subscription is not accepting new rentals.', 'SUBSCRIPTION_REQUIRED');
    assertStoreCanAcceptOrders(store, { rental: true });
    await usage.assertMonthlyCapacity(store, { session, platform, lock: true });
  } catch (error) {
    if (!captured || !['PLAN_LIMIT_REACHED', 'SUBSCRIPTION_REQUIRED', 'SERVICE_UNAVAILABLE'].includes(error.errorCode)) throw error;
    // Provider money is recorded even when the last quota was used or access
    // expired. Do not activate inventory; keep the payment refundable.
    booking.status = 'EXPIRED'; booking.adjustedRentalPaise = 0;
    await M.Reservation.updateMany({ storeId: booking.storeId, bookingId: booking._id }, { $set: { active: false } }, { session }); return;
  }
  booking.status = 'CONFIRMED'; booking.confirmedAt ||= new Date();
  await M.Reservation.updateMany({ storeId: booking.storeId, bookingId: booking._id, active: true }, { $set: { expiresAt: null } }, { session });
}
async function recordCollection(store, bookingId, input, actorId) {
  const platform = await require('./controlPlaneClient').licenseStatus();
  const amountPaise = A.integer(input.amountPaise, 'payment amount', 1);
  if (!['CASH', 'BANK', 'UPI'].includes(input.method)) fail('Choose a manual payment method.', 'VALIDATION_ERROR');
  const reference = A.text(input.reference || '', 120); if (!reference) fail('A receipt/bank transaction reference is required.', 'VALIDATION_ERROR');
  return transaction(store, async session => {
    const booking = await getBooking(store, bookingId, session);
    if (!checkOperation(booking, input)) return present(booking);
    if (booking.status === 'HELD') assertStoreCanAcceptOrders(store, { rental: true });
    if (!['HELD', 'CONFIRMED', 'PREPARING', 'READY', 'OUT', 'RETURNED'].includes(booking.status)) fail('This booking cannot collect another payment.');
    if (booking.status === 'HELD' && +booking.expiresAt <= Date.now()) fail('The hold expired. Start a fresh booking.');
    const pending = await M.Payment.exists({ storeId: store._id, bookingId: booking._id, $or: [{ state: { $in: ['CREATING', 'PENDING', 'REVIEW'] } }, { state: 'FAILED', orderId: { $type: 'string' } }] }).session(session);
    if (pending) fail('An online payment is pending. Resolve it before recording a manual receipt.');
    if (await M.Booking.exists({ storeId: store._id, ledger: { $elemMatch: { kind: 'COLLECTION', method: input.method, reference } } }).session(session)) fail('This receipt/transaction reference has already been recorded.');
    if (amountPaise > A.finances(booking).balancePaise) fail('Payment exceeds the outstanding amount.', 'VALIDATION_ERROR');
    booking.ledger.push({ operationId: input.operationId, kind: 'COLLECTION', amountPaise, method: input.method, reference, status: 'PROCESSED', actorId, at: new Date() });
    await confirmIfPaid(booking, session, { store, platform });
    return event(booking, booking.status === 'CONFIRMED' ? 'CONFIRMED' : 'PAYMENT_RECEIVED', input, actorId, session);
  });
}
async function mutateBooking(store, bookingId, input, actorId) {
  return transaction(store, async session => {
    const b = await getBooking(store, bookingId, session);
    if (!checkOperation(b, input)) return present(b);
    const action = input.action;
    const studio = require('./rentalStudioService');
    if (['HANDOVER', 'RECEIVE'].includes(action)) {
      const contact = b.bookingDetails?.[action === 'HANDOVER' ? 'pickupContact' : 'returnContact'];
      if (contact) {
        if (!contact.authorised || input.contactVerified !== true) fail('Check the named contact and customer authorisation before handover / return.', 'VALIDATION_ERROR');
        b.contactChecks.push({ operationId: input.operationId, stage: action, name: contact.name, phone: contact.phone, assetIds: input.assetIds || [], checkedBy: actorId, checkedAt: new Date() });
      }
    }
    if (['READY', 'HANDOVER', 'RELEASE', 'CLOSE'].includes(action)) await studio.assertWorkComplete(store, b, action === 'RELEASE' ? A.id(input.assetId) : undefined, session, action === 'CLOSE');
    if (action === 'DETAILS') {
      if (!['HELD', 'CONFIRMED', 'PREPARING', 'READY', 'OUT'].includes(b.status) || (b.status === 'HELD' && +b.expiresAt <= Date.now())) fail('Update details only on an active booking.');
      if (input.customerApproved !== true || !A.text(input.note || '', 1000)) fail('Record customer approval and a reason for changing booking details.');
      const old = b.bookingDetails;
      const details = D.bookingDetails(input.bookingDetails, b.quote.deliveryMode, { preserveLegacyDelivery: b.status === 'OUT' && !old?.deliveryAddress && !!b.logistics?.address });
      if (b.bookingDetailsHistory.length >= 100) fail('Booking detail revision limit reached. Contact support before another change.');
      if (b.status === 'OUT') {
        const comparable = value => value ? { name: value.name, phone: value.phone, relationship: value.relationship || '', authorised: value.authorised === true } : null;
        if (JSON.stringify(details.deliveryAddress) !== JSON.stringify(old?.deliveryAddress || null) || JSON.stringify(comparable(details.pickupContact)) !== JSON.stringify(comparable(old?.pickupContact)) || details.occasion !== (old?.occasion || '') || details.fittingInstructions !== (old?.fittingInstructions || '')) fail('Delivery address, pickup contact and fitting/event details are locked after handover. Only return details, alternate contact and delivery instructions can change.');
      }
      for (const [key, direction] of [['deliveryAddress', 'outbound'], ['collectionAddress', 'inbound']]) if (JSON.stringify(details[key]) !== JSON.stringify(old?.[key] || null)) await assertNoOpenCourier(b, session, direction);
      b.bookingDetailsHistory.push({ operationId: input.operationId, before: old || null, actorId, at: new Date() });
      b.bookingDetails = D.stampAuthorisations(details, old, actorId);
      b.logistics.address = D.addressText(details.deliveryAddress) || b.logistics.address;
    } else if (action === 'PREPARE' || action === 'READY') {
      const allowed = action === 'PREPARE' ? ['CONFIRMED'] : ['CONFIRMED', 'PREPARING'];
      if (!allowed.includes(b.status)) fail('The booking is not in the right preparation state.');
      b.status = action === 'PREPARE' ? 'PREPARING' : 'READY';
    } else if (action === 'HANDOVER') {
      if (b.status !== 'READY' || A.finances(b).balancePaise) fail('Complete preparation and collect the full rent/deposit before handover.');
      if (!A.text(input.note || '', 1000) || !Array.isArray(input.assetIds) || input.assetIds.length !== b.allocations.length || new Set(input.assetIds).size !== b.allocations.length || b.allocations.some(a => !input.assetIds.includes(String(a.assetId)))) fail('Scan/confirm every piece and record the handover acknowledgement.', 'VALIDATION_ERROR');
      await require('./rentalProofService').ensure(b, 'HANDOVER', input.assetIds, session);
      const assets = await M.Asset.find({ storeId: store._id, _id: { $in: b.allocations.map(a => a.assetId) } }).session(session);
      if (assets.some(a => a.status !== 'READY' || a.currentBookingId)) fail('One or more allocated pieces have not completed their previous return/cleaning.');
      const outgoing = await M.Courier.findOne({ storeId: store._id, bookingId: b._id, direction: 'outbound', awb: { $nin: ['', null] }, status: { $nin: ['CANCELLED', 'FAILED', 'REVIEW'] }, operation: { $in: ['', null] } }).session(session).lean();
      const earliestHandover = outgoing ? Math.max(+b.schedule.blockedFrom, +new Date(outgoing.slot.at)) : +b.schedule.pickupAt;
      if (Date.now() < earliestHandover || Date.now() >= +b.schedule.returnDueAt) fail('Handover is outside this booking’s agreed pickup/return period or confirmed carrier dispatch slot.');
      await M.Asset.updateMany({ storeId: store._id, _id: { $in: assets.map(a => a._id) } }, { $set: { status: 'OUT', currentBookingId: b._id, returnDueAt: b.schedule.returnDueAt }, $inc: { revision: 1 } }, { session });
      b.status = 'OUT';
    } else if (action === 'RECEIVE') {
      if (b.status !== 'OUT') fail('Only an active rental can be returned.');
      if (!Array.isArray(input.assetIds) || !input.assetIds.length || new Set(input.assetIds).size !== input.assetIds.length) fail('Select returned pieces.', 'VALIDATION_ERROR');
      await require('./rentalProofService').ensure(b, 'RETURN', input.assetIds, session);
      for (const value of input.assetIds) {
        const allocation = b.allocations.find(a => String(a.assetId) === value && !a.receivedAt && !a.lostAt);
        if (!allocation) fail('This piece is not awaiting return in this booking.', 'VALIDATION_ERROR');
        allocation.receivedAt = new Date();
        await M.Asset.updateOne({ storeId: store._id, _id: allocation.assetId, currentBookingId: b._id }, { $set: { status: 'INSPECTION' }, $inc: { revision: 1 } }, { session });
      }
      if (b.allocations.every(a => a.receivedAt || a.lostAt)) {
        b.status = 'RETURNED';
        if (Date.now() < +b.schedule.returnDueAt) {
          b.earlyReturnedAt = new Date();
          if (b.policy.earlyReturnPolicy === 'ACTUAL_DAYS' && b.allocations.every(a => a.receivedAt && !a.lostAt)) {
            b.acceptedQuote ||= JSON.parse(JSON.stringify(b.quote));
            const days = b.schedule.useDates ? Math.max(b.policy.minimumDays, b.schedule.useDates.filter(day => day <= A.localKey(new Date(), b.policy.timezone)).length) : Math.max(b.policy.minimumDays, Math.ceil((Date.now() - +b.schedule.pickupAt) / A.DAY));
            const lines = b.quote.items.map(i => ({ listing: { _id: i.listingId, productId: i.productId, title: i.title, image: i.image, components: i.components, ...i.rules }, quantity: i.quantity }));
            const adjusted = A.quote(lines, { ...b.schedule, days }, b.policy, b.quote.deliveryMode, b.quote.paymentPlan || 'ADVANCE');
            b.adjustedRentalPaise = Math.min(b.quote.rentalPaise, adjusted.rentalPaise) + b.cancellationChargesPaise;
          }
        }
      }
    } else if (action === 'DECLARE_LOST') {
      if (b.status !== 'OUT' || !input.note || !/^https:\/\//.test(input.evidenceUrl || '')) fail('Record an active rental, loss acknowledgement and HTTPS evidence link.', 'VALIDATION_ERROR');
      const allocation = b.allocations.find(a => String(a.assetId) === A.id(input.assetId) && !a.receivedAt && !a.lostAt);
      if (!allocation) fail('Choose a piece still awaiting return.');
      allocation.lostAt = new Date(); allocation.disposition = 'LOST';
      b.replacements.push({ type: 'LOSS', assetId: allocation.assetId, evidence: A.text(input.evidenceUrl, 500), note: A.text(input.note, 1000), at: new Date() });
      await M.Asset.updateOne({ storeId: store._id, _id: allocation.assetId, currentBookingId: b._id }, { $set: { status: 'LOST', condition: A.text(input.note, 1000) }, $inc: { revision: 1 } }, { session });
      if (b.allocations.every(a => a.receivedAt || a.lostAt)) b.status = 'RETURNED';
    } else if (action === 'INSPECT' || action === 'RELEASE') {
      const allocation = b.allocations.find(a => String(a.assetId) === A.id(input.assetId));
      if ((!allocation?.receivedAt && !(action === 'RELEASE' && allocation?.lostAt)) || allocation.readyAt) fail('Choose a returned/lost piece awaiting inspection or final disposition.');
      const asset = await M.Asset.findOne({ storeId: store._id, _id: allocation.assetId, currentBookingId: b._id }).session(session);
      if (!asset) fail('Piece assignment changed.');
      if (action === 'INSPECT') {
        if (!['CLEANING', 'REPAIR', 'LOST'].includes(input.disposition) || !input.note) fail('Record the condition and cleaning/repair/loss disposition.', 'VALIDATION_ERROR');
        asset.status = input.disposition; asset.condition = A.text(input.note, 1000); allocation.disposition = input.disposition;
      } else {
        if (!['CLEANING', 'REPAIR', 'LOST'].includes(asset.status)) fail('Inspect this piece before releasing it.');
        if (!input.note) fail('Record the cleaning/repair verification.', 'VALIDATION_ERROR');
        const lost = asset.status === 'LOST';
        const future = await M.Reservation.exists({ storeId: store._id, assetId: asset._id, bookingId: { $ne: b._id }, active: true, $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] }).session(session);
        if (lost && future) fail('Reassign/cancel future bookings before retiring a lost piece.');
        asset.status = lost ? 'RETIRED' : 'READY'; asset.currentBookingId = undefined; asset.returnDueAt = undefined; allocation.readyAt = new Date();
        await M.Reservation.updateMany({ storeId: store._id, bookingId: b._id, assetId: asset._id }, { $set: { active: false } }, { session });
      }
      asset.revision += 1; await asset.save({ session });
    } else if (action === 'CANCEL') {
      await assertNoOpenCourier(b, session);
      if (!['HELD', 'CONFIRMED', 'PREPARING', 'READY'].includes(b.status)) fail('Cancellation is not available after handover.');
      if (!input.note) fail('Record the cancellation reason.', 'VALIDATION_ERROR');
      b.adjustedRentalPaise = input.retainedRentalPaise !== undefined ? A.integer(input.retainedRentalPaise, 'retained rental charge', 0, A.paidRent(b)) : input.ownerFault === true ? 0 : b.cancellationChargesPaise + Math.min(A.cancellationRent(b), Math.max(0, A.paidRent(b) - b.cancellationChargesPaise));
      b.status = 'CANCELLED'; b.cancelledReason = A.text(input.note, 1000);
      for (const request of b.requests.filter(row => row.type === 'CANCEL' && row.status === 'PENDING')) { request.status = 'RESOLVED'; request.resolvedAt = new Date(); request.responseNote = b.cancelledReason; }
      await studio.cancelWork(store, b, session, actorId);
      await M.Reservation.updateMany({ storeId: store._id, bookingId: b._id }, { $set: { active: false } }, { session });
    } else if (action === 'NO_SHOW') {
      await assertNoOpenCourier(b, session);
      if (!['CONFIRMED', 'PREPARING', 'READY'].includes(b.status) || Date.now() < +b.schedule.pickupAt + (b.policy.noShowGraceHours ?? 24) * A.HOUR || !input.note) fail('Record no-show only after the agreed pickup grace period and before handover.', 'VALIDATION_ERROR');
      b.adjustedRentalPaise = Math.min(A.paidRent(b), Math.ceil(b.quote.rentalPaise * (b.policy.noShowRetainPercent ?? 100) / 100));
      b.status = 'CANCELLED'; b.noShowAt = new Date(); b.cancelledReason = A.text(input.note, 1000);
      await studio.cancelWork(store, b, session, actorId);
      await M.Reservation.updateMany({ storeId: store._id, bookingId: b._id }, { $set: { active: false } }, { session });
    } else if (action === 'ASSESS') {
      if (!['OUT', 'RETURNED'].includes(b.status)) fail('Assessment is only available for a handed-over rental.');
      if (!['DAMAGE', 'LOSS', 'LATE', 'OTHER'].includes(input.type)) fail('Choose an assessment type.', 'VALIDATION_ERROR');
      const amountPaise = A.integer(input.amountPaise, 'assessment amount', 1);
      const evidence = (input.evidence || []).map(v => A.text(v, 500));
      if (evidence.length > 10 || evidence.some(v => !/^https:\/\//.test(v))) fail('Use up to 10 HTTPS evidence links.', 'VALIDATION_ERROR');
      if (['DAMAGE', 'LOSS'].includes(input.type) && !evidence.length) fail('Damage/loss deductions need evidence.', 'VALIDATION_ERROR');
      if (!input.note) fail('Provide an itemised assessment reason.', 'VALIDATION_ERROR');
      b.assessments.push({ operationId: input.operationId, type: input.type, amountPaise, evidence, reason: A.text(input.note, 1000), approved: true, actorId, at: new Date() });
    } else if (action === 'WAIVE_ASSESSMENT') {
      if (!['OUT', 'RETURNED'].includes(b.status) || !input.note) fail('Record a reason for waiving an assessment on an active/returned rental.');
      const assessment = b.assessments.find(a => a.operationId === input.assessmentId && a.approved);
      if (!assessment) fail('Approved assessment not found.', 'NOT_FOUND');
      assessment.approved = false;
    } else if (action === 'LOGISTICS') {
      if (!['outbound', 'inbound'].includes(input.direction) || !b.policy.deliveryModes.includes(input.mode)) fail('Choose a delivery direction and enabled method.', 'VALIDATION_ERROR');
      await assertNoOpenCourier(b, session, input.direction);
      const scheduledAt = A.date(input.scheduledAt);
      b.logistics[input.direction] = { mode: input.mode, scheduledAt, carrier: A.text(input.carrier || '', 100), trackingId: A.text(input.trackingId || '', 120), trackingUrl: A.text(input.trackingUrl || '', 500), proof: A.text(input.proof || '', 1000), status: A.text(input.deliveryStatus || 'SCHEDULED', 80) };
      if (b.logistics[input.direction].trackingUrl && !/^https:\/\//.test(b.logistics[input.direction].trackingUrl)) fail('Use an HTTPS tracking URL.', 'VALIDATION_ERROR');
    } else if (action === 'TRIAL') {
      await studio.scheduleTrial(store, b, input, session);
    } else if (action === 'TRIAL_UPDATE') {
      await studio.updateTrial(store, b, input, session);
    } else if (action === 'REOPEN_SETTLEMENT') {
      if (b.status !== 'CLOSED' || !input.note) fail('Reopen only a closed settlement and record the review reason.');
      b.status = ['RETURNED', 'CANCELLED', 'EXPIRED'].includes(b.closedFromStatus) ? b.closedFromStatus : 'RETURNED';
      await M.Proof.updateMany({ storeId: store._id, bookingId: b._id }, { $unset: { expiresAt: 1 } }, { session });
    } else if (action === 'CLOSE') {
      if (!['RETURNED', 'CANCELLED', 'EXPIRED'].includes(b.status) || (b.status === 'RETURNED' && b.allocations.some(a => !a.readyAt))) fail('Complete returns and piece disposition before closing.');
      if (b.requests.some(r => r.status === 'PENDING')) fail('Resolve pending customer requests/disputes before closing the settlement.');
      const financial = A.finances(b);
      if (financial.refundablePaise || financial.balancePaise || b.ledger.some(e => e.kind === 'REFUND' && !['FAILED', 'PROCESSED'].includes(e.status))) fail('Resolve outstanding charges/deposit refunds before closing.');
      b.closedFromStatus = b.status; b.status = 'CLOSED';
      await M.Proof.updateMany({ storeId: store._id, bookingId: b._id }, { $set: { expiresAt: new Date(Date.now() + 180 * A.DAY) } }, { session });
    } else fail('Unsupported rental operation.', 'VALIDATION_ERROR');
    return event(b, action, input, actorId, session);
  });
}
async function requestChange(store, bookingId, input, userId) {
  return transaction(store, async session => {
    const b = await getBooking(store, bookingId, session, userId);
    if (!checkOperation(b, input)) return present(b, { staff: false });
    if (!['CANCEL', 'RESCHEDULE', 'EXTEND', 'RETURN_COLLECTION', 'DISPUTE'].includes(input.type)) fail('Choose a supported booking request.', 'VALIDATION_ERROR');
    if (['CANCEL', 'RESCHEDULE'].includes(input.type) && !['HELD', 'CONFIRMED', 'PREPARING', 'READY'].includes(b.status)) fail('This booking can no longer be cancelled/rescheduled online.');
    if (['EXTEND', 'RETURN_COLLECTION'].includes(input.type) && b.status !== 'OUT') fail('This request needs an active rental.');
    if (b.requests.filter(r => r.status === 'PENDING').length >= 5) fail('Wait for your pending requests to be reviewed.');
    b.requests.push({ operationId: input.operationId, type: input.type, status: 'PENDING', pickupAt: input.pickupAt ? A.date(input.pickupAt) : undefined, returnDueAt: input.returnDueAt ? A.date(input.returnDueAt) : undefined, note: A.text(input.note || '', 1000), createdAt: new Date() });
    await event(b, 'CUSTOMER_REQUEST', input, userId, session); return present(b, { staff: false });
  });
}
async function reschedule(store, bookingId, input, actorId) {
  return transaction(store, async session => {
    const b = await getBooking(store, bookingId, session);
    if (!checkOperation(b, input)) return present(b);
    await require('./rentalStudioService').assertChangeSafe(store, b, session);
    await assertNoOpenCourier(b, session, b.status === 'OUT' ? 'inbound' : undefined);
    if (!['CONFIRMED', 'PREPARING', 'READY', 'OUT'].includes(b.status)) fail('This booking cannot change dates.');
    const policy = A.validatePolicy(b.policy, { existing: true });
    const dates = A.schedule({ ...(b.schedule.useDates ? { useDates: b.schedule.useDates } : {}), ...input, eventAt: input.eventAt || (b.schedule.eventAt ? new Date(b.schedule.eventAt).toISOString() : undefined) }, policy, new Date(), { existing: b.status === 'OUT', allowImmediate: true });
    if (b.status === 'OUT' && b.allocations.some(a => a.receivedAt || a.lostAt)) fail('An extension is unavailable after any pieces have been returned or declared lost.');
    if (b.status === 'OUT' && (+dates.pickupAt !== +b.schedule.pickupAt || +dates.returnDueAt <= +b.schedule.returnDueAt)) fail('An active rental can only extend its return deadline.');
    const assets = await M.Asset.find({ storeId: store._id, _id: { $in: b.allocations.map(a => a.assetId) } }).session(session).lean();
    if (assets.length !== b.allocations.length || assets.some(a => a.status !== 'READY' && !(b.status === 'OUT' && String(a.currentBookingId) === String(b._id)))) fail('Allocated pieces are not available for a date change.');
    if (await M.Reservation.exists({ storeId: store._id, assetId: { $in: assets.map(a => a._id) }, bookingId: { $ne: b._id }, active: true, blockedFrom: { $lt: dates.blockedUntil }, blockedUntil: { $gt: dates.blockedFrom }, $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] }).session(session)) fail('New dates conflict with another booking. Existing dates remain unchanged.', 'OUT_OF_STOCK');
    await assertSlotCapacity(store, dates, policy, session, b._id);
    const lines = b.quote.items.map(i => ({ listing: { _id: i.listingId, productId: i.productId, title: i.title, image: i.image, components: i.components, ...i.rules }, quantity: i.quantity }));
    const price = A.quote(lines, dates, policy, b.quote.deliveryMode, b.quote.paymentPlan || 'ADVANCE');
    if (price.paymentPlan === 'PICKUP' || dates.billingBasis === 'USE_DAYS') dates.balanceDueAt = dates.pickupAt;
    if (input.acceptPricePaise !== price.totalPaise + b.cancellationChargesPaise) fail(`Date change total is ${(price.totalPaise + b.cancellationChargesPaise) / 100} INR. Explicitly accept this amount.`, 'VALIDATION_ERROR');
    b.acceptedQuote ||= JSON.parse(JSON.stringify(b.quote));
    b.quote = price; b.adjustedRentalPaise = price.rentalPaise + b.cancellationChargesPaise; b.schedule = dates;
    await M.Reservation.updateMany({ storeId: store._id, bookingId: b._id, active: true, kind: 'BOOKING' }, { $set: { blockedFrom: dates.blockedFrom, blockedUntil: dates.blockedUntil } }, { session });
    if (b.status === 'OUT') await M.Asset.updateMany({ storeId: store._id, currentBookingId: b._id }, { $set: { returnDueAt: dates.returnDueAt }, $inc: { revision: 1 } }, { session });
    if (input.requestId) { const r = b.requests.find(r => r.operationId === input.requestId && r.status === 'PENDING'); if (!r) fail('Pending request not found.'); r.status = 'APPROVED'; }
    return event(b, 'DATES_CHANGED', input, actorId, session);
  });
}
async function replacePiece(store, bookingId, input, actorId) {
  return transaction(store, async session => {
    const b = await getBooking(store, bookingId, session);
    if (!checkOperation(b, input)) return present(b);
    await require('./rentalStudioService').assertChangeSafe(store, b, session);
    await assertNoOpenCourier(b, session);
    if (!['HELD', 'CONFIRMED', 'PREPARING', 'READY'].includes(b.status) || (b.status === 'HELD' && +b.expiresAt <= Date.now())) fail('Replace a piece before handover, while the reservation is active.');
    if (input.customerAcknowledged !== true || !input.note) fail('Record customer approval and the reason before substituting a physical piece.', 'VALIDATION_ERROR');
    const allocation = b.allocations.find(a => String(a.assetId) === A.id(input.assetId));
    if (!allocation) fail('Allocated piece not found.');
    const old = await M.Asset.findOne({ _id: allocation.assetId, storeId: store._id }).session(session).lean();
    const replacement = await M.Asset.findOne({ _id: A.id(input.replacementId), storeId: store._id, poolKey: old.poolKey, $or: [{ status: 'READY', currentBookingId: null }, { status: 'OUT', returnDueAt: { $gt: new Date() } }] }).session(session).lean();
    if (!replacement || replacement.saleConversion || (allocation.binding && !inventoryRules.matchesPiece(replacement, allocation.binding, { matchingVersion: 2, requirements: [allocation.binding] })) || b.allocations.some(a => String(a.assetId) === String(replacement._id))) fail('Choose an available, different piece matching the accepted product/variant/size/colour from the same component pool.', 'OUT_OF_STOCK');
    if (await M.Reservation.exists({ storeId: store._id, assetId: replacement._id, active: true, blockedFrom: { $lt: b.schedule.blockedUntil }, blockedUntil: { $gt: b.schedule.blockedFrom }, $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] }).session(session)) fail('The replacement is reserved for these dates.', 'OUT_OF_STOCK');
    await M.Reservation.updateMany({ storeId: store._id, bookingId: b._id, assetId: old._id }, { $set: { active: false } }, { session });
    await M.Reservation.create([{ storeId: store._id, bookingId: b._id, assetId: replacement._id, blockedFrom: b.schedule.blockedFrom, blockedUntil: b.schedule.blockedUntil, expiresAt: b.status === 'HELD' ? b.expiresAt : null }], { session });
    b.replacements.push({ type: 'SUBSTITUTION', oldAssetId: old._id, oldCode: old.code, assetId: replacement._id, code: replacement.code, note: A.text(input.note, 1000), acknowledged: true, at: new Date() });
    allocation.assetId = replacement._id; allocation.code = replacement.code; allocation.label = replacement.label;
    if (b.status === 'READY') b.status = 'PREPARING';
    return event(b, 'PIECE_REPLACED', input, actorId, session);
  });
}
async function cancelItems(store, bookingId, input, actorId) {
  return transaction(store, async session => {
    const b = await getBooking(store, bookingId, session);
    if (!checkOperation(b, input)) return present(b);
    await require('./rentalStudioService').assertChangeSafe(store, b, session);
    await assertNoOpenCourier(b, session);
    if (!['CONFIRMED', 'PREPARING', 'READY'].includes(b.status) || !input.note) fail('Partial cancellation requires a confirmed booking before handover and a reason.');
    if (await M.Payment.exists({ storeId: store._id, bookingId: b._id, state: { $in: ['CREATING', 'PENDING', 'REVIEW'] } }).session(session)) fail('Resolve the pending online payment before changing rental items.');
    const listingId = A.id(input.listingId), removed = b.quote.items.find(i => String(i.listingId) === listingId);
    if (!removed || b.quote.items.length <= 1) fail('Choose a rental line; use full cancellation when removing the last line.', 'VALIDATION_ERROR');
    const allocations = b.allocations.filter(a => String(a.listingId) === listingId);
    const retained = input.ownerFault === true ? 0 : Math.min(A.cancellationRent({ ...b.toObject(), quote: { rentalPaise: removed.rentPaise + removed.feesPaise } }), Math.max(0, A.paidRent(b) - b.cancellationChargesPaise));
    b.acceptedQuote ||= JSON.parse(JSON.stringify(b.quote));
    b.cancelledItems.push({ ...removed, retainedPaise: retained, note: A.text(input.note, 1000), allocations: allocations.map(a => ({ assetId: a.assetId, code: a.code })), at: new Date() });
    b.cancellationChargesPaise += retained;
    const lines = b.quote.items.filter(i => String(i.listingId) !== listingId).map(i => ({ listing: { _id: i.listingId, productId: i.productId, title: i.title, image: i.image, components: i.components, ...i.rules }, quantity: i.quantity }));
    const price = A.quote(lines, b.schedule, b.policy, b.quote.deliveryMode, b.quote.paymentPlan || 'ADVANCE');
    if (input.acceptPricePaise !== price.totalPaise + b.cancellationChargesPaise) fail(`Remaining total, including retained cancellation charges, is ${(price.totalPaise + b.cancellationChargesPaise) / 100} INR. Record customer acceptance.`, 'VALIDATION_ERROR');
    b.quote = price; b.adjustedRentalPaise = price.rentalPaise + b.cancellationChargesPaise;
    b.allocations = b.allocations.filter(a => String(a.listingId) !== listingId);
    await M.Reservation.updateMany({ storeId: store._id, bookingId: b._id, assetId: { $in: allocations.map(a => a.assetId) } }, { $set: { active: false } }, { session });
    return event(b, 'ITEMS_CANCELLED', input, actorId, session);
  });
}
async function resolveRequest(store, bookingId, input, actorId) {
  return transaction(store, async session => {
    const b = await getBooking(store, bookingId, session);
    if (!checkOperation(b, input)) return present(b);
    const request = b.requests.find(r => r.operationId === input.requestId && r.status === 'PENDING');
    if (!request || !['RESOLVED', 'REJECTED'].includes(input.status) || !input.note) fail('Select a pending request and record its resolution.', 'VALIDATION_ERROR');
    request.status = input.status;
    return event(b, 'REQUEST_REVIEWED', input, actorId, session);
  });
}
async function createPayment(store, bookingId, input, userId) {
  A.operation(input.operationId);
  const settings = await Settings.findOne(store.isDefault ? defaultStoreFilter(store._id) : { storeId: store._id }).lean();
  if (!settings?.razorpayEnabled || !gateway.isRazorpayConfigured()) fail('Online payments are not configured. Contact the store.', 'PAYMENT_METHOD_UNAVAILABLE');
  const methods = require('./paymentSettingsService').buildPaymentOptions(settings, { razorpayConfigured: gateway.isRazorpayConfigured() }).filter(m => m.provider === 'Razorpay' && m.enabled);
  const method = input.method || methods[0]?.key;
  if (!methods.some(m => m.key === method)) fail('Choose an enabled online payment method.', 'PAYMENT_METHOD_UNAVAILABLE');
  const payment = await transaction(store, async session => {
    const b = await getBooking(store, bookingId, session, userId);
    if (b.status === 'HELD') assertStoreCanAcceptOrders(store, { rental: true });
    const previous = await M.Payment.findOne({ storeId: store._id, bookingId: b._id, operationId: input.operationId }).session(session);
    if (previous) return previous.toObject();
    if (!['HELD', 'CONFIRMED', 'PREPARING', 'READY', 'OUT', 'RETURNED'].includes(b.status) || (b.status === 'HELD' && +b.expiresAt <= Date.now())) fail('Booking cannot take payment in its current state.');
    const pending = await M.Payment.findOne({ storeId: store._id, bookingId: b._id, $or: [{ state: { $in: ['CREATING', 'PENDING', 'REVIEW'] } }, { state: 'FAILED', orderId: { $type: 'string' } }] }).session(session);
    if (pending) return pending.toObject();
    const finance = A.finances(b);
    const amountPaise = b.status === 'HELD' ? Math.max(0, b.quote.dueNowPaise - finance.collectedPaise) : finance.balancePaise;
    if (!amountPaise) fail('No payment is currently due.');
    const [row] = await M.Payment.create([{ storeId: store._id, bookingId: b._id, operationId: input.operationId, amountPaise, preferredMethod: method }], { session }); return row.toObject();
  });
  if (payment.state === 'CREATING' && !payment.createdAt) fail('Payment setup is pending. Retry shortly.');
  if (payment.state === 'FAILED' && !payment.orderId) fail('The provider rejected this payment setup. Correct payment settings or use a new payment attempt/manual receipt.', 'PAYMENT_SETUP_REJECTED');
  if (payment.orderId) return paymentHandle(payment);
  // Claim external setup once. A crash/unknown response is REVIEW, not an automatic duplicate.
  const claimed = await M.Payment.findOneAndUpdate({ _id: payment._id, state: 'CREATING', updatedAt: payment.createdAt }, { $set: { state: 'REVIEW' } }, { new: true });
  if (!claimed) fail('Payment setup is pending review. Contact the store.');
  try {
    const order = await gateway.createRazorpayOrder({ amountInPaise: payment.amountPaise, receipt: String(payment._id), notes: { purpose: 'rental', rentalPaymentId: String(payment._id), rentalBookingId: String(payment.bookingId), storeId: String(store._id) } });
    const result = await M.Payment.findOneAndUpdate({ _id: payment._id, state: 'REVIEW', orderId: { $exists: false } }, { $set: { orderId: order.id, state: 'PENDING' } }, { new: true }).lean();
    if (!result) fail('Payment setup changed. Reload the booking.');
    return paymentHandle(result);
  } catch (e) {
    const rejected = e.razorpayDefinitiveRejection === true;
    const changed = await M.Payment.updateOne({ _id: payment._id, state: 'REVIEW', orderId: { $exists: false } }, { $set: { state: rejected ? 'FAILED' : 'REVIEW', setupFailure: rejected ? 'REJECTED' : 'UNKNOWN', lastRecoveryError: rejected ? 'Payment provider explicitly rejected setup. No order was created.' : 'Provider outcome is unknown. Check the provider before retrying.', nextCheckAt: new Date() } });
    if (rejected && changed.modifiedCount) fail('Payment setup was rejected by the provider. Correct payment settings, retry with a new attempt, or contact the store for a manual receipt.', 'PAYMENT_SETUP_REJECTED');
    throw new ApiError('SERVICE_UNAVAILABLE', 'Payment setup could not be confirmed. Contact the store before retrying.');
  }
}
function paymentHandle(payment) { return { orderId: payment.orderId, amountPaise: payment.amountPaise, preferredMethod: payment.preferredMethod, keyId: process.env.RAZORPAY_KEY_ID, currency: 'INR' }; }
async function processCaptured(payment, entity) {
  if (entity.currency !== 'INR' || Number(entity.amount) !== payment.amountPaise || !entity.id || entity.order_id !== payment.orderId || entity.status !== 'captured') fail('Rental payment amount/currency/order did not match.', 'PAYMENT_FAILED');
  const store = await Store.findById(payment.storeId).lean(); if (!store) fail('Rental store not found.', 'NOT_FOUND');
  let platform;
  try { platform = await require('./controlPlaneClient').licenseStatus(); } catch { platform = { managed: true, status: 'UNAVAILABLE' }; }
  return transaction(store, async session => {
    const row = await M.Payment.findOne({ _id: payment._id, storeId: store._id }).session(session);
    const b = await getBooking(store, payment.bookingId, session);
    if (row.state === 'CAPTURED') { if (row.paymentId !== entity.id) fail('A different payment was already recorded.'); return present(b); }
    row.state = 'CAPTURED'; row.paymentId = entity.id; await row.save({ session });
    // Persist once with the capture transaction; the browser cannot report verified payment.
    await require('../models/AnalyticsEvent').create([{ name: 'RENTAL_PAYMENT_VERIFIED', storeId: store._id, metadata: { amountPaise: row.amountPaise }, expiresAt: new Date(Date.now() + 90 * 86400000) }], { session });
    b.ledger.push({ operationId: `pay_${String(row._id)}`, kind: 'COLLECTION', amountPaise: row.amountPaise, method: 'RAZORPAY', paymentId: entity.id, paymentOrderId: row.orderId, reference: entity.id, status: 'PROCESSED', at: new Date() });
    await confirmIfPaid(b, session, { store, platform, captured: true });
    // An expired/cancelled hold is never revived by a delayed payment.
    if (b.status === 'CLOSED') b.status = b.closedFromStatus || 'EXPIRED';
    if (b.status === 'EXPIRED') b.adjustedRentalPaise = 0;
    return event(b, b.status === 'CONFIRMED' ? 'CONFIRMED' : ['EXPIRED', 'CANCELLED', 'CLOSED'].includes(b.status) ? 'LATE_PAYMENT_REVIEW' : 'PAYMENT_RECEIVED', { operationId: `pay_${row._id}`, note: 'Captured payment verified with the payment provider.' }, undefined, session);
  });
}
async function verifyPayment(store, bookingId, input, userId) {
  const b = await getBooking(store, bookingId, null, userId);
  const payment = await M.Payment.findOne({ storeId: store._id, bookingId: b._id, orderId: input.razorpay_order_id }).lean();
  if (!payment) fail('Rental payment order not found.', 'NOT_FOUND');
  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '').update(`${payment.orderId}|${input.razorpay_payment_id}`).digest('hex');
  if (!/^[a-f\d]{64}$/i.test(input.razorpay_signature || '') || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(input.razorpay_signature))) fail('Payment signature failed.', 'PAYMENT_FAILED');
  let entity;
  if (process.env.NODE_ENV === 'test' && process.env.RAZORPAY_MOCK === '1') entity = { id: input.razorpay_payment_id, order_id: payment.orderId, amount: payment.amountPaise, currency: 'INR', status: 'captured' };
  else {
    const response = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(A.text(input.razorpay_payment_id, 120))}`, { headers: { Authorization: `Basic ${Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64')}` }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) fail('Payment could not be verified. A webhook will reconcile it.', 'SERVICE_UNAVAILABLE');
    entity = await response.json();
  }
  await processCaptured(payment, entity);
  return present(await getBooking(store, bookingId, null, userId), { staff: false });
}
async function refund(store, bookingId, input, actorId) {
  A.operation(input.operationId); A.integer(input.amountPaise, 'refund amount', 1);
  if (!input.note) fail('A refund reason is required.', 'VALIDATION_ERROR');
  const prepared = await transaction(store, async session => {
    const b = await getBooking(store, bookingId, session);
    const previous = b.ledger.find(e => e.operationId === input.operationId && e.kind === 'REFUND');
    if (previous) return { booking: present(b), existing: true };
    if (!checkOperation(b, input)) fail('Operation ID belongs to a different operation.');
    if (!['RETURNED', 'CANCELLED', 'EXPIRED'].includes(b.status) && !b.cancelledItems?.length) fail('Return/inspection or cancellation must precede deposit settlement.');
    if (b.status === 'RETURNED' && b.allocations.some(a => !a.disposition && !a.readyAt)) fail('Inspect every returned piece before settling its deposit.');
    if (input.amountPaise > A.finances(b).refundablePaise) fail('Refund exceeds the refundable balance.', 'VALIDATION_ERROR');
    const collection = b.ledger.find(e => e.kind === 'COLLECTION' && e.reference === input.paymentReference);
    if (!collection) fail('Select the original receipt/payment.', 'VALIDATION_ERROR');
    const reserved = b.ledger.filter(e => e.kind === 'REFUND' && e.reference === collection.reference && e.status !== 'FAILED').reduce((n, e) => n + e.amountPaise, 0);
    if (input.amountPaise + reserved > collection.amountPaise) fail('Refund exceeds this receipt’s remaining amount.', 'VALIDATION_ERROR');
    const online = collection.method === 'RAZORPAY';
    if (!online && !input.refundReference) fail('Record the actual cash/bank refund receipt reference.', 'VALIDATION_ERROR');
    if (!online && await M.Booking.exists({ storeId: store._id, ledger: { $elemMatch: { kind: 'REFUND', method: collection.method, refundId: A.text(input.refundReference, 120), status: 'PROCESSED' } } }).session(session)) fail('This refund receipt/transaction has already been recorded.');
    b.ledger.push({ operationId: input.operationId, kind: 'REFUND', amountPaise: input.amountPaise, method: collection.method, reference: collection.reference, paymentId: collection.paymentId, refundId: online ? undefined : A.text(input.refundReference, 120), status: online ? 'PENDING' : 'PROCESSED', reason: A.text(input.note, 1000), actorId, at: new Date() });
    await event(b, 'REFUND_QUEUED', input, actorId, session);
    return { booking: present(b), online, paymentId: collection.paymentId };
  });
  if (prepared.existing || !prepared.online) return prepared.booking;
  const key = `rental_${crypto.createHash('sha256').update(`${store._id}:${bookingId}:${input.operationId}`).digest('hex').slice(0, 48)}`;
  try {
    const result = await gateway.refundRazorpayPayment({ paymentId: prepared.paymentId, amountInPaise: input.amountPaise, idempotencyKey: key, notes: { purpose: 'rental', rentalBookingId: String(bookingId), rentalOperationId: input.operationId } });
    await transaction(store, async session => {
      const b = await getBooking(store, bookingId, session);
      const row = b.ledger.find(e => e.kind === 'REFUND' && e.operationId === input.operationId);
      if (row.status !== 'PROCESSED') { row.refundId = result.id; row.status = result.status === 'processed' ? 'PROCESSED' : 'INITIATED'; await b.save({ session }); }
    });
  } catch {
    // Unknown provider outcomes remain reserved, preventing a second refund.
    await transaction(store, async session => { const b = await getBooking(store, bookingId, session); const row = b.ledger.find(e => e.operationId === input.operationId); if (row.status === 'PENDING') { row.status = 'REVIEW'; await b.save({ session }); } });
  }
  return present(await getBooking(store, bookingId));
}
async function handleWebhook(payload) {
  const entity = payload.payload?.payment?.entity;
  const refundEntity = payload.payload?.refund?.entity;
  if (mongoose.connection.readyState !== 1) {
    if (entity?.notes?.purpose === 'rental' || refundEntity?.notes?.purpose === 'rental') fail('Rental payment reconciliation needs the database connection.', 'SERVICE_UNAVAILABLE');
    return false;
  }
  const orderId = entity?.order_id || payload.payload?.order?.entity?.id;
  let payment = orderId ? await M.Payment.findOne({ orderId }).lean() : null;
  if (!payment && entity?.notes?.purpose === 'rental' && /^[a-f\d]{24}$/i.test(entity.notes.rentalPaymentId || '')) {
    payment = await M.Payment.findById(entity.notes.rentalPaymentId).lean();
    if (payment && !payment.orderId && payment.amountPaise === Number(entity.amount) && String(payment.storeId) === entity.notes.storeId) {
      await M.Payment.updateOne({ _id: payment._id, orderId: { $exists: false } }, { $set: { orderId, state: 'PENDING' } }); payment.orderId = orderId;
    }
  }
  if (payment) {
    if (payload.event === 'payment.captured' || payload.event === 'order.paid') {
      if (!entity) return true;
      await processCaptured(payment, entity);
    } else if (payload.event === 'payment.failed') await M.Payment.updateOne({ _id: payment._id, state: { $ne: 'CAPTURED' } }, { $set: { state: 'REVIEW', lastRecoveryError: 'A payment attempt failed; the provider order remains open. Resume the same online order or recheck the provider before collecting again.' } });
    return true;
  }
  if (refundEntity && /^refund\./.test(payload.event)) {
    const b = await M.Booking.findOne({ 'ledger.paymentId': refundEntity.payment_id, $or: [{ 'ledger.refundId': refundEntity.id }, { _id: mongoose.isValidObjectId(refundEntity.notes?.rentalBookingId) ? refundEntity.notes.rentalBookingId : null }] }).lean();
    if (!b) return false;
    const store = await Store.findById(b.storeId).lean();
    await transaction(store, async session => {
      const booking = await getBooking(store, b._id, session);
      const row = booking.ledger.find(e => e.kind === 'REFUND' && (e.refundId === refundEntity.id || e.operationId === refundEntity.notes?.rentalOperationId) && e.paymentId === refundEntity.payment_id);
      if (!row || row.amountPaise !== Number(refundEntity.amount) || refundEntity.currency !== 'INR') fail('Rental refund did not match a reserved refund.', 'PAYMENT_FAILED');
      if (row.status === 'PROCESSED') return;
      row.refundId = refundEntity.id; row.status = payload.event === 'refund.processed' ? 'PROCESSED' : payload.event === 'refund.failed' ? 'FAILED' : row.status;
      await event(booking, row.status === 'PROCESSED' ? 'REFUND_PROCESSED' : 'REFUND_ATTENTION', { operationId: `refund_${refundEntity.id}_${row.status}`, note: 'Refund status confirmed by payment provider.' }, undefined, session);
    });
    return true;
  }
  return false;
}
async function expireHolds(store) {
  return transaction(store, async session => {
    const rows = await M.Booking.find({ storeId: store._id, status: 'HELD', expiresAt: { $lte: new Date() } }).limit(100).session(session);
    for (const b of rows) { b.status = 'EXPIRED'; b.adjustedRentalPaise = 0; await require('./rentalStudioService').cancelWork(store, b, session); await M.Reservation.updateMany({ storeId: store._id, bookingId: b._id }, { $set: { active: false } }, { session }); await event(b, 'EXPIRED', { operationId: `expire_${b._id}` }, undefined, session); }
  });
}
function publicOffer(row, status) {
  const { _id, productId, variantId, title, size, colour, dailyRatePaise, depositPaise, packages, cleaningFeePaise, alterationFeePaise, notes, fitting, advanceMode, advancePercent, advanceAmountPaise } = row;
  return { _id, productId, variantId, title, size, colour, dailyRatePaise, depositPaise, packages, cleaningFeePaise, alterationFeePaise, notes, fitting, advanceMode, advancePercent, advanceAmountPaise,
    includedItems: status.components.map(c => ({ label: c.label, quantity: c.required })), readiness: { ready: status.ready, reasons: status.reasons } };
}
async function publicListings(store, productId) {
  const config = await readConfiguration(store);
  const product = await Product.findOne({ $and: [productFilter(store, productId), inventoryRules.publishedRentalFilter()] }).select('_id').lean();
  const reasons = [];
  if (config.mode === 'SALE_ONLY') reasons.push({ code: 'RENTALS_DISABLED', message: 'This store has not enabled rentals.' });
  if (!product) reasons.push({ code: 'PRODUCT_UNAVAILABLE', message: 'This product is not published for rental.' });
  const rows = product ? await M.Listing.find({ storeId: store._id, productId: product._id }).sort('dailyRatePaise _id').limit(50).lean() : [];
  const statuses = await require('./rentalSetupService').batchReadiness(store, rows);
  const live = rows.filter(row => row.active && statuses.get(String(row._id)).ready);
  if (product && !live.length) {
    if (!rows.length || rows.every(row => !row.active)) reasons.push({ code: 'OFFER_INACTIVE', message: 'The store is completing rental setup for this product.' });
    for (const row of rows.filter(row => row.active)) reasons.push(...statuses.get(String(row._id)).reasons);
  }
  if (!config.readiness.acceptingOrders) reasons.push({ code: 'ORDERS_PAUSED', message: config.readiness.pauseMessage });
  if (!config.readiness.onlinePayments && !config.policy.paymentPlans?.includes('PICKUP')) reasons.push({ code: 'ONLINE_PAYMENT_UNAVAILABLE', message: 'Online payment is unavailable. Contact the store to discuss a rental request.' });
  return { enabled: config.mode !== 'SALE_ONLY', timezone: config.policy.timezone, policy: config.policy, policyRevision: config.revision,
    readiness: { ...config.readiness, bookable: config.mode !== 'SALE_ONLY' && live.length > 0 && config.readiness.acceptingOrders && (config.readiness.onlinePayments || config.policy.paymentPlans?.includes('PICKUP')), reasons },
    contact: config.contact, listings: config.mode === 'SALE_ONLY' ? [] : live.map(row => publicOffer(row, statuses.get(String(row._id)))) };
}
async function catalogue(store, query = {}, { all = false } = {}) {
  const configuration = await readConfiguration(store);
  if (configuration.mode === 'SALE_ONLY') return { configuration, rows: [], total: 0, page: 1, pages: 0 };
  const page = A.integer(Number(query.page || 1), 'page', 1, 10000);
  const filter = { storeId: store._id, active: true };
  if (query.minRent !== undefined || query.maxRent !== undefined) {
    const min = query.minRent !== undefined ? A.integer(Math.round(Number(query.minRent) * 100), 'minimum daily rent', 0) : 0;
    const max = query.maxRent !== undefined ? A.integer(Math.round(Number(query.maxRent) * 100), 'maximum daily rent', 0) : 100000000;
    if (max < min) fail('Maximum daily rent must be at least the minimum.', 'VALIDATION_ERROR');
    filter.dailyRatePaise = { $gte: min, $lte: max };
  }
  if (query.productId) filter.productId = A.id(query.productId);
  if (query.listingIds) {
    if (typeof query.listingIds !== 'string' || query.listingIds.split(',').length > 10) fail('Choose at most 10 rental listing IDs.', 'VALIDATION_ERROR');
    filter._id = { $in: query.listingIds.split(',').map(A.id) };
  }
  if (query.size) filter.size = A.text(query.size, 80);
  if (query.colour) filter.colour = A.text(query.colour, 80);
  const productQuery = { $and: [store.isDefault ? defaultStoreFilter(store._id) : { storeId: store._id }, inventoryRules.publishedRentalFilter()] };
  if (query.category) productQuery.category = A.id(query.category);
  if (query.search) { const search = A.text(query.search, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); productQuery.name = new RegExp(search, 'i'); }
  const products = await Product.find(productQuery).select('_id name slug images category commerceMode sizes colors').lean();
  const productMap = new Map(products.map(p => [String(p._id), p]));
  if (filter.productId && !productMap.has(String(filter.productId))) return { configuration, rows: [], total: 0, page, pages: 0 };
  if (!filter.productId) filter.productId = { $in: products.map(p => p._id) };
  const offers = await M.Listing.find(filter).sort('title _id').lean();
  const statuses = await require('./rentalSetupService').batchReadiness(store, offers);
  const eligible = offers.filter(row => statuses.get(String(row._id)).ready);
  if (query.sort === 'priceLowHigh' || query.sort === 'priceHighLow') eligible.sort((a, b) => (a.dailyRatePaise - b.dailyRatePaise) * (query.sort === 'priceLowHigh' ? 1 : -1) || String(a._id).localeCompare(String(b._id)));
  const rows = (all ? eligible : eligible.slice((page - 1) * 30, page * 30)).map(row => ({ ...publicOffer(row, statuses.get(String(row._id))), product: productMap.get(String(row.productId)) }));
  return { configuration, rows, total: eligible.length, page, pages: Math.ceil(eligible.length / 30) };
}
async function report(store, query) {
  const from = A.date(query.from), to = A.date(query.to);
  if (+to <= +from || +to - +from > 366 * A.DAY) fail('Use a report period of at most 366 days.', 'VALIDATION_ERROR');
  const summary = { bookings: 0, bookedRentalPaise: 0, collectionsPaise: 0, refundsPaise: 0, settledRentalPaise: 0, assessmentsPaise: 0, depositHeldPaise: 0, outstandingPaise: 0 };
  const rows = [];
  const cursor = M.Booking.find({ storeId: store._id, $or: [{ createdAt: { $gte: from, $lt: to } }, { 'ledger.at': { $gte: from, $lt: to } }] }).lean().cursor();
  for await (const b of cursor) {
    const f = A.finances(b);
    if (+b.createdAt >= +from && +b.createdAt < +to) { summary.bookings += 1; if (!['HELD', 'EXPIRED', 'CANCELLED'].includes(b.status)) summary.bookedRentalPaise += f.rentalPaise; }
    for (const e of b.ledger) if (+e.at >= +from && +e.at < +to && e.status === 'PROCESSED') { if (e.kind === 'COLLECTION') summary.collectionsPaise += e.amountPaise; if (e.kind === 'REFUND') summary.refundsPaise += e.amountPaise; }
    if (['RETURNED', 'CLOSED'].includes(b.status)) { summary.settledRentalPaise += Math.min(f.rentalPaise, f.collectedPaise - f.refundedPaise); summary.assessmentsPaise += f.deductionsPaise; }
    if (rows.length < 1000) rows.push({ number: b.number, status: b.status, pickupAt: b.schedule.pickupAt, returnDueAt: b.schedule.returnDueAt, ...f });
  }
  // Deposit liability is a CURRENT position, not income in the selected period.
  for await (const b of M.Booking.find({ storeId: store._id, 'ledger.0': { $exists: true } }).lean().cursor()) { const f = A.finances(b); summary.depositHeldPaise += f.depositHeldPaise; summary.outstandingPaise += f.balancePaise; }
  const assets = await M.Asset.aggregate([{ $match: { storeId: store._id } }, { $group: { _id: '$status', count: { $sum: 1 }, costPaise: { $sum: '$costPaise' } } }]);
  return { from, to, currency: 'INR', summary, rows, assets, note: 'Booking cohort and cash movement are reported separately. Deposits/outstanding are current positions, not rental revenue. Row preview is limited to 1,000; summary covers all matching records. Tax/accounting treatment must be reviewed for your business.' };
}
async function listBookings(store, query = {}, userId) {
  const page = A.integer(Number(query.page || 1), 'page', 1, 10000);
  const operations = require('./rentalOperationsService');
  const { filter, view } = await operations.bookingFilter(store, query, userId);
  let rows, total;
  const sort = view === 'pickups' ? { 'schedule.pickupAt': 1, _id: 1 } : ['returns', 'overdue'].includes(view) ? { 'schedule.returnDueAt': 1, _id: 1 } : { createdAt: -1, _id: -1 };
  if (['balance', 'refunds'].includes(view)) {
    const [result] = await M.Booking.aggregate([...operations.financialPipeline(filter, view), { $sort: sort }, { $facet: { rows: [{ $skip: (page - 1) * 30 }, { $limit: 30 }, { $unset: ['_collected', '_reserved', '_deductions', '_rent', '_required'] }], count: [{ $count: 'total' }] } }]);
    rows = result.rows; total = result.count[0]?.total || 0;
  } else [rows, total] = await Promise.all([M.Booking.find(filter).sort(sort).skip((page - 1) * 30).limit(30).lean(), M.Booking.countDocuments(filter)]);
  return { rows: rows.map(b => present(b, { staff: !userId })), total, page, pages: Math.ceil(total / 30) };
}
async function workspace(store) {
  const [configuration, listings, assets, bookings, jobs, blocks] = await Promise.all([readConfiguration(store), M.Listing.find({ storeId: store._id }).sort('-createdAt').limit(100).lean(), M.Asset.find({ storeId: store._id }).sort('code').limit(500).lean(), listBookings(store), M.Job.find({ storeId: store._id }).sort('-createdAt').select('-leaseToken').limit(30).lean(), M.Reservation.find({ storeId: store._id, active: true, kind: 'MAINTENANCE' }).limit(100).lean()]);
  const counts = await M.Booking.aggregate([{ $match: { storeId: store._id } }, { $group: { _id: '$status', count: { $sum: 1 } } }]);
  const overdue = await M.Booking.countDocuments({ storeId: store._id, status: 'OUT', 'schedule.returnDueAt': { $lt: new Date() } });
  return { configuration, listings, assets, bookings, jobs, blocks, counts: Object.fromEntries(counts.map(c => [c._id, c.count])), overdue, readiness: { transactions: await supportsTransactions(), onlinePayments: configuration.readiness.onlinePayments, acceptingOrders: configuration.readiness.acceptingOrders, stockMode: 'SEPARATE_RENTAL_ASSETS' } };
}
async function managementRows(store, kind, query = {}) {
  const page = A.integer(Number(query.page || 1), 'page', 1, 10000);
  // Keep the legacy/default-store OR separate from the search OR, otherwise
  // a product search would overwrite the tenant boundary.
  const filter = kind === 'products' ? { $and: [store.isDefault ? defaultStoreFilter(store._id) : { storeId: store._id }], isArchived: { $ne: true } } : { storeId: store._id };
  const model = kind === 'products' ? Product : kind === 'assets' ? M.Asset : M.Listing;
  if (kind === 'products' && query.productId) filter._id = A.id(query.productId);
  if (query.search) { const search = new RegExp(A.text(query.search, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); filter.$or = (kind === 'products' ? ['name', 'sku'] : kind === 'assets' ? ['code', 'label', 'poolKey'] : ['title', 'size', 'colour']).map(key => ({ [key]: search })); }
  const select = kind === 'products' ? '_id name sku commerceMode variants' : '';
  const [rows, total] = await Promise.all([model.find(filter).select(select).sort(kind === 'assets' ? 'code' : kind === 'products' ? 'name' : 'title').skip((page - 1) * 30).limit(30).lean(), model.countDocuments(filter)]);
  return { rows, total, page, pages: Math.ceil(total / 30) };
}
async function paymentMethods(store) {
  const settings = await Settings.findOne(store.isDefault ? defaultStoreFilter(store._id) : { storeId: store._id }).lean();
  return require('./paymentSettingsService').buildPaymentOptions(settings, { razorpayConfigured: gateway.isRazorpayConfigured() }).filter(m => m.provider === 'Razorpay').map(({ key, label, enabled, disabledReason }) => ({ key, label, enabled, disabledReason }));
}
async function providerGet(path) {
  if (!gateway.isRazorpayConfigured()) fail('Payment provider is not configured.', 'SERVICE_UNAVAILABLE');
  const response = await fetch(`https://api.razorpay.com/v1/${path}`, { headers: { Authorization: `Basic ${Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64')}` }, signal: AbortSignal.timeout(10000) });
  if (!response.ok) fail('Payment reconciliation could not be verified. No money/availability was changed.', 'SERVICE_UNAVAILABLE');
  return response.json();
}
async function reconcilePayments(store) {
  const now = new Date();
  const rows = await M.Payment.find({ storeId: store._id, state: { $in: ['PENDING', 'REVIEW', 'CREATING', 'FAILED'] }, setupFailure: { $ne: 'REJECTED' }, updatedAt: { $lt: new Date(Date.now() - 60000) }, $or: [{ nextCheckAt: { $lte: now } }, { nextCheckAt: { $exists: false } }] }).sort({ lastCheckedAt: 1, createdAt: 1 }).limit(20).lean();
  for (const p of rows) await reconcileOnePayment(store, p).catch(() => null);
}
async function reconcileOnePayment(store, payment) {
  try {
    let p = payment;
    if (p.state === 'CAPTURED' || p.setupFailure === 'REJECTED') return;
    if (!p.orderId) {
      const matches = [];
      for (let skip = 0; skip < 500; skip += 100) {
        const orders = await providerGet(`orders?receipt=${encodeURIComponent(p._id)}&count=100&skip=${skip}`);
        matches.push(...(orders.items || []).filter(o => o.receipt === String(p._id) && o.notes?.purpose === 'rental' && o.notes.rentalPaymentId === String(p._id) && o.notes.rentalBookingId === String(p.bookingId) && o.notes.storeId === String(store._id) && o.amount === p.amountPaise && o.currency === 'INR'));
        if ((orders.items || []).length < 100) break;
      }
      if (matches.length !== 1 || !/^[A-Za-z0-9_-]{6,120}$/.test(matches[0].id)) throw new ApiError('SERVICE_UNAVAILABLE', 'Provider lookup could not establish exactly one matching order. Outcome stays under review; no new charge is authorised.');
      await M.Payment.updateOne({ _id: p._id, orderId: { $exists: false }, state: { $ne: 'CAPTURED' } }, { $set: { orderId: matches[0].id, state: 'PENDING', setupFailure: 'NONE' } });
      p = await M.Payment.findOne({ _id: p._id, storeId: store._id }).lean();
    }
    const payments = await providerGet(`orders/${encodeURIComponent(p.orderId)}/payments`);
    for (const entity of payments.items || []) if (entity.status === 'captured') await processCaptured(p, entity);
    await M.Payment.updateOne({ _id: p._id }, { $unset: { lastRecoveryError: 1 } });
  } catch (error) {
    await M.Payment.updateOne({ _id: payment._id, state: { $ne: 'CAPTURED' } }, { $set: { lastRecoveryError: 'Provider outcome could not be safely reconciled. Review the provider account; manual collection and duplicate setup remain blocked.' } });
    throw error;
  } finally {
    await M.Payment.updateOne({ _id: payment._id }, { $set: { lastCheckedAt: new Date(), nextCheckAt: new Date(Date.now() + 5 * 60000) } });
  }
}
async function listPayments(store, bookingId) {
  await getBooking(store, bookingId);
  return M.Payment.find({ storeId: store._id, bookingId }).select('_id state amountPaise orderId paymentId setupFailure lastRecoveryError lastCheckedAt nextCheckAt createdAt').sort('-createdAt').limit(100).lean();
}
async function recoverPayment(store, bookingId, paymentId) {
  await getBooking(store, bookingId);
  const payment = await M.Payment.findOne({ _id: A.id(paymentId), storeId: store._id, bookingId: A.id(bookingId) }).lean();
  if (!payment) fail('Rental payment not found.', 'NOT_FOUND');
  await reconcileOnePayment(store, payment);
  return { booking: present(await getBooking(store, bookingId)), payments: await listPayments(store, bookingId) };
}
async function reconcileRefunds(store) {
  const rows = await M.Booking.find({ storeId: store._id, ledger: { $elemMatch: { kind: 'REFUND', method: 'RAZORPAY', status: { $in: ['PENDING', 'INITIATED', 'REVIEW'] } } } }).limit(20).lean();
  for (const b of rows) for (const row of b.ledger.filter(e => e.kind === 'REFUND' && e.method === 'RAZORPAY' && !['FAILED', 'PROCESSED'].includes(e.status))) {
    const response = row.refundId ? await providerGet(`refunds/${encodeURIComponent(row.refundId)}`) : await providerGet(`payments/${encodeURIComponent(row.paymentId)}/refunds?count=100`);
    const entities = row.refundId ? [response] : (response.items || []).filter(r => r.notes?.rentalOperationId === row.operationId && r.notes?.rentalBookingId === String(b._id));
    for (const entity of entities) if (['processed', 'failed'].includes(entity.status)) await handleWebhook({ event: `refund.${entity.status}`, payload: { refund: { entity } } });
  }
}
async function releaseBlock(store, blockId) { return transaction(store, async session => { const r = await M.Reservation.findOneAndUpdate({ _id: A.id(blockId), storeId: store._id, kind: 'MAINTENANCE' }, { $set: { active: false } }, { new: true, session }); if (!r) fail('Maintenance block not found.', 'NOT_FOUND'); return r; }); }
module.exports = { ensureIndexes, readConfiguration, saveConfiguration, transaction, saveListing, saveAsset, changeAsset, blockAsset, releaseBlock, publicQuote, hold, getBooking, present, recordCollection, mutateBooking, requestChange, resolveRequest, reschedule, replacePiece, cancelItems, createPayment, verifyPayment, refund, handleWebhook, expireHolds, publicListings, catalogue, report, listBookings, workspace, managementRows, paymentMethods, reconcilePayments, reconcileRefunds, listPayments, recoverPayment, enqueue, activeStates };
module.exports.event = event;
