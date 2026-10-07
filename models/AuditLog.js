const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
  storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', index: true },
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  actorSnapshot: { name: String, role: String, kind: String },
  source: { type: String, enum: ['ADMIN', 'SELLER', 'CUSTOMER', 'WEBHOOK', 'SYSTEM'] },
  outcome: { type: String, enum: ['SUCCESS', 'REJECTED', 'FAILED'] },
  visibility: { type: String, enum: ['STORE', 'OWNER'], default: 'STORE' },
  summary: String,
  changedFields: [String],
  http: { method: String, route: String, statusCode: Number },
  action: { type: String, required: true, index: true },
  entityType: { type: String, required: true, index: true },
  entityId: { type: String, index: true },
  before: mongoose.Schema.Types.Mixed,
  after: mongoose.Schema.Types.Mixed,
  requestId: String,
  ip: String,
}, { timestamps: true, bufferCommands: false });

auditLogSchema.index({ storeId: 1, createdAt: -1 });
auditLogSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });
auditLogSchema.index({ createdAt: -1, _id: -1 });
auditLogSchema.index({ actor: 1, createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });
auditLogSchema.index({ storeId: 1, outcome: 1, createdAt: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
