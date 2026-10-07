const mongoose = require('mongoose');
const storeIdPlugin = require('./plugins/storeId');

const customerRiskSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  counters: {
    totalOrders: { type: Number, default: 0, min: 0 },
    successfulOrders: { type: Number, default: 0, min: 0 },
    cancelledOrders: { type: Number, default: 0, min: 0 },
    returns: { type: Number, default: 0, min: 0 },
    rejectedReturns: { type: Number, default: 0, min: 0 },
    productMismatchReturns: { type: Number, default: 0, min: 0 },
    codRefusals: { type: Number, default: 0, min: 0 },
  },
  score: { type: Number, default: 0, min: 0, max: 100 },
  status: { type: String, enum: ['LOW', 'MEDIUM', 'HIGH', 'MANUAL_REVIEW'], default: 'LOW' },
  reasons: { type: [String], default: [] },
  manuallyReviewed: { type: Boolean, default: false },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reviewedAt: Date,
  lastCalculatedAt: Date,
}, { timestamps: true });

customerRiskSchema.plugin(storeIdPlugin);
customerRiskSchema.index({ storeId: 1, user: 1 }, { unique: true });
customerRiskSchema.index({ storeId: 1, status: 1, score: -1 });

module.exports = mongoose.model('CustomerRisk', customerRiskSchema);

