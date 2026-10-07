const mongoose = require('mongoose');
const storeIdPlugin = require('./plugins/storeId');

const reportViewSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  filters: { type: mongoose.Schema.Types.Mixed, default: {} },
  sections: { type: [String], default: ['summary', 'products', 'customers', 'marketing', 'fulfillment'] },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  schedule: {
    frequency: { type: String, enum: ['NONE', 'DAILY', 'WEEKLY', 'MONTHLY'], default: 'NONE' },
    recipient: { type: String, trim: true, lowercase: true, maxlength: 160 },
    enabled: { type: Boolean, default: false },
    nextRunAt: Date,
    lastRunAt: Date,
    lastStatus: { type: String, enum: ['NEVER', 'SENT', 'FAILED'], default: 'NEVER' },
    lastError: { type: String, maxlength: 300 },
  },
}, { timestamps: true });

reportViewSchema.plugin(storeIdPlugin);
reportViewSchema.index({ storeId: 1, name: 1 }, { unique: true });
reportViewSchema.index({ 'schedule.enabled': 1, 'schedule.nextRunAt': 1 });

module.exports = mongoose.model('ReportView', reportViewSchema);
