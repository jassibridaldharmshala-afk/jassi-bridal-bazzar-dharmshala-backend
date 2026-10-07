const mongoose = require('mongoose');

const storefrontDesignVersionSchema = new mongoose.Schema({
  storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', required: true, index: true },
  version: { type: Number, required: true, min: 1 },
  config: { type: mongoose.Schema.Types.Mixed, required: true },
  note: { type: String, trim: true, maxlength: 240 },
  publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

storefrontDesignVersionSchema.index({ storeId: 1, version: -1 }, { unique: true });

module.exports = mongoose.model('StorefrontDesignVersion', storefrontDesignVersionSchema);
