const mongoose = require('mongoose');
const { DEFAULT_STRUCTURE } = require('../config/industryPresets');
const schema = new mongoose.Schema({
  _id: { type: String, default: 'store' },
  structure: { type: mongoose.Schema.Types.Mixed, default: () => JSON.parse(JSON.stringify(DEFAULT_STRUCTURE)) },
  locked: { type: Boolean, default: true },
  revision: { type: Number, default: 0 },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  history: { type: [mongoose.Schema.Types.Mixed], default: [] },
}, { timestamps: true });
module.exports = mongoose.model('MasterConfiguration', schema);
