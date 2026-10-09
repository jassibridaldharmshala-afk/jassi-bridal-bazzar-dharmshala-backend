const mongoose = require('mongoose');
const { Schema } = mongoose;
const scoped = { storeId: { type: Schema.Types.ObjectId, ref: 'Store', required: true } };
const define = (name, shape, indexes) => {
  const schema = new Schema({ ...scoped, ...shape }, { timestamps: true });
  for (const [fields, options] of indexes) schema.index(fields, options || {});
  return mongoose.models[name] || mongoose.model(name, schema);
};
const Configuration = define('RentalConfiguration', {
  mode: { type: String, enum: ['SALE_ONLY', 'RENTAL_ONLY', 'SALE_AND_RENTAL'], default: 'SALE_ONLY' },
  policy: Schema.Types.Mixed, revision: { type: Number, default: 0 }, fence: { type: Number, default: 0 }, updatedBy: Schema.Types.ObjectId,
}, [[{ storeId: 1 }, { unique: true }]]);
const Listing = define('RentalListing', {
  productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  title: { type: String, required: true, maxlength: 200 }, active: { type: Boolean, default: true },
  variantId: { type: String, default: '', maxlength: 120 }, size: { type: String, default: '', maxlength: 80 }, colour: { type: String, default: '', maxlength: 80 },
  dailyRatePaise: { type: Number, required: true }, depositPaise: { type: Number, default: 0 },
  advanceMode: { type: String, enum: ['STORE', 'PERCENT', 'FIXED'], default: 'STORE' }, advancePercent: Number, advanceAmountPaise: Number,
  cleaningFeePaise: { type: Number, default: 0 }, alterationFeePaise: { type: Number, default: 0 }, packages: [{ _id: false, days: Number, pricePaise: Number }],
  // Each group is a component inventory pool. One asset from every group per set is required.
  requirements: [{ _id: false, poolKey: String, label: String, quantity: { type: Number, default: 1 }, productId: Schema.Types.ObjectId, variantId: String, size: String, colour: String }],
  matchingVersion: { type: Number, default: 1 },
  // Product-created offers become visible once their real inventory is ready.
  // Studio pauses remain explicit; legacy repair never reopens reviewed offers.
  publicationOrigin: { type: String, enum: ['PRODUCT', 'STUDIO'], default: undefined },
  notes: { type: String, maxlength: 2000 }, revision: { type: Number, default: 0 },
  fitting: { type: Schema.Types.Mixed, default: undefined },
}, [[{ storeId: 1, productId: 1, active: 1 }, {}]]);
const Asset = define('RentalAsset', {
  registrationBatchId: String, registrationFingerprint: String,
  productId: { type: Schema.Types.ObjectId, ref: 'Product' }, variantId: String, size: String, colour: String,
  saleConversion: Schema.Types.Mixed,
  poolKey: { type: String, required: true, maxlength: 80 }, code: { type: String, required: true, maxlength: 80 },
  label: { type: String, required: true, maxlength: 200 }, location: { type: String, default: '', maxlength: 200 },
  condition: { type: String, default: 'Good', maxlength: 1000 }, measurements: { type: String, default: '', maxlength: 1000 }, costPaise: { type: Number, default: 0 },
  fitProfile: { type: Schema.Types.Mixed, default: undefined },
  status: { type: String, enum: ['READY', 'OUT', 'INSPECTION', 'CLEANING', 'REPAIR', 'LOST', 'RETIRED'], default: 'READY' },
  currentBookingId: Schema.Types.ObjectId, returnDueAt: Date, revision: { type: Number, default: 0 },
}, [[{ storeId: 1, code: 1 }, { unique: true }], [{ storeId: 1, poolKey: 1, status: 1 }, {}], [{ storeId: 1, productId: 1, status: 1 }, {}], [{ storeId: 1, registrationBatchId: 1 }, {}]]);
const Reservation = define('RentalReservation', {
  assetId: { type: Schema.Types.ObjectId, ref: 'RentalAsset', required: true }, bookingId: Schema.Types.ObjectId,
  blockedFrom: { type: Date, required: true }, blockedUntil: { type: Date, required: true },
  expiresAt: Date, active: { type: Boolean, default: true }, kind: { type: String, enum: ['BOOKING', 'MAINTENANCE', 'TRIAL', 'TASK'], default: 'BOOKING' }, taskId: Schema.Types.ObjectId, note: String,
}, [[{ storeId: 1, assetId: 1, active: 1, blockedFrom: 1, blockedUntil: 1 }, {}], [{ storeId: 1, bookingId: 1, active: 1 }, {}], [{ storeId: 1, taskId: 1, active: 1 }, {}]]);
const Booking = define('RentalBooking', {
  userId: { type: Schema.Types.ObjectId, ref: 'User' }, number: { type: String, required: true },
  customer: { name: String, phone: String, email: String, whatsappConsent: Boolean },
  bookingDetails: { type: Schema.Types.Mixed, default: undefined },
  bookingDetailsHistory: [Schema.Types.Mixed],
  contactChecks: [{ _id: false, operationId: String, stage: String, name: String, phone: String, assetIds: [Schema.Types.ObjectId], checkedBy: Schema.Types.ObjectId, checkedAt: Date }],
  source: { type: String, enum: ['ONLINE', 'COUNTER'], default: 'ONLINE' },
  attemptId: { type: String, required: true }, fingerprint: { type: String, required: true },
  status: { type: String, enum: ['HELD', 'CONFIRMED', 'PREPARING', 'READY', 'OUT', 'RETURNED', 'CLOSED', 'CANCELLED', 'EXPIRED'], default: 'HELD' },
  expiresAt: Date, schedule: Schema.Types.Mixed, policy: Schema.Types.Mixed, policyRevision: Number,
  confirmedAt: Date,
  acceptedAt: Date, quote: Schema.Types.Mixed, acceptedQuote: Schema.Types.Mixed, adjustedRentalPaise: Number,
  cancellationChargesPaise: { type: Number, default: 0 }, closedFromStatus: String,
  cancelledItems: [Schema.Types.Mixed], replacements: [Schema.Types.Mixed],
  allocations: [{ listingId: Schema.Types.ObjectId, assetId: Schema.Types.ObjectId, code: String, label: String, binding: Schema.Types.Mixed, receivedAt: Date, lostAt: Date, readyAt: Date, disposition: String }],
  logistics: { outbound: Schema.Types.Mixed, inbound: Schema.Types.Mixed, address: String },
  trial: { at: Date, until: Date, notes: String, measurements: String, assetIds: [Schema.Types.ObjectId], status: String, scheduledOperationId: String, attendedAt: Date, completedAt: Date },
  trialHistory: [Schema.Types.Mixed], measurementSnapshot: Schema.Types.Mixed, workshopUsed: { type: Boolean, default: false },
  refundEligibleAt: Date, refundDueAt: Date,
  billingIdentity: Schema.Types.Mixed,
  acknowledgements: [Schema.Types.Mixed], noShowAt: Date, earlyReturnedAt: Date,
  requests: [new Schema({ operationId: String, type: String, status: String, pickupAt: Date, returnDueAt: Date, note: String, createdAt: Date }, { _id: false })],
  assessments: [new Schema({ operationId: String, type: String, amountPaise: Number, reason: String, evidence: [String], approved: Boolean, actorId: Schema.Types.ObjectId, at: Date }, { _id: false })],
  ledger: [{ _id: false, operationId: String, kind: String, amountPaise: Number, method: String, reference: String, paymentId: String, paymentOrderId: String, refundId: String, status: String, reason: String, actorId: Schema.Types.ObjectId, at: Date }],
  events: [new Schema({ operationId: String, inputFingerprint: String, type: String, note: String, actorId: Schema.Types.ObjectId, at: Date }, { _id: false })],
  revision: { type: Number, default: 0 }, cancelledReason: String,
}, [[{ storeId: 1, attemptId: 1 }, { unique: true }], [{ storeId: 1, number: 1 }, { unique: true }], [{ storeId: 1, userId: 1, createdAt: -1 }, {}], [{ storeId: 1, confirmedAt: 1, status: 1 }, {}], [{ storeId: 1, status: 1, 'schedule.returnDueAt': 1 }, {}]]);
const Payment = define('RentalPayment', {
  bookingId: { type: Schema.Types.ObjectId, required: true }, operationId: { type: String, required: true },
  amountPaise: { type: Number, required: true }, orderId: String, paymentId: String, preferredMethod: String,
  state: { type: String, enum: ['CREATING', 'PENDING', 'CAPTURED', 'FAILED', 'REVIEW'], default: 'CREATING' },
  setupFailure: { type: String, enum: ['NONE', 'REJECTED', 'UNKNOWN'], default: 'NONE' },
  lastRecoveryError: { type: String, maxlength: 300 }, lastCheckedAt: Date, nextCheckAt: Date,
}, [[{ storeId: 1, bookingId: 1, operationId: 1 }, { unique: true }], [{ orderId: 1 }, { unique: true, partialFilterExpression: { orderId: { $type: 'string' } } }], [{ paymentId: 1 }, { unique: true, partialFilterExpression: { paymentId: { $type: 'string' } } }]]);
const Job = define('RentalJob', {
  bookingId: Schema.Types.ObjectId, event: String, dedupeKey: { type: String, required: true },
  channel: { type: String, enum: ['IN_APP', 'EMAIL', 'WHATSAPP'], default: 'IN_APP' },
  audience: { type: String, enum: ['OWNER', 'CUSTOMER'], default: 'CUSTOMER' },
  status: { type: String, enum: ['PENDING', 'SENDING', 'ACCEPTED', 'FAILED', 'UNCERTAIN', 'SKIPPED'], default: 'PENDING' },
  attempts: { type: Number, default: 0 }, nextAttemptAt: { type: Date, default: Date.now }, leaseToken: String, leaseUntil: Date, reason: String, providerId: String,
  reminderPickupAt: Date, reminderReturnDueAt: Date, reminderBalanceDueAt: Date, reminderTrialAt: Date,
  taskId: Schema.Types.ObjectId, waitlistId: Schema.Types.ObjectId, waitlistCycle: Number,
}, [[{ dedupeKey: 1 }, { unique: true }], [{ status: 1, nextAttemptAt: 1 }, {}], [{ storeId: 1, createdAt: -1 }, {}]]);
const Proof = define('RentalProof', {
  bookingId: { type: Schema.Types.ObjectId, required: true }, assetId: { type: Schema.Types.ObjectId, required: true },
  stage: { type: String, enum: ['HANDOVER', 'RETURN'], required: true },
  bytes: { type: Buffer, select: false }, mimeType: String, digest: String, uploadedBy: Schema.Types.ObjectId,
  consentRecordedAt: Date, expiresAt: Date,
  withdrawnAt: Date, withdrawnBy: Schema.Types.ObjectId, withdrawnReason: String,
}, [[{ storeId: 1, bookingId: 1, assetId: 1, stage: 1 }, {}], [{ expiresAt: 1 }, { expireAfterSeconds: 0 }]]);
const Courier = define('RentalCourier', {
  bookingId: { type: Schema.Types.ObjectId, required: true }, direction: { type: String, enum: ['outbound', 'inbound'], required: true },
  operationId: String, provider: String, environment: String, providerRef: String, status: String, awb: String,
  providerOrderId: String, providerShipmentId: String, courierName: String,
  pickupAddress: Schema.Types.Mixed, destination: Schema.Types.Mixed, parcel: Schema.Types.Mixed, service: Schema.Types.Mixed,
  slot: Schema.Types.Mixed, pickup: Schema.Types.Mixed, labelPdf: { type: Buffer, select: false },
  operation: String, operationStartedAt: Date, uncertainOperation: String,
  events: [Schema.Types.Mixed], providerStatus: String, expectedDeliveryAt: Date, lastCheckedAt: Date, lastError: String,
}, [[{ storeId: 1, bookingId: 1, direction: 1 }, { unique: true }]]);
const Measurement = define('RentalMeasurement', {
  customerKey: { type: String, required: true }, userId: Schema.Types.ObjectId,
  revision: { type: Number, default: 0 }, versions: [Schema.Types.Mixed],
}, [[{ storeId: 1, customerKey: 1 }, { unique: true }]]);
const Task = define('RentalTask', {
  bookingId: Schema.Types.ObjectId, assetId: { type: Schema.Types.ObjectId, required: true },
  operationId: { type: String, required: true }, fingerprint: String,
  type: { type: String, enum: ['ALTERATION', 'CLEANING', 'REPAIR'], required: true },
  status: { type: String, enum: ['OPEN', 'IN_PROGRESS', 'AWAITING_FITTING', 'COMPLETED', 'CANCELLED'], default: 'OPEN' },
  assignee: String, instructions: String, dueAt: Date, startedAt: Date, completedAt: Date,
  estimatedCostPaise: { type: Number, default: 0 }, actualCostPaise: { type: Number, default: 0 }, costRecordedAt: Date, costEvents: [Schema.Types.Mixed],
  fittingApprovedAt: Date, lastAlertAt: Date, createdBy: Schema.Types.ObjectId, revision: { type: Number, default: 0 }, events: [Schema.Types.Mixed],
}, [[{ storeId: 1, operationId: 1 }, { unique: true }], [{ storeId: 1, status: 1, dueAt: 1 }, {}], [{ storeId: 1, assetId: 1, status: 1 }, {}]]);
const Waitlist = define('RentalWaitlist', {
  userId: { type: Schema.Types.ObjectId, required: true }, operationId: { type: String, required: true }, fingerprint: String,
  items: [{ _id: false, listingId: Schema.Types.ObjectId, quantity: Number }], schedule: Schema.Types.Mixed, deliveryMode: String,
  customer: Schema.Types.Mixed, status: { type: String, enum: ['WAITING', 'NOTIFIED', 'FULFILLED', 'EXPIRED', 'CANCELLED'], default: 'WAITING' },
  notifiedAt: Date, notificationCycle: { type: Number, default: 0 }, nextCheckAt: { type: Date, default: Date.now }, consentAt: Date, revision: { type: Number, default: 0 },
}, [[{ storeId: 1, userId: 1, operationId: 1 }, { unique: true }], [{ storeId: 1, status: 1, nextCheckAt: 1 }, {}], [{ storeId: 1, userId: 1, createdAt: -1 }, {}]]);
module.exports = { Configuration, Listing, Asset, Reservation, Booking, Payment, Job, Proof, Courier, Measurement, Task, Waitlist };
