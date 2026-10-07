const mongoose = require('mongoose');
const storeIdPlugin = require('./plugins/storeId');

const reviewVoteSchema = new mongoose.Schema({
  review: { type: mongoose.Schema.Types.ObjectId, ref: 'Review', required: true, index: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
}, { timestamps: true });

reviewVoteSchema.plugin(storeIdPlugin);
reviewVoteSchema.index({ review: 1, user: 1 }, { unique: true });
reviewVoteSchema.index({ storeId: 1, review: 1 });

module.exports = mongoose.model('ReviewVote', reviewVoteSchema);
