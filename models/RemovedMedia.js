const mongoose = require('mongoose');
// Exact files removed by one successful, authorized image edit/delete.
// This queue never lists a bucket or discovers files to delete by age/prefix.
const schema = new mongoose.Schema({
  _id: String,
  source: { type: String, enum: ['product', 'draft', 'category', 'banner', 'campaign', 'settings', 'design', 'content', 'social', 'review'], required: true },
  sourceId: { type: String, required: true }, storeId: mongoose.Schema.Types.ObjectId,
  assets: { type: [mongoose.Schema.Types.Mixed], required: true },
  status: { type: String, enum: ['PENDING', 'DONE', 'SHARED'], default: 'PENDING' },
  attempts: { type: Number, default: 0 }, nextAttemptAt: { type: Date, default: Date.now },
  leaseUntil: Date, lastError: String,
}, { timestamps: true });
schema.index({ status: 1, nextAttemptAt: 1, leaseUntil: 1 });
module.exports = mongoose.model('RemovedMedia', schema);
