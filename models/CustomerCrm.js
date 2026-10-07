const mongoose = require('mongoose');

const CRM_TAGS = [
  'VIP',
  'Repeat',
  'Repeat Customer',
  'New',
  'New Customer',
  'High RTO',
  'Frequent Return',
  'Instagram',
  'Instagram Customer',
  'Facebook Customer',
  'WhatsApp Customer',
  'Inactive',
  'At Risk',
  'Wholesale',
  'Priority Support',
  'Needs Follow-up',
  'Birthday Upcoming',
  'Anniversary Upcoming',
];

const CONSENT_SOURCES = ['CUSTOMER', 'CHECKOUT', 'MANUAL', 'IMPORT', ''];
const CUSTOMER_LIFECYCLE_STATUSES = ['ACTIVE', 'AT_RISK', 'INACTIVE', 'VIP', 'WHOLESALE'];
const PRIVACY_REQUEST_TYPES = ['DATA_EXPORT', 'DELETION', 'RECTIFICATION'];
const PRIVACY_REQUEST_STATUSES = ['OPEN', 'IN_PROGRESS', 'COMPLETED', 'REJECTED', 'CANCELLED'];

const channelConsentSchema = new mongoose.Schema({
  granted: { type: Boolean, default: false },
  source: { type: String, enum: CONSENT_SOURCES, default: '' },
  recordedAt: Date,
  revokedAt: Date,
  reference: { type: String, trim: true, maxlength: 240 },
  capturedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { _id: false });

const restrictionSchema = new mongoose.Schema({
  checkoutRestricted: { type: Boolean, default: false },
  codRestricted: { type: Boolean, default: false },
  marketingSuppressed: { type: Boolean, default: false },
  supportWatchlist: { type: Boolean, default: false },
  reason: { type: String, trim: true, maxlength: 500 },
  expiresAt: Date,
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedAt: Date,
}, { _id: false });

const privacyRequestSchema = new mongoose.Schema({
  type: { type: String, enum: PRIVACY_REQUEST_TYPES, required: true },
  status: { type: String, enum: PRIVACY_REQUEST_STATUSES, default: 'OPEN' },
  source: { type: String, enum: ['CUSTOMER', 'STAFF'], required: true },
  reason: { type: String, trim: true, maxlength: 500 },
  resolution: { type: String, trim: true, maxlength: 500 },
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  handledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  dueAt: Date,
  completedAt: Date,
}, { timestamps: true });

const customerCrmSchema = new mongoose.Schema({
  storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', required: true, index: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  tags: [{ type: String, enum: CRM_TAGS }],
  notes: { type: String, maxlength: 2000 },
  acquisition: { type: String, maxlength: 80 },
  lifecycleStatus: { type: String, enum: CUSTOMER_LIFECYCLE_STATUSES, default: 'ACTIVE' },
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  followUpAt: Date,
  followUpNote: { type: String, trim: true, maxlength: 500 },
  anniversaryDate: Date,
  marketingConsent: { type: Boolean, default: false },
  marketingConsentSource: { type: String, enum: CONSENT_SOURCES, default: '' },
  marketingConsentAt: Date,
  channelConsents: {
    whatsapp: { type: channelConsentSchema, default: () => ({}) },
    sms: { type: channelConsentSchema, default: () => ({}) },
    email: { type: channelConsentSchema, default: () => ({}) },
  },
  restrictions: { type: restrictionSchema, default: () => ({}) },
  privacyRequests: { type: [privacyRequestSchema], default: [] },
  lastWhatsAppOfferPreparedAt: Date,
  lastWhatsAppRecoveryPreparedAt: Date,
  revision: { type: Number, default: 0, min: 0 },
}, { timestamps: true });

customerCrmSchema.index({ storeId: 1, user: 1 }, { unique: true });
customerCrmSchema.index({ storeId: 1, followUpAt: 1 });
customerCrmSchema.index({ storeId: 1, 'restrictions.checkoutRestricted': 1 });

module.exports = mongoose.model('CustomerCrm', customerCrmSchema);
module.exports.CRM_TAGS = CRM_TAGS;
module.exports.CONSENT_SOURCES = CONSENT_SOURCES;
module.exports.CUSTOMER_LIFECYCLE_STATUSES = CUSTOMER_LIFECYCLE_STATUSES;
module.exports.PRIVACY_REQUEST_TYPES = PRIVACY_REQUEST_TYPES;
module.exports.PRIVACY_REQUEST_STATUSES = PRIVACY_REQUEST_STATUSES;
