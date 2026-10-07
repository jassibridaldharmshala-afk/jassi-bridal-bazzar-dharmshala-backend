const mongoose = require('mongoose');
const storeIdPlugin = require('./plugins/storeId');

const reviewReportSchema = new mongoose.Schema({
  review: { type: mongoose.Schema.Types.ObjectId, ref: 'Review', required: true, index: true },
  reporter: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  reason: { type: String, enum: ['SPAM', 'ABUSE', 'PRIVACY', 'IRRELEVANT', 'OTHER'], required: true },
  details: { type: String, maxlength: 500, default: '' },
  status: { type: String, enum: ['OPEN', 'RESOLVED', 'DISMISSED'], default: 'OPEN', index: true },
  resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  resolutionNote: { type: String, maxlength: 500, default: '' },
  resolvedAt: Date,
}, { timestamps: true });

reviewReportSchema.plugin(storeIdPlugin);
reviewReportSchema.index({ review: 1, reporter: 1 }, { unique: true });
reviewReportSchema.index({ storeId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('ReviewReport', reviewReportSchema);
